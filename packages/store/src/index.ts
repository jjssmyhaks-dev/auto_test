import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  FlowSchema,
  type CloudCredentials,
  type Flow,
  type RunEvent,
  type Span,
  type VeriflowConfig,
} from "@veriflow/schema";

export function veriflowHome(override = process.env.VERIFLOW_HOME): string {
  return override && override.length > 0 ? override : join(homedir(), ".veriflow");
}

export function paths(home = veriflowHome()) {
  return {
    home,
    config: join(home, "config.json"),
    vault: join(home, "vault.enc"),
    vaultKey: join(home, "vault.key"),
    credentials: join(home, "credentials.enc"),
    runs: join(home, "runs"),
    flows: join(home, "flows"),
  };
}

export function runPaths(runId: string, home = veriflowHome()) {
  const dir = join(paths(home).runs, runId);
  return {
    dir,
    events: join(dir, "events.jsonl"),
    evidence: join(dir, "evidence.testevidence"),
    report: join(dir, "report.html"),
    manifest: join(dir, "manifest.json"),
    screenshots: join(dir, "screenshots"),
    spans: join(dir, "spans.json"),
    capture: join(dir, "capture.json"),
    otlp: join(dir, "otlp.json"),
  };
}

export function ensureHome(home = veriflowHome()): void {
  const p = paths(home);
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.runs, { recursive: true });
  mkdirSync(p.flows, { recursive: true });
  if (!existsSync(p.config)) {
    writeFileSync(p.config, JSON.stringify(loadConfig(home), null, 2), "utf8");
  }
}

export function loadConfig(home = veriflowHome()): VeriflowConfig {
  const p = paths(home);
  if (!existsSync(p.config)) {
    return ConfigSchema.parse({});
  }
  try {
    const raw = JSON.parse(readFileSync(p.config, "utf8")) as unknown;
    return ConfigSchema.parse(raw);
  } catch {
    return ConfigSchema.parse({});
  }
}

export function saveConfig(config: VeriflowConfig, home = veriflowHome()): void {
  ensureHome(home);
  writeFileSync(paths(home).config, JSON.stringify(config, null, 2), "utf8");
}

export function ensureRunDir(runId: string, home = veriflowHome()): ReturnType<typeof runPaths> {
  const rp = runPaths(runId, home);
  mkdirSync(rp.dir, { recursive: true });
  mkdirSync(rp.screenshots, { recursive: true });
  return rp;
}

export function appendEvent(runId: string, event: RunEvent, home = veriflowHome()): void {
  const rp = ensureRunDir(runId, home);
  appendFileSync(rp.events, `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(runId: string, home = veriflowHome()): RunEvent[] {
  const rp = runPaths(runId, home);
  if (!existsSync(rp.events)) {
    throw new Error(`No event log for run ${runId} at ${rp.events}`);
  }
  return readFileSync(rp.events, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent);
}

export function listRunIds(home = veriflowHome()): string[] {
  const runs = paths(home).runs;
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((name) => {
    try {
      return statSync(join(runs, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

export function persistSpans(runId: string, spans: Span[], home = veriflowHome()): void {
  const rp = ensureRunDir(runId, home);
  writeFileSync(rp.spans, JSON.stringify(spans, null, 2), "utf8");
}

export function readSpans(runId: string, home = veriflowHome()): Span[] {
  const rp = runPaths(runId, home);
  if (!existsSync(rp.spans)) return [];
  try {
    return JSON.parse(readFileSync(rp.spans, "utf8")) as Span[];
  } catch {
    return [];
  }
}

export function persistCapture(runId: string, capture: unknown, home = veriflowHome()): void {
  const rp = ensureRunDir(runId, home);
  writeFileSync(rp.capture, JSON.stringify(capture, null, 2), "utf8");
}

export function readCapture(runId: string, home = veriflowHome()): unknown {
  const rp = runPaths(runId, home);
  if (!existsSync(rp.capture)) return undefined;
  try {
    return JSON.parse(readFileSync(rp.capture, "utf8"));
  } catch {
    return undefined;
  }
}

export function saveFlow(flow: Flow, home = veriflowHome()): void {
  ensureHome(home);
  const dir = paths(home).flows;
  mkdirSync(dir, { recursive: true });
  const parsed = FlowSchema.parse(flow);
  writeFileSync(join(dir, `${parsed.id}.json`), JSON.stringify(parsed, null, 2), "utf8");
}

export function listFlows(home = veriflowHome()): Flow[] {
  const dir = paths(home).flows;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return FlowSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      } catch {
        return undefined;
      }
    })
    .filter((f): f is Flow => Boolean(f));
}

export function getFlow(id: string, home = veriflowHome()): Flow | undefined {
  return listFlows(home).find((f) => f.id === id);
}

export interface LocalFlowMetrics {
  flowId: string;
  source: "local";
  runs: number;
  passRate: number;
  avgCostUsd: number;
  recent: { id: string; status: string; costUsd: number; objective: string }[];
}

/** Pass-rate / cost from ~/.veriflow/runs without a cloud account. */
export function computeLocalFlowMetrics(flowId: string, home = veriflowHome()): LocalFlowMetrics {
  const flows = listFlows(home);
  const recent: LocalFlowMetrics["recent"] = [];
  for (const id of listRunIds(home)) {
    try {
      const events = readEvents(id, home);
      const start = events.find((e) => e.type === "run_start");
      const end = events.find((e) => e.type === "run_end");
      const objective = String(start?.payload.objective ?? "");
      const matchedFlow = flows.some(
        (f) =>
          (f.id === flowId || f.name === flowId) &&
          (f.objective === objective || f.id === `flow_${id}`),
      );
      if (id.includes(flowId) || objective.includes(flowId) || matchedFlow) {
        recent.push({
          id,
          status: String(end?.payload.status ?? "unknown"),
          costUsd: Number(end?.payload.costUsd ?? 0),
          objective,
        });
      }
    } catch {
      /* skip incomplete run dirs */
    }
  }
  const passed = recent.filter((r) => r.status === "passed").length;
  return {
    flowId,
    source: "local",
    runs: recent.length,
    passRate: recent.length ? passed / recent.length : 0,
    avgCostUsd: recent.length ? recent.reduce((s, r) => s + r.costUsd, 0) / recent.length : 0,
    recent: recent.slice(0, 50),
  };
}

export type { CloudCredentials };
