import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { ensureHome, ensureRunDir, persistSpans, veriflowHome } from "@veriflow/store";
import { RunLogger, SpanRecorder } from "@veriflow/telemetry";
import { safeParseAction, type Action, type BrowserEngine, type RunStatus } from "@veriflow/schema";
import { observePage, performAction, verifyAction } from "./act.js";
import type { A11yNode } from "./a11y.js";

export interface RecipeOptions {
  /** Explicit, pre-decided action sequence — no LLM, no perception cost. */
  actions: Action[];
  /** Start URL navigated before the first action (falls back to an `open`/`navigate` action). */
  envUrl?: string;
  headless?: boolean;
  /** Reuse an existing run id (device workers claim a queued cloud run). */
  runId?: string;
  home?: string;
  browser?: BrowserEngine;
  objective?: string;
  /** Resolve `vaultKey` fills locally (worker-side secrets). */
  resolveSecret?: (action: Action) => string | undefined;
  onStart?: (info: { runId: string; objective: string }) => void | Promise<void>;
  onFrame?: (frame: { stepIndex: number; png: Buffer; url: string }) => void | Promise<void>;
}

export interface RecipeResult {
  runId: string;
  status: RunStatus;
  error?: string;
  /** Actions that were skipped (e.g. request_human has no recipe semantics). */
  skipped: number;
  passed: number;
  failed: number;
  startedAt: string;
  browser: BrowserEngine;
}

/**
 * Deterministic recipe execution (spec §1.6, productized): runs an explicit
 * action list against the live site in a real browser — zero LLM calls, zero
 * perception cost, fully reproducible. This is the keyless path: a flow saved
 * as a recipe runs from the dashboard's device cloud without any model key.
 *
 * Emits the same event log as the agent harness (run_start/decide/act/verify/
 * run_end) and persists events + spans + screenshots under the run dir, so
 * `CloudClient.syncRun` uploads it exactly like an agent run.
 */
export async function runRecipe(opts: RecipeOptions): Promise<RecipeResult> {
  const home = opts.home ?? veriflowHome();
  ensureHome(home);
  const runId = opts.runId ?? `run_${randomUUID()}`;
  const objective = opts.objective ?? "recipe replay";
  const rp = ensureRunDir(runId, home);
  try {
    await opts.onStart?.({ runId, objective });
  } catch {
    /* live-view plumbing must never break the run */
  }
  const logger = new RunLogger(runId, undefined, true, home);
  const spans = new SpanRecorder();
  const engine: BrowserEngine = opts.browser ?? "chromium";
  const launchers: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit };
  const startedAt = new Date().toISOString();
  let status: RunStatus = "running";
  let error: string | undefined;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let browser: Browser | undefined;

  logger.emit("run_start", { objective, envUrl: opts.envUrl, mode: "recipe" });

  try {
    browser = await launchers[engine].launch({ headless: opts.headless !== false });
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    if (opts.envUrl) {
      await page.goto(opts.envUrl, { waitUntil: "domcontentloaded" });
    }
    let nodes: A11yNode[] = [];

    for (let i = 0; i < opts.actions.length; i++) {
      const raw = opts.actions[i];
      const parsed = safeParseAction(raw);
      const action: Action | undefined = parsed.success ? parsed.data : (raw as Action);
      if (!action || typeof action !== "object" || !("type" in action)) {
        failed += 1;
        logger.emit("decide", { action: raw, error: "unparseable recipe action" }, i);
        logger.emit("act", { ok: false, detail: "unparseable recipe action" }, i);
        status = "failed";
        error = `recipe step ${i} is not a valid action`;
        break;
      }
      if (action.type === "request_human") {
        // No human is attached to a deterministic replay — record and skip.
        skipped += 1;
        logger.emit("decide", { action }, i);
        logger.emit("human", { ok: false, detail: "request_human skipped in recipe mode" }, i);
        continue;
      }
      logger.emit("decide", { action }, i);
      const span = spans.start({ runId, kind: action.type === "assert" ? "VERIFY" : "ACT", attributes: { stepIndex: i, actionType: action.type } });
      try {
        const observed = await observePage(page);
        nodes = observed.a11y.nodes;
        mkdirSync(rp.screenshots, { recursive: true });
        const shotPath = join(rp.screenshots, `step-${i}.png`);
        writeFileSync(shotPath, observed.screenshotPng);
        try {
          await opts.onFrame?.({ stepIndex: i, png: observed.screenshotPng, url: observed.url });
        } catch {
          /* frame push must never break the run */
        }
        if (action.type === "assert") {
          const v = await verifyAction(page, action);
          span.end(v.ok, v.ok ? undefined : v.detail);
          logger.emit("verify", { ok: v.ok, detail: v.detail }, i);
          if (v.ok) {
            passed += 1;
          } else {
            failed += 1;
            status = "failed";
            error = `step ${i} assert failed: ${v.detail}`;
          }
        } else if (action.type === "finish") {
          span.end(Boolean(action.success), action.reason);
          status = action.success ? "passed" : "failed";
          if (!action.success) error = action.reason ?? "recipe finished unsuccessfully";
          break;
        } else {
          const r = await performAction(page, action, nodes, (a) => opts.resolveSecret?.(a) ?? (a.type === "fill" ? a.value : undefined));
          span.end(r.ok, r.ok ? undefined : r.detail);
          logger.emit("act", { ok: r.ok, detail: r.detail }, i);
          if (r.ok) {
            passed += 1;
          } else {
            failed += 1;
            status = "failed";
            error = `step ${i} ${action.type} failed: ${r.detail}`;
          }
        }
        if (status === "failed") break;
      } catch (err) {
        failed += 1;
        const detail = err instanceof Error ? err.message : String(err);
        span.end(false, detail);
        logger.emit("act", { ok: false, detail }, i);
        status = "failed";
        error = `step ${i} threw: ${detail}`;
        break;
      }
    }
    if (status === "running") status = "passed";
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await browser?.close();
  }

  logger.emit("run_end", { status, error, steps: passed + failed, passed, failed, skipped, mode: "recipe" });
  persistSpans(runId, spans.spans, home);
  return { runId, status, error, skipped, passed, failed, startedAt, browser: engine };
}
