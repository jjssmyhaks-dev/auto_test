"use client";

import { useEffect, useState } from "react";
import { TOUR_STEPS } from "@/components/tour-guide";
import { useOnboarding } from "@/lib/onboarding";

const PROMPTED_KEY = "veriflow_tryit_prompted";

/** The tour step that lives on the docs pages (last step). */
const DOCS_STEP = Math.max(0, TOUR_STEPS.findIndex((s) => s.path === "/docs/cli"));

/**
 * One-time prompt on the CLI/MCP docs pages once the onboarding checklist
 * hits 4/4: offers to launch the guided tour in interactive "Try it" mode,
 * starting at the docs step. Dismissing (or launching) sets a flag so it
 * never nags again; Settings → Reset onboarding clears it too.
 */
export function TryItPrompt() {
  const { done } = useOnboarding();
  const [show, setShow] = useState(false);

  const complete = ["queue_run", "scrub_trace", "create_flow", "create_alert_rule"].every((k) => done[k as keyof typeof done]);

  useEffect(() => {
    if (complete && typeof window !== "undefined" && !localStorage.getItem(PROMPTED_KEY)) {
      setShow(true);
    }
  }, [complete]);

  if (!show) return null;

  function launch() {
    localStorage.setItem(PROMPTED_KEY, "1");
    setShow(false);
    (window as unknown as { __veriflowTour?: { start: (opts?: { interactive?: boolean; step?: number }) => void } })
      .__veriflowTour?.start({ interactive: true, step: DOCS_STEP });
  }

  function dismiss() {
    localStorage.setItem(PROMPTED_KEY, "1");
    setShow(false);
  }

  return (
    <div
      data-tryit-prompt
      className="mt-4 border border-primary bg-primary/5 px-4 py-3"
      role="region"
      aria-label="Try-it mode available"
    >
      <p className="font-mono text-[10px] uppercase text-primary">Onboarding complete · 4/4</p>
      <p className="mt-1 text-sm text-foreground/85">
        You've done all four key actions. Want to see how the CLI and the coding-agent side fit
        together? Take the two-minute tour in Try-it mode — it waits while you actually do each step.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={launch}>
          ▶ Try it on this page
        </button>
        <button type="button" className="secondary" onClick={dismiss}>
          Maybe later
        </button>
      </div>
    </div>
  );
}
