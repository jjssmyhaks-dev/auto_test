import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { writeEvidencePack } from "@veriflow/evidence";
import { createProvider, type LlmProvider } from "@veriflow/llm";
import { safeParseAction, type Action, type RunStatus, type VeriflowConfig } from "@veriflow/schema";
import { ensureHome, ensureRunDir, loadConfig, persistCapture, persistSpans, readEvents, saveFlow, veriflowHome } from "@veriflow/store";
import { RunLogger, SpanRecorder, createAgentSink, writeOtlpFile } from "@veriflow/telemetry";
import { Vault, redactDeep, redactSecrets } from "@veriflow/vault";
import { observePage, performAction, verifyAction } from "./act.js";
import type { A11yNode } from "./a11y.js";
import { evaluateGuards } from "./guards.js";
import { attachDevtoolsCapture, emptyCapture, type DevtoolsCapture } from "./devtools.js";

export interface RunOptions {
  objective: string;
  envUrl?: string;
  headless?: boolean;
  profile?: string;
  record?: boolean;
  agent?: boolean;
  yesIMeanIt?: boolean;
  dryRun?: boolean;
  home?: string;
  provider?: LlmProvider;
  pause?: (prompt: string) => Promise<string>;
  captureDevtools?: boolean;
  otlp?: boolean;
  sync?: boolean;
  /** Optional live progress hook (interactive TUI-lite). Not called in agent mode. */
  progress?: (line: string) => void;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  error?: string;
  evidencePath?: string;
  reportPath?: string;
}

export type { ConversationHarness } from "./agent-test.js";

export async function defaultStdinPause(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(`${prompt}\n> `);
  } finally {
    rl.close();
  }
}

function historyText(actions: Action[], secrets: string[]): string {
  return actions
    .map((a, i) => `${i + 1}. ${JSON.stringify(redactDeep(a, secrets))}`)
    .join("\n");
}

function resolveFill(vault: Vault, action: Action): string | undefined {
  if (action.type !== "fill") return undefined;
  if (action.vaultKey) {
    const v = vault.get(action.vaultKey);
    if (!v) throw new Error(`vault key not found: ${action.vaultKey}`);
    return v;
  }
  return action.value;
}

export async function runHarness(opts: RunOptions): Promise<RunResult> {
  const home = opts.home ?? veriflowHome();
  ensureHome(home);
  const config: VeriflowConfig = loadConfig(home);
  const profileEnv = opts.profile ? config.profiles?.[opts.profile]?.envUrl : undefined;
  const envUrl = opts.envUrl ?? profileEnv ?? config.defaultEnvUrl;
  const captureOn = Boolean(opts.captureDevtools ?? config.captureDevtools);
  const otlpOn = Boolean(opts.otlp ?? config.otlpExport);
  const runId = `run_${randomUUID()}`;
  const rp = ensureRunDir(runId, home);
  const vault = new Vault(home);
  const secrets = vault.secretValues();
  const logger = new RunLogger(runId, createAgentSink(Boolean(opts.agent)), true, home);
  const spans = new SpanRecorder();
  const llm = opts.provider ?? createProvider(config);
  const started = Date.now();
  let tokens = 0;
  let costUsd = 0;
  let status: RunStatus = "running";
  let error: string | undefined;
  const recent: Action[] = [];
  let nodes: A11yNode[] = [];
  let stepIndex = 0;
  let capture: DevtoolsCapture = emptyCapture();
  const progress = (line: string) => {
    if (!opts.agent) opts.progress?.(line);
  };

  logger.emit("run_start", {
    objective: opts.objective,
    envUrl,
    headless: Boolean(opts.headless),
    profile: opts.profile,
    record: opts.record !== false,
  });
  progress(`▸ objective: ${opts.objective}`);

  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await chromium.launch({ headless: Boolean(opts.headless) });
    const context = await browser.newContext();
    page = await context.newPage();
    if (captureOn) {
      capture = await attachDevtoolsCapture(page);
    }
    const startUrl = envUrl;
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    }

    loop: while (true) {
      const elapsedMs = Date.now() - started;
      if (stepIndex >= config.stepCap) {
        status = "aborted";
        error = `Step cap reached (${config.stepCap})`;
        break;
      }
      if (elapsedMs >= config.wallClockMs) {
        status = "aborted";
        error = "Wall-clock timeout";
        break;
      }

      const observeSpan = spans.start({ runId, kind: "OBSERVE" });
      const observed = await observePage(page);
      nodes = observed.a11y.nodes;
      const shotPath = join(rp.screenshots, `step-${stepIndex}.png`);
      writeFileSync(shotPath, observed.screenshotPng);
      // URLs can carry filled values (GET forms) — redact vault secrets there too.
      const safeUrl = redactSecrets(observed.url, secrets);
      logger.emit(
        "observe",
        {
          url: safeUrl,
          a11y: redactSecrets(observed.a11y.tree, secrets),
          screenshot: `screenshots/step-${stepIndex}.png`,
        },
        stepIndex,
        observeSpan.span.id,
      );
      observeSpan.end(true);
      progress(`▸ step ${stepIndex} observe ${safeUrl}`);

      const decideSpan = spans.start({ runId, kind: "DECIDE" });
      const decideInput = {
        objective: opts.objective,
        url: observed.url,
        a11yTree: redactSecrets(observed.a11y.tree, secrets),
        screenshotPng: observed.screenshotPng,
        redactedHistory: historyText(recent, secrets),
        model: config.model,
      };
      let decision = await llm.decide(decideInput);
      tokens += decision.usage.input + decision.usage.output;
      costUsd += decision.usage.costUsd;
      let parsed = safeParseAction(decision.raw);
      if (!parsed.success) {
        logger.emit("decide", { malformed: true, issues: parsed.error.flatten() }, stepIndex, decideSpan.span.id);
        decision = await llm.decide({
          ...decideInput,
          objective: `${opts.objective}\nYour previous action was invalid JSON/schema. Return a valid browser_action.`,
        });
        tokens += decision.usage.input + decision.usage.output;
        costUsd += decision.usage.costUsd;
        parsed = safeParseAction(decision.raw);
        if (!parsed.success) {
          decideSpan.end(false, "malformed_action");
          status = "failed";
          error = "Malformed action after retry";
          break;
        }
      }
      const action = parsed.data;
      decideSpan.end(true, undefined, { actionType: action.type });
      logger.emit("decide", { action: redactDeep(action, secrets) }, stepIndex, decideSpan.span.id);
      progress(`▸ step ${stepIndex} decide ${action.type}`);

      const guardSpan = spans.start({ runId, kind: "GUARD" });
      const verdict = evaluateGuards({
        action,
        stepCount: stepIndex,
        stepCap: config.stepCap,
        recentActions: recent,
        loopAbortCount: config.loopAbortCount,
        elapsedMs,
        wallClockMs: config.wallClockMs,
        tokensUsed: tokens,
        tokenCap: config.tokenCap,
        costUsd,
        costCapUsd: config.costCapUsd,
        allowDestructive: Boolean(opts.yesIMeanIt),
        dryRun: Boolean(opts.dryRun),
      });
      logger.emit("guard", verdict, stepIndex, guardSpan.span.id);
      if (!verdict.ok) {
        guardSpan.end(false, verdict.code);
        status = "aborted";
        error = verdict.message;
        progress(`■ guard ${verdict.code}: ${verdict.message}`);
        break;
      }
      guardSpan.end(true);

      if (action.type === "request_human") {
        const humanSpan = spans.start({ runId, kind: "HUMAN" });
        logger.emit("human", { reason: action.reason, prompt: action.prompt }, stepIndex);
        const pause = opts.pause ?? (opts.agent ? async () => "continue" : defaultStdinPause);
        await pause(action.prompt ?? action.reason);
        humanSpan.end(true);
        recent.push(action);
        stepIndex += 1;
        continue;
      }

      if (action.type === "finish") {
        const verifySpan = spans.start({ runId, kind: "VERIFY" });
        status = action.success ? "passed" : "failed";
        error = action.success ? undefined : action.reason;
        logger.emit("verify", { finish: true, success: action.success, reason: action.reason }, stepIndex);
        verifySpan.end(action.success, action.success ? undefined : action.reason);
        break;
      }

      let actOk = true;
      let actDetail = "";
      if (!opts.dryRun) {
        let attempts = 0;
        while (attempts <= 2) {
          const kind = attempts === 0 ? "ACT" : "RETRY";
          const actSpan = spans.start({ runId, kind });
          try {
            const result = await performAction(page, action, nodes, (a) => resolveFill(vault, a));
            actOk = result.ok;
            actDetail = result.detail;
            actSpan.end(true, undefined, { detail: actDetail, attempt: attempts });
            logger.emit(attempts === 0 ? "act" : "retry", { ok: true, detail: actDetail, attempt: attempts }, stepIndex);
            break;
          } catch (err) {
            actOk = false;
            actDetail = err instanceof Error ? err.message : String(err);
            actSpan.end(false, actDetail, { attempt: attempts });
            logger.emit(attempts === 0 ? "act" : "retry", { ok: false, detail: actDetail, attempt: attempts }, stepIndex);
            attempts += 1;
            if (attempts > 2) break;
            const reobs = spans.start({ runId, kind: "OBSERVE" });
            const again = await observePage(page);
            nodes = again.a11y.nodes;
            reobs.end(true);
          }
        }
      } else {
        logger.emit("act", { ok: true, dryRun: true, action: redactDeep(action, secrets) }, stepIndex);
      }

      const verifySpan = spans.start({ runId, kind: "VERIFY" });
      if (action.type === "assert") {
        const v = opts.dryRun ? { ok: true, detail: "dry-run" } : await verifyAction(page, action, capture);
        logger.emit("verify", v, stepIndex);
        verifySpan.end(v.ok, v.ok ? undefined : v.detail);
        if (!v.ok) {
          status = "failed";
          error = `assert failed: ${v.detail}`;
          break loop;
        }
      } else {
        verifySpan.end(actOk, actOk ? undefined : actDetail);
        if (!actOk) {
          status = "failed";
          error = actDetail;
          break loop;
        }
      }

      recent.push(action);
      stepIndex += 1;
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
    logger.emit("log", { error });
  } finally {
    await browser?.close();
  }

  logger.emit("run_end", { status, error, steps: stepIndex, costUsd, tokens });
  progress(`■ run ${status}${error ? ` — ${error}` : ""} (${stepIndex} steps, $${costUsd.toFixed(4)})`);
  persistSpans(runId, spans.spans, home);
  if (captureOn) persistCapture(runId, capture, home);
  if (otlpOn) {
    writeOtlpFile(rp.otlp, spans.spans, { "veriflow.run_id": runId });
  }
  saveFlow(
    {
      id: `flow_${runId}`,
      name: opts.objective.slice(0, 80),
      objective: opts.objective,
      envUrl,
    },
    home,
  );
  const events = readEvents(runId, home);
  const pack = await writeEvidencePack({
    runId,
    objective: opts.objective,
    status,
    events,
    envUrl,
    home,
  });

  return {
    runId,
    status,
    error,
    evidencePath: pack.zipPath,
    reportPath: pack.reportPath,
  };
}
