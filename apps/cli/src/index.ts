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
  runReliability,
  syncRunIfConfigured,
} from "@veriflow/harness";
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

const program = new Command()
  .name("veriflow")
  .description("Veriflow — local-first vision browser testing")
  .version("0.2.0");

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
  .option("--sync", "Push evidence to the cloud API after the run", false)
  .action(async (objective: string, opts: Record<string, unknown>) => {
    try {
      const result = await runHarness({
        objective,
        envUrl: opts.env as string | undefined,
        headless: Boolean(opts.headless),
        profile: opts.profile as string | undefined,
        record: opts.record !== false,
        agent: Boolean(opts.agent),
        yesIMeanIt: Boolean(opts.yesIMeanIt),
        dryRun: Boolean(opts.dryRun),
        captureDevtools: Boolean(opts.devtools),
        otlp: Boolean(opts.otlp),
        progress: (line) => console.error(line),
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
  .description("Reserved — not a security suite. Use agent-test for chat evaluation.")
  .action(() => {
    console.error("redteam is reserved and is not a full security suite. Use `veriflow agent-test`.");
    process.exitCode = 1;
  });

program
  .command("agent-test")
  .description("Chat-only agent evaluation (OBSERVE/DECIDE/GUARD/ACT/VERIFY)")
  .requiredOption("--endpoint <url>", "Chat HTTP endpoint (POST { messages })")
  .option("--scenarios <n>", "How many bundled scenarios to run", "5")
  .action(async (opts: { endpoint: string; scenarios?: string }) => {
    try {
      const report = await runAgentTest({
        endpoint: opts.endpoint,
        scenarios: Number(opts.scenarios ?? 5),
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
