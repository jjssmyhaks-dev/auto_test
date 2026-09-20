"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { markAction } from "@/lib/onboarding";

export interface HealedStep {
  stepIndex: number;
  failure: string;
  repairedSelector?: string;
  originalSelector?: string;
}

interface RepairInfo {
  version: number;
  repair: { runId: string; stepIndex: number; toSelector?: string; committedAt: string };
}

/**
 * Self-heal review: when a run repaired itself (selector broke → agent found
 * a new one), surface the before/after and let a reviewer commit the repair
 * into the flow as a new version — turning an agent judgement into an
 * approved flow change. Heals come from the trace payload (derived from the
 * run's stored event log, so every synced run works).
 */
export function SelfHealReview({ runId, flowId, heals }: { runId: string; flowId?: string; heals: HealedStep[] }) {
  const [committing, setCommitting] = useState<number | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const rows = heals.filter((h) => !done.has(h.stepIndex));
  if (!flowId || rows.length === 0) return null;

  async function commit(h: HealedStep) {
    setCommitting(h.stepIndex);
    setNote(null);
    try {
      const r = await api<RepairInfo>(`/v1/flows/${flowId}/repairs`, {
        method: "POST",
        body: JSON.stringify({
          runId,
          stepIndex: h.stepIndex,
          failure: h.failure,
          fromSelector: h.originalSelector,
          toSelector: h.repairedSelector ?? h.originalSelector,
        }),
      });
      setDone((prev) => new Set(prev).add(h.stepIndex));
      setNote(`Step ${h.stepIndex} committed as v${r.version} — the flow now carries the repaired selector.`);
      markAction("create_flow");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(null);
    }
  }

  return (
    <div className="border border-foreground/25">
      <div className="flex items-center justify-between border-b border-foreground/25 px-3 py-2">
        <span className="text-xs uppercase tracking-widest">Self-heal review</span>
        <span className="text-xs text-foreground/60">
          {rows.length} awaiting review
        </span>
      </div>
      <div className="divide-y divide-foreground/10">
        {rows.map((h) => (
          <div key={h.stepIndex} className="px-3 py-2 text-xs">
            <p className="font-medium">
              Step {h.stepIndex} — healed automatically
            </p>
            <p className="mt-1 text-foreground/60">
              <span className="font-medium">Failure:</span> {h.failure}
            </p>
            <div className="mt-1 grid gap-1 font-mono">
              {h.originalSelector ? (
                <p className="text-red-700 line-through dark:text-red-400">− {h.originalSelector}</p>
              ) : (
                <p className="text-foreground/50">− (original selector not recorded)</p>
              )}
              <p className="text-green-700 dark:text-green-400">
                + {h.repairedSelector ?? "(agent recovered without a selector)"}
              </p>
            </div>
            <button
              type="button"
              className="mt-2 border border-foreground/30 px-2 py-1 text-[11px] uppercase tracking-wider hover:bg-foreground hover:text-background"
              disabled={committing !== null}
              onClick={() => commit(h)}
            >
              {committing === h.stepIndex ? "Committing…" : "Commit repair into flow"}
            </button>
          </div>
        ))}
      </div>
      {note ? <p className="border-t border-foreground/10 px-3 py-2 text-xs text-foreground/70">{note}</p> : null}
    </div>
  );
}
