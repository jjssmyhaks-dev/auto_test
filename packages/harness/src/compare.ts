import { createHmac, timingSafeEqual } from "node:crypto";
import type { Step, RunStatus } from "@veriflow/schema";

/**
 * Run comparison: align two runs' steps by index and diff action type /
 * status / key detail, producing a per-row verdict plus a summary. Screenshot
 * blob paths ride along for the side-by-side filmstrip. Also hosts the
 * Stripe webhook signature verifier (HMAC per Stripe's scheme).
 */

export interface CompareRow {
  index: number;
  typeA?: string;
  typeB?: string;
  labelA?: string;
  labelB?: string;
  statusA?: string;
  statusB?: string;
  screenshotA?: string;
  screenshotB?: string;
  /** same | changed | only_a | only_b */
  verdict: "same" | "changed" | "only_a" | "only_b";
}

export interface CompareResult {
  runIdA: string;
  runIdB: string;
  statusA?: RunStatus;
  statusB?: RunStatus;
  rows: CompareRow[];
  summary: {
    same: number;
    changed: number;
    onlyA: number;
    onlyB: number;
    /** 0..1 — identical steps / max(stepsA, stepsB). */
    similarity: number;
    /** Status flipped between the runs? (passed vs failed…) */
    statusFlipped: boolean;
  };
}

/** Short human label for a step's action, e.g. `click "Buy"`. */
export function stepLabel(step: Step): string {
  const a = step.action as { type: string; url?: string; selector?: { text?: string; ref?: string }; text?: string; ms?: number; reason?: string; success?: boolean };
  switch (a.type) {
    case "navigate":
      return a.url ?? "";
    case "click":
      return a.selector?.text ?? a.selector?.ref ?? "";
    case "fill":
      return a.text ? `“${a.text.slice(0, 24)}”` : "";
    case "wait":
      return a.ms != null ? `${a.ms}ms` : "";
    case "finish":
      return a.reason ?? (a.success ? "success" : "failure");
    default:
      return "";
  }
}

export function compareSteps(
  runIdA: string,
  runIdB: string,
  stepsA: Step[],
  stepsB: Step[],
  statusA?: RunStatus,
  statusB?: RunStatus,
  screenshotsA: string[] = [],
  screenshotsB: string[] = [],
): CompareResult {
  const max = Math.max(stepsA.length, stepsB.length);
  const rows: CompareRow[] = [];
  let same = 0;
  let changed = 0;
  let onlyA = 0;
  let onlyB = 0;

  for (let i = 0; i < max; i++) {
    const a = stepsA[i];
    const b = stepsB[i];
    const row: CompareRow = {
      index: i,
      typeA: a?.action.type,
      typeB: b?.action.type,
      labelA: a ? stepLabel(a) : undefined,
      labelB: b ? stepLabel(b) : undefined,
      statusA: a?.status,
      statusB: b?.status,
      screenshotA: screenshotsA[i],
      screenshotB: screenshotsB[i],
      verdict: a && b ? (a.action.type === b.action.type && stepLabel(a) === stepLabel(b) && a.status === b.status ? "same" : "changed") : a ? "only_a" : "only_b",
    };
    if (a && b) {
      const identical =
        a.action.type === b.action.type &&
        stepLabel(a) === stepLabel(b) &&
        a.status === b.status;
      row.verdict = identical ? "same" : "changed";
      if (identical) same++;
      else changed++;
    } else if (a) {
      row.verdict = "only_a";
      onlyA++;
    } else {
      row.verdict = "only_b";
      onlyB++;
    }
    rows.push(row);
  }

  return {
    runIdA,
    runIdB,
    statusA,
    statusB,
    rows,
    summary: {
      same,
      changed,
      onlyA,
      onlyB,
      similarity: max === 0 ? 1 : same / max,
      statusFlipped: !!statusA && !!statusB && statusA !== statusB,
    },
  };
}

/** Verify Stripe's `t=…,v1=…` HMAC signature over `${timestamp}.${payload}`. */
export function verifyStripeSignature(payload: string, header: string, secret: string, toleranceSeconds = 300): { ok: true } | { ok: false; reason: string } {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  if (!parts.t || !parts.v1) return { ok: false, reason: "malformed signature" };
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const expected = createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}
