import { describe, expect, it } from "vitest";
import { replayLive } from "./replay-live.js";
import { startTestSite } from "../../../tests/golden/test-site.js";
import type { RunEvent } from "@veriflow/schema";

function ev(type: RunEvent["type"], payload: Record<string, unknown>, stepIndex?: number): RunEvent {
  return { ts: new Date().toISOString(), type, runId: "run_r", stepIndex, payload };
}

describe("replay --live", () => {
  it("re-executes a recorded action sequence deterministically, no LLM", async () => {
    const site = await startTestSite();
    try {
      const events: RunEvent[] = [
        ev("run_start", { objective: "open dashboard", envUrl: site.url }),
        ev("decide", { action: { type: "navigate", url: `${site.url}/dashboard` } }, 0),
        ev("decide", { action: { type: "assert", check: "heading_contains", value: "Dashboard" } }, 1),
        ev("decide", { action: { type: "assert", check: "text_contains", value: "Welcome back" } }, 2),
      ];
      const result = await replayLive({ runId: "run_r", events, headless: true });
      expect(result.executed).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.steps.every((s) => s.ok)).toBe(true);
    } finally {
      await site.close();
    }
  }, 30_000);

  it("fails cleanly when the site no longer matches the recording", async () => {
    const site = await startTestSite();
    try {
      const events: RunEvent[] = [
        ev("run_start", { objective: "stale flow", envUrl: site.url }),
        ev("decide", { action: { type: "assert", check: "text_contains", value: "This text no longer exists" } }, 0),
      ];
      const result = await replayLive({ runId: "run_r", events, headless: true });
      expect(result.failed).toBe(1);
      expect(result.steps[0]?.ok).toBe(false);
    } finally {
      await site.close();
    }
  }, 30_000);
});
