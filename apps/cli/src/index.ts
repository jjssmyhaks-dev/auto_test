#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import {
  actionsFromEvents,
  CloudClient,
  computeReliabilityMetrics,
  exportPlaywrightTest,
  importPlaywrightTest,
  replayLive,
  runAgentTest,
  runHarness,
  runRedTeam,
  runReliability,
  runSuite,
  syncRunIfConfigured,
} from "@veriflow/harness";
import type { SuiteResult } from "@veriflow/harness";
import {
  computeLocalFlowMetrics,
  loadConfig,
  listFlows,
  listRunIds,
  readEvents,
  readSpans,
  runPaths,
  saveConfig,
  saveFlow,
  veriflowHome,
} from "@veriflow/store";
import { Vault, saveCredentials } from "@veriflow/vault";
import { spansToOtlp } from "@veriflow/telemetry";
import type { BrowserEngine, RouteMock } from "@veriflow/schema";

const program = new Command()
  .name("veriflow")
  .description("Veriflow — local-first vision browser testing")
  .version("0.2.0");

function suiteSummary(suite: SuiteResult) {
  return {
    total: suite.total,
    passed: suite.passed,
    failed: suite.failed,
    durationMs: suite.durationMs,
    concurrency: suite.concurrency,
    results: suite.results.map((r: SuiteResult["results"][number]) => ({
      name: r.name,
      flowId: r.flowId,
      status: r.result?.status ?? "error",
      runId: r.result?.runId,
      error: r.error,
      durationMs: r.durationMs,
    })),
  };
}

program
  .command("run")
  .description("Run an objective against a live browser via the Veriflow harness")
  .argument("<objective>", "Natural-language test objective")
  .option("--headless", "Run Chromium headless (CI)", false)
  .option("--env <url>", "Starting environment URL")
  .option("--profile <name>", "Named local profile")
  .option("--record", "Write events + evidence pack", true)
  .option("--agent", "Emit NDJSON events to stdout", false)
  .option("--yes-i-mean-it", "Allow destructive actions", false)
  .option("--dry-run", "Guard + decide but skip Playwright ACT", false)
  .option("--devtools", "Capture CDP network/console/performance", false)
  .option("--otlp", "Write OTel-shaped JSON (otlp.json) for the run", false)
  .option("--video", "Record a WebM video of the run (saved in the run dir; synced with --sync)", false)
  .option("--browser <engine>", "Browser engine: chromium (default), firefox, or webkit", "chromium")
  .option("--routes <file>", "JSON file of network route mocks to apply ([{pattern,status,body,abort}])")
  .option("--sync", "Push evidence to the cloud API after the run", false)
  .option("--live", "Stream live frames to the dashboard while the run executes (auto-on when logged in)", undefined)
  .option("--pause-endpoint", "Resolve request_human pauses via a cloud magic link (CI) instead of stdin", false)
  .action(async (objective: string, opts: Record<string, unknown>) => {
    try {
      // Spec 1.4: headless/CI runs pause via a cloud magic link; a human resolves
      // it from the dashboard/CLI and the run resumes on the next poll.
      const pauseEndpoint = Boolean(opts.pauseEndpoint);
      const cloudForPause = pauseEndpoint ? CloudClient.fromEnvOrStore() : undefined;
      if (pauseEndpoint && !cloudForPause) {
        throw new Error("--pause-endpoint requires credentials: run `veriflow login` or set VERIFLOW_API_KEY");
      }
      const browserOpt = String(opts.browser ?? "chromium");
      if (!("chromium firefox webkit".split(" ")).includes(browserOpt)) {
        throw new Error(`unknown browser "${browserOpt}" — use chromium, firefox, or webkit`);
      }
      let routes: RouteMock[] | undefined;
      if (opts.routes) {
        routes = JSON.parse(readFileSync(String(opts.routes), "utf8")) as RouteMock[];
      }
      // Live frames: with credentials, every foreground run streams its
      // screenshots to the dashboard (auto-on; --no-live or --live=false to
      // disable). The runId is reserved first so the run page exists before
      // the browser launches, and frames flow while the agent works.
      const liveExplicit = opts.live === true || opts.live === "true";
      const liveOff = opts.live === false || opts.live === "false";
      const cloud = CloudClient.fromEnvOrStore();
      const liveOn = !liveOff && (liveExplicit || Boolean(cloud));
      let live: CloudClient | undefined;
      if (liveOn) {
        if (!cloud) {
          if (liveExplicit) throw new Error("--live requires credentials: run `veriflow login` or set VERIFLOW_API_KEY");
        } else {
          live = cloud;
        }
      }
      let liveRunId: string | undefined;
      let liveLive: CloudClient | undefined;
      const liveHooks = live
        ? {
            // Reserve the run in the cloud before the browser launches so the
            // run page (and its Live pane) exists from the first frame.
            onStart: async ({ runId, objective: obj }: { runId: string; objective: string }) => {
              try {
                await live!.request("POST", "/v1/runs", {
                  id: runId,
                  projectId: undefined,
                  objective: obj,
                  status: "running",
                  stepCount: 0,
                });
                liveRunId = runId;
                liveLive = live;
              } catch (err) {
                console.error(`(live view unavailable: ${err instanceof Error ? err.message : err})`);
                live = undefined;
              }
            },
            // Best-effort frame push: a slow or down API must never stall the run.
            onFrame: ({ stepIndex, png, url }: { stepIndex: number; png: Buffer; url: string }) => {
              const client = liveLive;
              const id = liveRunId;
              if (!client || !id) return;
              void client
                .request("POST", `/v1/runs/${id}/frames`, {
                  stepIndex,
                  url,
                  pngBase64: png.toString("base64"),
                })
                .catch(() => undefined);
            },
          }
        : {};
      const result = await runHarness({
        objective,
        envUrl: opts.env as string | undefined,
        headless: Boolean(opts.headless),
        profile: opts.profile as string | undefined,
        agent: Boolean(opts.agent),
        yesIMeanIt: Boolean(opts.yesIMeanIt),
        dryRun: Boolean(opts.dryRun),
        captureDevtools: Boolean(opts.devtools),
        otlp: Boolean(opts.otlp),
        record: opts.record !== false,
        video: opts.video === true,
        browser: browserOpt as BrowserEngine,
        routes,
        progress: (line) => console.error(line),
        ...liveHooks,
        ...(cloudForPause
          ? {
              pause: async (prompt: string, ctx: { runId: string }) => {
                const { pause, magicLink } = await cloudForPause.createHumanPause(
                  ctx.runId,
                  prompt,
                  prompt,
                );
                console.error(`⏸ paused — resolve to continue: ${magicLink}`);
                const out = await cloudForPause.awaitHumanPause(pause.id, {
                  onPoll: (n) => console.error(`… waiting for human (${n})`),
                });
                if (out.timedOut) throw new Error("human pause expired before it was resolved");
                return out.response ?? "confirmed via magic link";
              },
            }
          : {}),
      });
      if (!opts.agent) {
        console.log(`run ${result.runId} ${result.status}`);
        if (result.error) console.log(result.error);
        if (result.evidencePath) console.log(`evidence ${result.evidencePath}`);
        if (result.reportPath) console.log(`report ${result.reportPath}`);
      }
      if (opts.sync) {
        const sync = await syncRunIfConfigured(result.runId);
        console.log(`sync ${sync.synced ? "ok" : "skipped"} ${sync.detail}`);
      }
      process.exitCode = result.status === "passed" ? 0 : 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("replay")
  .description("Playback a run from the local event log (no browser, no LLM); --live re-executes against the site")
  .argument("<runId>", "Run id under ~/.veriflow/runs")
  .option("--live", "Deterministically re-execute the recorded actions in a real browser (no LLM)", false)
  .option("--headless", "Use a headless browser for --live (default true; pass --no-headless to watch)", true)
  .action(async (runId: string, opts: { live?: boolean; headless?: boolean }) => {
    try {
      const events = readEvents(runId);
      const rp = runPaths(runId);
      if (!opts.live) {
        console.log(`# Veriflow replay ${runId}`);
        console.log(`# events ${rp.events}`);
        for (const event of events) {
          console.log(
            `${event.ts} ${event.type} step=${event.stepIndex ?? "-"} ${JSON.stringify(event.payload)}`,
          );
        }
        return;
      }
      const vault = new Vault();
      const secrets = vault.secretValues();
      const result = await replayLive({
        runId,
        events,
        headless: opts.headless !== false,
        resolveSecret: (action) => {
          if (action.type !== "fill") return undefined;
          if (action.vaultKey) return vault.get(action.vaultKey);
          return action.secret ? undefined : action.value;
        },
      });
      for (const step of result.steps) {
        const flag = step.skipped ? "skip" : step.ok ? "ok" : "FAIL";
        console.log(`${flag.padEnd(4)} step ${step.index} ${step.action.type} — ${step.detail}`);
      }
      const passed = result.failed === 0 && result.executed > 0;
      console.log(
        `live replay ${runId}: ${passed ? "PASS" : "FAIL"} (executed ${result.executed}, ok ${result.passed}, failed ${result.failed}, skipped ${result.skipped})`,
      );
      process.exitCode = passed ? 0 : 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("login")
  .description("Authenticate against the Veriflow API and encrypt credentials locally")
  .option("--api-url <url>", "API base URL", process.env.VERIFLOW_API_URL ?? "http://127.0.0.1:8787")
  .option("--email <email>")
  .option("--password <password>")
  .option("--signup", "Create an account if login fails", false)
  .action(async (opts: { apiUrl: string; email?: string; password?: string; signup?: boolean }) => {
    try {
      const email = opts.email ?? process.env.VERIFLOW_EMAIL;
      const password = opts.password ?? process.env.VERIFLOW_PASSWORD;
      if (!email || !password) {
        console.error("Provide --email and --password (or VERIFLOW_EMAIL / VERIFLOW_PASSWORD).");
        process.exitCode = 1;
        return;
      }
      const client = new CloudClient({ apiUrl: opts.apiUrl, token: "" });
      let res;
      try {
        res = await client.login(email, password);
      } catch (err) {
        if (!opts.signup) throw err;
        res = await client.signup(email, password);
      }
      const authed = new CloudClient({ apiUrl: opts.apiUrl, token: res.token, email });
      const me = await authed.request<{
        user: { id: string };
        projects: { id: string }[];
      }>("GET", "/v1/me");
      const projectId = me.projects[0]?.id;
      let apiKey: string | undefined;
      if (projectId) {
        const key = await authed.request<{ key: string }>("POST", `/v1/projects/${projectId}/keys`, {
          name: "cli",
        });
        apiKey = key.key;
      }
      saveCredentials({ apiUrl: opts.apiUrl, email, token: res.token, projectId, apiKey });
      console.log(`logged in as ${email} (${opts.apiUrl})`);
      if (apiKey) console.log("project key stored (encrypted)");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("profiles")
  .description("List or set named local env profiles")
  .argument("[action]", "list | set")
  .option("--name <name>")
  .option("--env <url>")
  .action((action: string | undefined, opts: { name?: string; env?: string }) => {
    const cfg = loadConfig();
    if (!action || action === "list") {
      console.log(JSON.stringify(cfg.profiles ?? {}, null, 2));
      return;
    }
    if (action === "set") {
      if (!opts.name) {
        console.error("--name required");
        process.exitCode = 1;
        return;
      }
      cfg.profiles = { ...cfg.profiles, [opts.name]: { envUrl: opts.env } };
      saveConfig(cfg);
      console.log(`profile ${opts.name} saved`);
      return;
    }
    console.error("profiles [list|set]");
    process.exitCode = 1;
  });

program
  .command("export")
  .description("Export a saved flow/run action sequence")
  .option("--out <path>", "Write the Playwright source to a file instead of stdout")
  .option("--format <fmt>", "playwright", "playwright")
  .argument("[runId]")
  .action((runId: string | undefined, opts: { format?: string; out?: string }) => {
    try {
      if (opts.format !== "playwright") {
        console.error("only --format playwright is supported");
        process.exitCode = 1;
        return;
      }
      if (!runId) {
        console.error("run id required");
        process.exitCode = 1;
        return;
      }
      const events = readEvents(runId);
      const start = events.find((e) => e.type === "run_start");
      const src = exportPlaywrightTest({
        name: runId,
        objective: String(start?.payload.objective ?? runId),
        envUrl: start?.payload.envUrl as string | undefined,
        actions: actionsFromEvents(events),
      });
      if (opts.out) {
        writeFileSync(opts.out, src, "utf8");
        console.log(`wrote ${opts.out}`);
      } else {
        console.log(src);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("import")
  .description("Import a simple Playwright test into a Veriflow flow (best-effort)")
  .option("--from <kind>", "playwright")
  .argument("<path>")
  .action((path: string, opts: { from?: string }) => {
    try {
      if (opts.from && opts.from !== "playwright") {
        console.error("only --from playwright is supported");
        process.exitCode = 1;
        return;
      }
      const source = readFileSync(path, "utf8");
      const flow = importPlaywrightTest(source);
      const id = `flow_${Date.now()}`;
      saveFlow({ id, name: flow.name, objective: flow.objective, envUrl: flow.envUrl });
      const out = runPaths(id);
      mkdirSync(dirname(out.dir), { recursive: true });
      console.log(JSON.stringify({ id, ...flow }, null, 2));
      console.log(`saved flow ${id}`);
      console.log("Limits: no custom fixtures/helpers; only page.goto/click/fill/expect toContainText/toHaveURL.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("redteam")
  .description("Prompt-injection / jailbreak / PII-leak red-team eval for chat endpoints")
  .requiredOption("--endpoint <url>", "Chat HTTP endpoint (POST { messages })")
  .option("--category <name>", "Limit to one category (injection|jailbreak|pii|phishing)")
  .action(async (opts: { endpoint: string; category?: string }) => {
    try {
      const report = await runRedTeam({ endpoint: opts.endpoint, category: opts.category as never });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.verdict === "red" ? 1 : 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("agent-test")
  .description("Chat-only agent evaluation (OBSERVE/DECIDE/GUARD/ACT/VERIFY)")
  .requiredOption("--endpoint <url>", "Chat HTTP endpoint (POST { messages })")
  .option("--scenarios <n>", "How many bundled scenarios to run", "5")
  .option("--mode <mode>", "text (default) or voice (telephony-style latency gates)", "text")
  .action(async (opts: { endpoint: string; scenarios?: string; mode?: string }) => {
    try {
      const report = await runAgentTest({
        endpoint: opts.endpoint,
        scenarios: Number(opts.scenarios ?? 5),
        mode: opts.mode === "voice" ? "voice" : "text",
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.verdict === "red" ? 1 : 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("secrets")
  .description("Manage the local encrypted secrets vault (AES-256-GCM)")
  .argument("[action]", "list | set | delete")
  .option("--key <name>", "Secret key name (e.g. staging_password)")
  .option("--value <value>", "Secret value (prefer env: VERIFLOW_SECRET_VALUE)")
  .action((action: string | undefined, opts: { key?: string; value?: string }) => {
    const vault = new Vault();
    if (!action || action === "list") {
      const keys = vault.keys();
      if (!keys.length) {
        console.log("(empty vault)");
        return;
      }
      for (const k of keys) console.log(k);
      return;
    }
    if (action === "set") {
      if (!opts.key) {
        console.error("--key required");
        process.exitCode = 1;
        return;
      }
      const value = opts.value ?? process.env.VERIFLOW_SECRET_VALUE;
      if (!value) {
        console.error("--value or VERIFLOW_SECRET_VALUE required");
        process.exitCode = 1;
        return;
      }
      vault.set(opts.key, value);
      console.log(`secret ${opts.key} stored (encrypted)`);
      return;
    }
    if (action === "delete") {
      if (!opts.key) {
        console.error("--key required");
        process.exitCode = 1;
        return;
      }
      vault.delete(opts.key);
      console.log(`secret ${opts.key} deleted`);
      return;
    }
    console.error("secrets [list|set|delete]");
    process.exitCode = 1;
  });

program
  .command("trace")
  .description("Print step timeline + spans for a local (or synced) run")
  .argument("<runId>")
  .action(async (runId: string) => {
    try {
      const events = readEvents(runId);
      const spans = readSpans(runId);
      console.log(JSON.stringify({ runId, events, spans, otlp: spansToOtlp(spans) }, null, 2));
      const client = CloudClient.fromEnvOrStore();
      if (client) {
        try {
          const remote = await client.getTrace(runId);
          console.log("# cloud trace");
          console.log(JSON.stringify(remote, null, 2));
        } catch {
          /* local-only is fine */
        }
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("metrics")
  .description("Pass-rate / cost metrics for a flow id")
  .argument("<flowId>")
  .action(async (flowId: string) => {
    const flows = listFlows().filter((f) => f.id === flowId || f.name === flowId);
    const local = computeLocalFlowMetrics(flowId);
    const reliability = computeReliabilityMetrics(
      listRunIds()
        .map((id) => {
          try {
            return runReliability(id, readEvents(id));
          } catch {
            return undefined;
          }
        })
        .filter((r): r is NonNullable<typeof r> => Boolean(r)),
    );
    const client = CloudClient.fromEnvOrStore();
    if (client) {
      try {
        const cloud = await client.metrics(flowId);
        console.log(JSON.stringify({ cloud, local, reliability, matchedFlows: flows }, null, 2));
        return;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
    }
    console.log(JSON.stringify({ local, reliability }, null, 2));
  });

program
  .command("flows")
  .description("List saved flows (local, plus cloud when credentials exist)")
  .action(async () => {
    const local = listFlows();
    const client = CloudClient.fromEnvOrStore();
    let cloud: unknown;
    if (client) {
      try {
        cloud = (await client.listFlows()).flows;
      } catch {
        cloud = undefined;
      }
    }
    console.log(JSON.stringify({ local, cloud }, null, 2));
  });

const scheduleCmd = program
  .command("schedules")
  .description("Cron-scheduled flow runs (poll the due-claim endpoint from cron/CI)");
scheduleCmd
  .command("due")
  .description("Claim all due scheduled flows — run me every minute from cron/GitHub Actions")
  .option("--execute", "Actually run each due flow (parallel, --concurrency)", false)
  .option("--concurrency <n>", "Browsers in flight when --execute", "4")
  .action(async (opts: { execute?: boolean; concurrency?: string }) => {
    try {
      const client = CloudClient.fromEnvOrStore();
      if (!client) throw new Error("credentials required (veriflow login or VERIFLOW_API_KEY)");
      const res = await client.request<{
        due: { flowId: string; name: string; objective: string; envUrl?: string; retryPolicy?: { maxAttempts: number; backoffSeconds: number } }[];
      }>("POST", "/v1/schedules/claim", {});
      if (!opts.execute) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const flows = res.due.map((f) => ({ flowId: f.flowId, name: f.name, objective: f.objective, envUrl: f.envUrl, retryPolicy: f.retryPolicy }));
      if (!flows.length) {
        console.log(JSON.stringify({ due: 0, ran: 0 }, null, 2));
        return;
      }
      const suite = await runSuite(flows, { concurrency: Number(opts.concurrency ?? 4), headless: true });
      console.log(JSON.stringify({ due: flows.length, ...suiteSummary(suite) }, null, 2));
      process.exitCode = suite.failed > 0 ? 1 : 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("suite")
  .description("Run many flows concurrently with a bounded worker pool")
  .option("--flow <id...>", "Local flow ids to run")
  .option("--all", "Run every saved local flow", false)
  .option("--concurrency <n>", "Browsers in flight", "4")
  .option("--headless", "Run headless (default true)", true)
  .action(async (opts: { flow?: string[]; all?: boolean; concurrency?: string; headless?: boolean }) => {
    const all = listFlows();
    let chosen = all;
    if (opts.flow?.length) chosen = all.filter((f) => opts.flow!.includes(f.id));
    if (!chosen.length) {
      console.error("no flows matched (save one with `veriflow run ... --save-flow <name>`, or pass --flow <id>)");
      process.exitCode = 1;
      return;
    }
    const suite = await runSuite(
      chosen
        .filter((f) => !f.quarantined)
        .map((f) => ({ flowId: f.id, name: f.name, objective: f.objective, envUrl: f.envUrl, retryPolicy: f.retryPolicy })),
      { concurrency: Number(opts.concurrency ?? 4), headless: opts.headless !== false },
    );
    console.log(JSON.stringify(suiteSummary(suite), null, 2));
    process.exitCode = suite.failed > 0 ? 1 : 0;
  });

const deviceCmd = program
  .command("device")
  .description("Turn this machine into a hosted-device worker (runs claimed flows)()");
deviceCmd
  .command("connect")
  .description("Register this device and poll for work until interrupted")
  .option("--name <name>", "Device label", `device-${process.pid}`)
  .option("--poll <ms>", "Poll interval", "15000")
  .action(async (opts: { name?: string; poll?: string }) => {
    const client = CloudClient.fromEnvOrStore();
    if (!client) {
      console.error("credentials required (veriflow login or VERIFLOW_API_KEY)");
      process.exitCode = 1;
      return;
    }
    const reg = await client.request<{ device: { id: string } }>("POST", "/v1/devices", { name: opts.name });
    console.log(`device registered: ${reg.device.id} (polling every ${opts.poll}ms — Ctrl+C to stop)`);
    const pollMs = Number(opts.poll ?? 15000);
    const stop = () => {
      void client.request("POST", `/v1/devices/${reg.device.id}/heartbeat`, { status: "offline" }).catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", stop);
    for (;;) {
      try {
        await client.request("POST", `/v1/devices/${reg.device.id}/heartbeat`, { status: "online" });
        const claim = await client.request<{ job?: { flowId: string; objective: string; envUrl?: string } | null }>(
          "POST",
          `/v1/devices/${reg.device.id}/claim`,
          {},
        );
        if (claim.job) {
          console.log(`→ job: ${claim.job.objective.slice(0, 60)}`);
          const result = await runHarness({ objective: claim.job.objective, envUrl: claim.job.envUrl, headless: true });
          console.log(`  done: ${result.status}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  });

const pauseCmd = program
  .command("pause")
  .description("Manage human-in-the-loop pause requests (CI magic links)");
pauseCmd
  .command("list")
  .description("Show pending pauses for the project")
  .action(async () => {
    try {
      const client = CloudClient.fromEnvOrStore();
      if (!client) throw new Error("credentials required (veriflow login or VERIFLOW_API_KEY)");
      const res = await client.request<{ pauses?: unknown[] }>("GET", "/v1/human-pauses");
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });
pauseCmd
  .command("resolve")
  .description("Resolve a pending pause (the human half of the magic link)")
  .argument("<pauseId>")
  .option("--response <text>", "Response passed back to the run", "confirmed via veriflow CLI")
  .action(async (pauseId: string, opts: { response?: string }) => {
    try {
      const client = CloudClient.fromEnvOrStore();
      if (!client) throw new Error("credentials required (veriflow login or VERIFLOW_API_KEY)");
      const res = await client.request("POST", `/v1/human-pauses/${encodeURIComponent(pauseId)}/resolve`, {
        response: opts.response,
      });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

const budget = program.command("budget").description("Local budget caps");
budget
  .command("get")
  .description("Print the local run/step/cost caps")
  .action(() => {
    const cfg = loadConfig();
    console.log(JSON.stringify({ runCap: cfg.runCap, stepCap: cfg.stepCap, costCapUsd: cfg.costCapUsd }, null, 2));
  });
budget
  .command("set")
  .option("--run-cap <n>", "Max steps / run cap stored in config")
  .option("--cost-cap <usd>")
  .action((opts: { runCap?: string; costCap?: string }) => {
    const cfg = loadConfig();
    if (opts.runCap) {
      cfg.runCap = Number(opts.runCap);
      cfg.stepCap = Number(opts.runCap);
    }
    if (opts.costCap) cfg.costCapUsd = Number(opts.costCap);
    saveConfig(cfg);
    console.log(JSON.stringify({ runCap: cfg.runCap, stepCap: cfg.stepCap, costCapUsd: cfg.costCapUsd }));
  });

program.addHelpText(
  "after",
  `\nLocal store: ${veriflowHome()}\nCredentials: encrypted at ~/.veriflow/credentials.enc after \`veriflow login\`.`,
);

program.parseAsync(process.argv);
