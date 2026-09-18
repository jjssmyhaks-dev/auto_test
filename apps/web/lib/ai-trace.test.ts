import { describe, expect, it } from "vitest";
import {
  actionTypeOf,
  parseAgentReport,
  SAMPLE_AGENT_REPORT,
  toolStateForStatus,
  userPromptForTurn,
} from "./ai-trace";

describe("ai-trace helpers", () => {
  it("maps harness actions and statuses", () => {
    expect(actionTypeOf({ type: "click" })).toBe("click");
    expect(actionTypeOf(null)).toBe("unknown");
    expect(toolStateForStatus("ok")).toBe("output-available");
    expect(toolStateForStatus("failed")).toBe("output-error");
  });

  it("parses agent-test JSON", () => {
    const report = parseAgentReport(JSON.stringify(SAMPLE_AGENT_REPORT));
    expect(report.turns.length).toBeGreaterThan(0);
    expect(userPromptForTurn(report.turns[0])).toContain("who are you");
  });

  it("rejects JSON without turns", () => {
    expect(() => parseAgentReport("{}")).toThrow(/turns/);
  });
});
