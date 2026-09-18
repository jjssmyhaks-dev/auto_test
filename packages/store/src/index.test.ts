import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, computeLocalFlowMetrics, persistSpans, readSpans } from "./index.js";

describe("span persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  it("writes spans.json", () => {
    const home = mkdtempSync(join(tmpdir(), "vf-store-"));
    dirs.push(home);
    persistSpans(
      "run_1",
      [
        {
          id: "s1",
          runId: "run_1",
          kind: "OBSERVE",
          startedAt: new Date().toISOString(),
          ok: true,
        },
      ],
      home,
    );
    expect(readSpans("run_1", home)[0]?.kind).toBe("OBSERVE");
  });

  it("computes local flow metrics from event logs", () => {
    const home = mkdtempSync(join(tmpdir(), "vf-metrics-"));
    dirs.push(home);
    appendEvent(
      "run_abc",
      { ts: new Date().toISOString(), type: "run_start", runId: "run_abc", payload: { objective: "heading" } },
      home,
    );
    appendEvent(
      "run_abc",
      { ts: new Date().toISOString(), type: "run_end", runId: "run_abc", payload: { status: "passed", costUsd: 0.1 } },
      home,
    );
    const m = computeLocalFlowMetrics("heading", home);
    expect(m.runs).toBe(1);
    expect(m.passRate).toBe(1);
    expect(m.avgCostUsd).toBeCloseTo(0.1);
  });
});
