"use client";

import { useEffect, useMemo, useState } from "react";
import { actionTypeOf, type TraceSpan, type TraceStep } from "@/lib/ai-trace";

export interface ScrubberProps {
  steps: TraceStep[];
  spans: TraceSpan[];
  screenshots: string[];
}

interface StepSlice {
  index: number;
  type: string;
  status: string;
  ok: boolean | undefined;
  error?: string;
  screenshot?: string;
  spans: TraceSpan[];
  detail: string;
}

const SPAN_COLORS: Record<string, string> = {
  OBSERVE: "bg-secondary",
  DECIDE: "bg-primary",
  GUARD: "bg-accent",
  ACT: "bg-foreground",
  VERIFY: "bg-chart-2",
  RETRY: "bg-chart-4",
  HUMAN: "bg-chart-5",
};

function statusMark(step: StepSlice): string {
  if (step.ok === false) return "×";
  if (step.ok === true) return "·";
  return " ";
}

/**
 * Post-hoc trace-viewer scrubber (spec H4): timeline strip of steps along the
 * bottom synced to a preview pane showing screenshot + action + spans for the
 * selected step — a video-editor scrubber driven by the run's spans/events.
 */
export function TraceScrubber({ steps, spans, screenshots }: ScrubberProps) {
  const slices = useMemo<StepSlice[]>(() => {
    return steps.map((step) => {
      const stepSpans = spans.filter(
        (s) => (s.attributes as { stepIndex?: number } | undefined)?.stepIndex === step.index,
      );
      const failed = stepSpans.find((s) => s.ok === false);
      const verify = stepSpans.find((s) => s.kind === "VERIFY");
      const shot = screenshots[step.index];
      return {
        index: step.index,
        type: actionTypeOf(step.action),
        status: step.status,
        ok: failed ? false : verify ? verify.ok : step.status === "ok" ? true : undefined,
        error: failed?.error,
        screenshot: shot,
        spans: stepSpans,
        detail:
          verify && typeof verify.attributes?.detail === "string"
            ? String(verify.attributes.detail)
            : (failed?.error ?? step.status),
      };
    });
  }, [steps, spans, screenshots]);

  const shots = useMemo(
    () =>
      slices
        .map((s) => ({ index: s.index, screenshot: s.screenshot }))
        .filter((s): s is { index: number; screenshot: string } => typeof s.screenshot === "string"),
    [slices],
  );

  const [cursor, setCursor] = useState(0);

  // Keep the cursor on a valid step if the trace changes.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, slices.length - 1)));
  }, [slices.length]);

  if (slices.length === 0) {
    return <p className="empty">No step events on this run — nothing to scrub.</p>;
  }

  const current = slices[Math.min(cursor, slices.length - 1)];
  const failedCount = slices.filter((s) => s.ok === false).length;

  return (
    <section aria-label="Trace scrubber">
      <div className="grid border border-foreground/25 lg:grid-cols-[1fr_22rem]">
        <div className="border-b border-foreground/25 bg-muted p-4 lg:border-b-0 lg:border-r">
          {current.screenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current.screenshot}
              alt={`step ${current.index} screenshot`}
              className="max-h-72 w-full object-contain"
            />
          ) : (
            <div className="flex h-48 items-center justify-center border border-foreground/15 text-xs uppercase">
              no screenshot for step {current.index}
            </div>
          )}
        </div>
        <div className="p-4">
          <p className="font-mono text-[10px] uppercase">
            step {current.index} · {current.type}
          </p>
          <p className="mt-2 text-2xl">
            {current.ok === false ? "Failed" : current.ok === true ? "Ok" : current.status}
          </p>
          <p className="mt-2 max-w-xs text-sm text-foreground/65">{current.detail}</p>
          <ul className="mt-4 space-y-1 font-mono text-[10px] uppercase">
            {current.spans.length === 0 ? (
              <li className="text-foreground/50">no spans at this step</li>
            ) : (
              current.spans.map((s, i) => (
                <li key={`${s.kind}-${i}`}>
                  <span className={`mr-2 inline-block h-2 w-2 ${SPAN_COLORS[s.kind] ?? "bg-muted-foreground"}`} />
                  {s.kind}
                  {s.ok === false ? " · fail" : s.ok === true ? " · ok" : ""}
                  {s.error ? ` — ${s.error}` : ""}
                </li>
              ))
            )}
          </ul>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setCursor((c) => Math.max(0, c - 1))}
              disabled={cursor === 0}
            >
              ‹ Prev
            </button>
            <button
              type="button"
              onClick={() => setCursor((c) => Math.min(slices.length - 1, c + 1))}
              disabled={cursor >= slices.length - 1}
            >
              Next ›
            </button>
            {failedCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  const i = slices.findIndex((s) => s.ok === false);
                  if (i >= 0) setCursor(i);
                }}
              >
                First failure
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Timeline strip: one segment per step; hover/click to scrub. */}
      <div
        className="flex w-full border border-t-0 border-foreground/25"
        role="slider"
        aria-label="Step timeline"
        aria-valuemin={0}
        aria-valuemax={slices.length - 1}
        aria-valuenow={cursor}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, c - 1));
          if (e.key === "ArrowRight") setCursor((c) => Math.min(slices.length - 1, c + 1));
        }}
      >
        {slices.map((s, i) => (
          <button
            key={s.index}
            type="button"
            title={`step ${s.index} · ${s.type} · ${s.ok === false ? "failed" : s.ok === true ? "ok" : s.status}`}
            onClick={() => setCursor(i)}
            className={`group relative h-8 min-w-4 flex-1 border-r border-foreground/15 last:border-r-0 ${
              i === cursor ? "ring-2 ring-inset ring-primary" : ""
            } ${SPAN_COLORS[s.spans[0]?.kind ?? "OBSERVE"] ?? "bg-muted"} ${s.ok === false ? "opacity-100" : "opacity-60 hover:opacity-90"}`}
          >
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] text-background mix-blend-difference">
              {statusMark(s)}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-1 font-mono text-[10px] uppercase text-foreground/60">
        {slices.length} steps · {failedCount} failed · arrow keys scrub
      </p>

      {/* Filmstrip: every step's screenshot at a glance, in order. */}
      {shots.length > 0 ? (
        <>
          <p className="mt-4 font-mono text-[10px] uppercase text-foreground/60">Filmstrip</p>
          <div className="flex gap-1 overflow-x-auto border border-foreground/25 p-1">
            {shots.map(({ index, screenshot }) => {
              const slice = slices[index];
              return (
                <button
                  key={index}
                  type="button"
                  title={`step ${index} · ${slice.type} · ${slice.ok === false ? "failed" : slice.ok === true ? "ok" : slice.status}`}
                  onClick={() => setCursor(index)}
                  className={`relative w-28 shrink-0 border border-foreground/15 ${
                    index === cursor ? "ring-2 ring-inset ring-primary" : ""
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={screenshot} alt={`step ${index} screenshot`} className="h-16 w-28 object-cover" />
                  <span
                    className={`absolute bottom-0 left-0 bg-background/80 px-1 font-mono text-[9px] uppercase ${
                      slice.ok === false ? "text-destructive" : ""
                    }`}
                  >
                    {index} {slice.ok === false ? "×" : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1 font-mono text-[10px] uppercase text-foreground/60">
            {shots.length} of {slices.length} steps have screenshots · click a frame to scrub
          </p>
        </>
      ) : null}
    </section>
  );
}
