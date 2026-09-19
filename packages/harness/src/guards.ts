import type { Action } from "@veriflow/schema";
import type { A11yNode } from "./a11y.js";

const DESTRUCTIVE_RE =
  /\b(delete|remove account|destroy|purchase|buy now|pay now|confirm order|transfer funds|wipe)\b/i;

export function stableActionKey(action: Action): string {
  const clone: Record<string, unknown> = { ...action };
  if (action.type === "wait") {
    delete clone.ms;
  }
  if (action.type === "fill") {
    clone.value = action.secret || action.vaultKey ? "[REDACTED]" : action.value;
  }
  return JSON.stringify(clone);
}

export function detectActionLoop(recent: Action[], abortCount = 3): boolean {
  if (recent.length < abortCount) return false;
  const tail = recent.slice(-abortCount).map(stableActionKey);
  return tail.every((k) => k === tail[0]);
}

/**
 * Destructive-action detection: checks the action JSON plus, for ref targets,
 * the element's accessible name from the current observation (spec 1.4:
 * "keywords in the objective or the visible button text").
 */
export function isDestructive(action: Action, nodes: A11yNode[] = []): boolean {
  if (action.type === "click" && action.destructive) return true;
  const parts: string[] = [JSON.stringify(action)];
  const ref = "target" in action && action.target?.ref ? action.target.ref.replace(/^@/, "") : undefined;
  if (ref) {
    const node = nodes.find((n) => n.ref === ref);
    if (node?.name) parts.push(node.name);
  }
  return DESTRUCTIVE_RE.test(parts.join(" "));
}

export interface GuardInput {
  action: Action;
  stepCount: number;
  stepCap: number;
  recentActions: Action[];
  loopAbortCount: number;
  /** Current observation, used to resolve ref targets to visible names. */
  observedNodes?: A11yNode[];
  elapsedMs: number;
  wallClockMs: number;
  tokensUsed: number;
  tokenCap: number;
  costUsd: number;
  costCapUsd: number;
  allowDestructive: boolean;
  dryRun: boolean;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function evaluateGuards(input: GuardInput): GuardVerdict {
  if (input.stepCount >= input.stepCap) {
    return { ok: false, code: "step_cap", message: `Step cap reached (${input.stepCap})` };
  }
  if (input.elapsedMs >= input.wallClockMs) {
    return {
      ok: false,
      code: "wall_clock",
      message: `Wall-clock timeout (${input.wallClockMs}ms)`,
    };
  }
  if (input.tokensUsed >= input.tokenCap) {
    return { ok: false, code: "token_cap", message: `Token cap reached (${input.tokenCap})` };
  }
  if (input.costUsd >= input.costCapUsd) {
    return {
      ok: false,
      code: "cost_cap",
      message: `Cost cap reached ($${input.costCapUsd})`,
    };
  }
  if (detectActionLoop([...input.recentActions, input.action], input.loopAbortCount)) {
    return {
      ok: false,
      code: "action_loop",
      message: `Same action repeated ${input.loopAbortCount} times`,
    };
  }
  if (isDestructive(input.action, input.observedNodes ?? []) && !input.allowDestructive && !input.dryRun) {
    return {
      ok: false,
      code: "destructive",
      message: "Destructive action blocked. Re-run with --yes-i-mean-it or --dry-run.",
    };
  }
  return { ok: true };
}
