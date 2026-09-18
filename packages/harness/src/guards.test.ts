import { describe, expect, it } from "vitest";
import type { Action } from "@veriflow/schema";
import { detectActionLoop, evaluateGuards, isDestructive, stableActionKey } from "./guards.js";

const click = (ref: string): Action => ({ type: "click", target: { ref } });

describe("detectActionLoop", () => {
  it("aborts after 3 identical actions", () => {
    expect(detectActionLoop([click("e1"), click("e1"), click("e1")], 3)).toBe(true);
    expect(detectActionLoop([click("e1"), click("e1")], 3)).toBe(false);
    expect(detectActionLoop([click("e1"), click("e2"), click("e1")], 3)).toBe(false);
  });
});

describe("isDestructive", () => {
  it("flags explicit and heuristic destructive clicks", () => {
    expect(isDestructive({ type: "click", target: { text: "Save" } })).toBe(false);
    expect(isDestructive({ type: "click", target: { text: "Delete" }, destructive: true })).toBe(
      true,
    );
    expect(isDestructive({ type: "click", target: { text: "Pay now" } })).toBe(true);
  });
});

describe("evaluateGuards", () => {
  const base = {
    action: click("e1") as Action,
    stepCount: 0,
    stepCap: 50,
    recentActions: [] as Action[],
    loopAbortCount: 3,
    elapsedMs: 10,
    wallClockMs: 300_000,
    tokensUsed: 10,
    tokenCap: 200_000,
    costUsd: 0.01,
    costCapUsd: 5,
    allowDestructive: false,
    dryRun: false,
  };

  it("enforces step, cost, and destructive caps", () => {
    expect(evaluateGuards({ ...base, stepCount: 50 }).ok).toBe(false);
    expect(evaluateGuards({ ...base, costUsd: 5 }).ok).toBe(false);
    expect(
      evaluateGuards({
        ...base,
        action: { type: "click", target: { text: "Delete account" }, destructive: true },
      }).ok,
    ).toBe(false);
    expect(
      evaluateGuards({
        ...base,
        action: { type: "click", target: { text: "Delete account" }, destructive: true },
        allowDestructive: true,
      }).ok,
    ).toBe(true);
    expect(stableActionKey(click("e1"))).toContain("e1");
  });
});
