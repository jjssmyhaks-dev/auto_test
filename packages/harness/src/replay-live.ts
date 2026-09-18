import type { Browser } from "playwright";
import { chromium } from "playwright";
import type { Action, RunEvent } from "@veriflow/schema";
import { performAction, verifyAction } from "./act.js";
import { observePage } from "./act.js";
import type { A11yNode } from "./a11y.js";

export interface LiveReplayStep {
  index: number;
  action: Action;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface LiveReplayResult {
  runId: string;
  envUrl?: string;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  steps: LiveReplayStep[];
}

/**
 * Deterministic replay against the live site (spec §1.6): re-executes the exact
 * recorded action sequence — no LLM, no re-decision. Regression-checks whether a
 * previously-passing flow still passes without re-paying for perception.
 */
export async function replayLive(input: {
  runId: string;
  events: RunEvent[];
  headless?: boolean;
  resolveSecret?: (action: Action) => string | undefined;
}): Promise<LiveReplayResult> {
  const start = input.events.find((e) => e.type === "run_start");
  const envUrl = start?.payload.envUrl as string | undefined;
  const actions = input.events
    .filter((e) => e.type === "decide")
    .map((e) => e.payload.action as Action | undefined)
    .filter((a): a is Action => Boolean(a) && typeof a === "object" && "type" in (a as object));

  const steps: LiveReplayStep[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: input.headless !== false });
    const context = await browser.newContext();
    const page = await context.newPage();
    if (envUrl) {
      await page.goto(envUrl, { waitUntil: "domcontentloaded" });
    }
    let nodes: A11yNode[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type === "finish") {
        steps.push({ index: i, action, ok: true, detail: `finish ${action.success ? "pass" : "fail"}: ${action.reason}`, skipped: true });
        continue;
      }
      if (action.type === "request_human") {
        steps.push({ index: i, action, ok: false, detail: "human pause cannot replay live", skipped: true });
        continue;
      }
      try {
        const observed = await observePage(page);
        nodes = observed.a11y.nodes;
        if (action.type === "assert") {
          const v = await verifyAction(page, action);
          steps.push({ index: i, action, ok: v.ok, detail: v.detail });
          continue;
        }
        const r = await performAction(page, action, nodes, (a) => input.resolveSecret?.(a) ?? (a.type === "fill" ? a.value : undefined));
        steps.push({ index: i, action, ok: r.ok, detail: r.detail });
      } catch (err) {
        steps.push({ index: i, action, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    await browser?.close();
  }

  const executed = steps.filter((s) => !s.skipped).length;
  const passed = steps.filter((s) => !s.skipped && s.ok).length;
  const failed = executed - passed;
  return {
    runId: input.runId,
    envUrl,
    executed,
    passed,
    failed,
    skipped: steps.length - executed,
    steps,
  };
}
