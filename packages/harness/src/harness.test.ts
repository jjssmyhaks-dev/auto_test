import { describe, expect, it } from "vitest";
import { exportPlaywrightTest, importPlaywrightTest } from "./playwright-interop.js";
import { assertConsole, assertNetwork, emptyCapture } from "./devtools.js";
import { runAgentTest, scoreReply, verdictFromPassRate } from "./agent-test.js";

describe("playwright interop", () => {
  it("round-trips a simple test", () => {
    const src = exportPlaywrightTest({
      name: "example",
      objective: "heading",
      envUrl: "https://example.com",
      actions: [
        { type: "navigate", url: "https://example.com" },
        { type: "assert", check: "text_contains", value: "Example" },
        { type: "finish", success: true, reason: "done" },
      ],
    });
    expect(src).toContain("page.goto");
    const imported = importPlaywrightTest(src);
    expect(imported.actions.some((a) => a.type === "navigate")).toBe(true);
    expect(imported.actions.some((a) => a.type === "assert")).toBe(true);
  });
});

describe("devtools asserts", () => {
  it("matches network and console captures", () => {
    const cap = emptyCapture();
    cap.network.push({ url: "https://api.example.com/v1", method: "GET", status: 200 });
    cap.console.push({ type: "log", text: "boot complete" });
    expect(assertNetwork(cap, "api.example").ok).toBe(true);
    expect(assertConsole(cap, "boot").ok).toBe(true);
    expect(assertNetwork(cap, "missing").ok).toBe(false);
  });
});

describe("agent-test", () => {
  it("scores replies and produces a verdict without a live LLM", async () => {
    expect(scoreReply({ reply: "Acme support here", facts: [], expectIncludes: ["acme"] }).pass).toBe(true);
    expect(verdictFromPassRate(0.9)).toBe("green");
    expect(verdictFromPassRate(0.2)).toBe("red");
    const report = await runAgentTest({
      endpoint: "http://unused.invalid/chat",
      scenarios: 2,
      harness: {
        async runTurn(input: string) {
          if (input.toLowerCase().includes("who are you")) return { reply: "I am Acme support here to help." };
          return { reply: "A-1001 noted." };
        },
      },
    });
    expect(report.verdict).toMatch(/green|yellow|red/);
    expect(report.spans.length).toBeGreaterThan(0);
    expect(report.metrics.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
