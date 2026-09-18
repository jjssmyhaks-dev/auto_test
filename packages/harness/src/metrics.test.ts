import { describe, expect, it } from "vitest";
import { computeReliabilityMetrics, runReliability } from "./metrics.js";
import type { RunEvent } from "@veriflow/schema";

function ev(type: RunEvent["type"], payload: Record<string, unknown>, stepIndex?: number): RunEvent {
  return { ts: new Date().toISOString(), type, runId: "run_test", stepIndex, payload };
}

describe("reliability metrics", () => {
  it("computes self-heal, intervention, and latency stats for one run", () => {
    const rel = runReliability("run_1", [
      ev("run_start", { objective: "x" }),
      ev("retry", { ok: true }, 1),
      ev("retry", { ok: false }, 2),
      ev("human", { reason: "otp" }, 3),
      ev("guard", { ok: false, code: "cost_cap", message: "over" }, 4),
      ev("run_end", { status: "failed", steps: 5, costUsd: 0.02 }),
    ]);
    expect(rel.selfHealAttempts).toBe(2);
    expect(rel.selfHealSuccesses).toBe(1);
    expect(rel.humanInterventions).toBe(1);
    expect(rel.guardAborts[0]?.code).toBe("cost_cap");
    expect(rel.steps).toBe(5);
    expect(rel.costUsd).toBeCloseTo(0.02);
  });

  it("aggregates percentiles and rates across runs", () => {
    const mk = (status: string, steps: number, cost: number) => ({
      runId: `run_${steps}`,
      status,
      steps,
      durationMs: steps * 1000,
      costUsd: cost,
      selfHealAttempts: 2,
      selfHealSuccesses: 1,
      humanInterventions: 1,
      guardAborts: [],
      assertFailures: 0,
    });
    const agg = computeReliabilityMetrics([mk("passed", 4, 0.1), mk("passed", 8, 0.2), mk("failed", 10, 0.3)]);
    expect(agg.passRate).toBeCloseTo(2 / 3);
    expect(agg.stepsPerRun.median).toBe(8);
    expect(agg.p50DurationMs).toBe(8000);
    expect(agg.p95DurationMs).toBe(10000);
    expect(agg.selfHealRate).toBeCloseTo(0.5);
    expect(agg.humanInterventionRate).toBe(1);
    expect(agg.avgCostUsd).toBeCloseTo(0.2);
  });

  it("handles empty input", () => {
    const agg = computeReliabilityMetrics([]);
    expect(agg.runs).toBe(0);
    expect(agg.passRate).toBe(0);
    expect(agg.stepsPerRun.median).toBe(0);
  });
});
