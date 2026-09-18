import type { RunEvent, Span } from "@veriflow/schema";

export interface RunReliability {
  runId: string;
  status: string;
  steps: number;
  durationMs: number;
  costUsd: number;
  selfHealAttempts: number;
  selfHealSuccesses: number;
  humanInterventions: number;
  guardAborts: { code: string; message: string }[];
  assertFailures: number;
}

export interface ReliabilityMetrics {
  runs: number;
  passRate: number;
  stepsPerRun: { median: number; p95: number };
  selfHealRate: number;
  humanInterventionRate: number;
  guardAbortRate: number;
  avgCostUsd: number;
  p50DurationMs: number;
  p95DurationMs: number;
  perRun: RunReliability[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Reliability metrics (spec §2.6) for one run, from its event log + spans. */
export function runReliability(runId: string, events: RunEvent[], spans: Span[] = []): RunReliability {
  const start = events.find((e) => e.type === "run_start");
  const end = events.find((e) => e.type === "run_end");
  const retries = events.filter((e) => e.type === "retry");
  const guards = events.filter((e) => e.type === "guard" && (e.payload as { ok?: boolean }).ok === false);
  const humans = events.filter((e) => e.type === "human");
  const failedVerifies = events.filter(
    (e) => e.type === "verify" && (e.payload as { ok?: boolean; finish?: boolean }).ok === false,
  );
  const startedAt = start?.ts ?? events[0]?.ts ?? new Date().toISOString();
  const endedAt = end?.ts ?? startedAt;
  const retrySpanOk = new Map<string, boolean>();
  for (const s of spans) {
    if (s.kind === "RETRY" && s.stepId) retrySpanOk.set(s.stepId, s.ok === true);
  }
  return {
    runId,
    status: String(end?.payload.status ?? "unknown"),
    steps: Number(end?.payload.steps ?? 0),
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    costUsd: Number(end?.payload.costUsd ?? 0),
    selfHealAttempts: retries.length,
    selfHealSuccesses: retries.filter((e) => (e.payload as { ok?: boolean }).ok === true).length,
    humanInterventions: humans.length,
    guardAborts: guards.map((e) => ({
      code: String((e.payload as { code?: string }).code ?? "unknown"),
      message: String((e.payload as { message?: string }).message ?? ""),
    })),
    assertFailures: failedVerifies.length,
  };
}

/** Aggregate reliability metrics across runs (spec §2.6 table). */
export function computeReliabilityMetrics(runs: RunReliability[]): ReliabilityMetrics {
  const passed = runs.filter((r) => r.status === "passed").length;
  const steps = [...runs.map((r) => r.steps)].sort((a, b) => a - b);
  const durations = [...runs.map((r) => r.durationMs)].sort((a, b) => a - b);
  const totalRetries = runs.reduce((s, r) => s + r.selfHealAttempts, 0);
  const totalHeals = runs.reduce((s, r) => s + r.selfHealSuccesses, 0);
  const interventions = runs.reduce((s, r) => s + r.humanInterventions, 0);
  const guardAborts = runs.filter((r) => r.guardAborts.length > 0).length;
  return {
    runs: runs.length,
    passRate: runs.length ? passed / runs.length : 0,
    stepsPerRun: { median: median(steps), p95: percentile(steps, 95) },
    selfHealRate: totalRetries ? totalHeals / totalRetries : 0,
    humanInterventionRate: runs.length ? interventions / runs.length : 0,
    guardAbortRate: runs.length ? guardAborts / runs.length : 0,
    avgCostUsd: runs.length ? runs.reduce((s, r) => s + r.costUsd, 0) / runs.length : 0,
    p50DurationMs: median(durations),
    p95DurationMs: percentile(durations, 95),
    perRun: runs,
  };
}
