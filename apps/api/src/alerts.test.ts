import { describe, expect, it } from "vitest";
import { computeAlerts } from "./store.js";

describe("alerts", () => {
  it("emits success_rate and cost_spike types", () => {
    const failed = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      projectId: "p",
      objective: "x",
      status: "failed",
      startedAt: new Date().toISOString(),
      stepCount: 1,
      costUsd: i === 0 ? 9 : 0.1,
    }));
    const alerts = computeAlerts(failed);
    expect(alerts.some((a) => a.kind === "success_rate")).toBe(true);
    expect(alerts.some((a) => a.kind === "cost_spike")).toBe(true);
  });
});
