"use client";

import { useEffect, useRef, useState } from "react";

export interface PageHintContent {
  /** Ordered walkthrough of this page's workflow. */
  steps: string[];
  /** Optional terminal command the page pairs with. */
  cli?: string;
}

/**
 * Per-page context hint (companion to the guided tour): a small "?" that
 * expands into a mini tooltip explaining THIS page's workflow.
 */
export function PageHint({ hint }: { hint: PageHintContent }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label="Page hint"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-6 w-6 border border-foreground/30 font-mono text-[11px] leading-none text-foreground/70 hover:border-foreground/60"
      >
        ?
      </button>
      {open ? (
        <div
          role="tooltip"
          className="absolute right-0 z-50 mt-2 w-80 border border-foreground/25 bg-background p-4 shadow-lg"
        >
          <p className="font-mono text-[10px] uppercase text-foreground/60">How this page works</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-foreground/85">
            {hint.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {hint.cli ? (
            <pre className="mt-3 overflow-x-auto border border-foreground/15 bg-muted p-2 font-mono text-[11px]">
              {hint.cli}
            </pre>
          ) : null}
          <p className="mt-2 font-mono text-[10px] uppercase text-foreground/50">
            Esc or click away to close
          </p>
        </div>
      ) : null}
    </div>
  );
}
