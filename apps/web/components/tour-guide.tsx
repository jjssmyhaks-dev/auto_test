"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export interface TourStep {
  /** Route the step is shown on. The tour navigates there if needed. */
  path: string;
  /** CSS selector for the element to spotlight; falls back to a centered card. */
  target?: string;
  /** Short kicker, e.g. "01 · RUNS". */
  kicker: string;
  title: string;
  body: string;
  /** Optional command shown in a code style at the bottom of the card. */
  cli?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    path: "/runs",
    target: "main h1",
    kicker: "01 · RUNS",
    title: "Queue an objective",
    body:
      "Everything starts with a plain-English objective. Type one here and Veriflow queues a cloud record — the browser harness itself runs from your CLI, keeping the browser (and your credentials) local.",
    cli: "veriflow run \"log in, add an item to the cart, assert the total\"",
  },
  {
    path: "/runs",
    target: "main table",
    kicker: "02 · RUNS",
    title: "Every run keeps its paper trail",
    body:
      "Each row is one execution: status, objective, when it ran, and what it cost. Click a run to open its trace.",
  },
  {
    path: "/runs/:first",
    target: '[aria-label="Trace scrubber"]',
    kicker: "03 · SCRUBBER",
    title: "Scrub the run like a video",
    body:
      "This is the evidence: a timeline of steps synced to screenshots, the action taken, guard verdicts, and what VERIFY checked at each step. Arrow keys scrub; the filmstrip below shows every screenshot at a glance.",
  },
  {
    path: "/flows",
    kicker: "04 · FLOWS",
    title: "Save flows, re-run them",
    body:
      "Every run automatically saves its objective as a Flow. Re-run a flow to regression-check it later, or import existing Playwright tests so migration doesn't start from zero.",
    cli: "veriflow import --from playwright ./checkout.spec.ts",
  },
  {
    path: "/evidence",
    kicker: "05 · EVIDENCE",
    title: "Shareable evidence packs",
    body:
      "Non-technical teammates can open a packed run — screenshots, traces, network, console — without installing anything. Secrets are redacted before anything leaves your machine.",
    cli: "veriflow trace <run-id>",
  },
  {
    path: "/agent-test",
    kicker: "06 · AGENT TESTS",
    title: "Test your chat agents too",
    body:
      "Point Veriflow at any chat endpoint and it holds real multi-turn conversations, scoring hallucination, task completion, context retention, and tone — then issues a Green / Yellow / Red go-live verdict.",
    cli: "veriflow agent-test --endpoint http://localhost:8788/chat",
  },
  {
    path: "/usage",
    kicker: "07 · USAGE",
    title: "Cloud is optional — and metered honestly",
    body:
      "Local runs are unlimited and free. Cloud quotas only count synced runs, and the usage ledger shows exactly what was consumed. Alerts fire if spend or failure rate drifts.",
  },
  {
    path: "/runs",
    target: "header nav",
    kicker: "08 · MCP",
    title: "Let coding agents call Veriflow",
    body:
      "The same engine is exposed over MCP: run_flow, get_run, get_trace, export_playwright, list_flows. Claude Code or Cursor can verify their own work mid-session without leaving the chat.",
    cli: "npx @veriflow/mcp --stdio",
  },
];

const TOUR_KEY = "veriflow_tour_done";

export function TourGuide() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const step = TOUR_STEPS[index];
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
  }, []);

  // Expose start to the header button and auto-start for first-time visitors.
  useEffect(() => {
    (window as unknown as { __veriflowTour?: { start: () => void } }).__veriflowTour = { start };
    if (typeof window !== "undefined" && !localStorage.getItem(TOUR_KEY)) {
      start();
      localStorage.setItem(TOUR_KEY, "1");
    }
  }, [start]);

  const targetSelector = step.target;
  useEffect(() => {
    if (!active || !targetSelector) {
      setBox(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(targetSelector);
      if (!el) {
        setBox(null);
        return;
      }
      // Bring the target into view so the spotlight is actually visible.
      const r0 = el.getBoundingClientRect();
      if (r0.bottom < 80 || r0.top > window.innerHeight - 80) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      }
      const r = el.getBoundingClientRect();
      setBox({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    measure();
    // Re-measure as layout settles (fonts, data loading) and on resize.
    const timers = [50, 300, 900].map((ms) => window.setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", measure);
    };
  }, [active, targetSelector, index]);

  const finish = useCallback(() => {
    setActive(false);
    localStorage.setItem(TOUR_KEY, "1");
  }, []);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(TOUR_STEPS.length - 1, next));
      setIndex(clamped);
      const target = TOUR_STEPS[clamped];
      // "/runs/:first" means "the most recent run's detail page" when one exists.
      let path = target.path;
      if (path === "/runs/:first") {
        const firstRun = document.querySelector<HTMLAnchorElement>("main table tbody a");
        path = firstRun?.getAttribute("href") ?? "/runs";
      }
      if (window.location.pathname !== path) router.push(path);
    },
    [router],
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight") go(index + 1);
      if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, index, go, finish]);

  const progress = useMemo(() => `${index + 1} / ${TOUR_STEPS.length}`, [index]);

  if (!active || !step) return null;

  const cardStyle: React.CSSProperties = box
    ? // Prefer the side with more room, then clamp into the viewport so the
      // card is always on-screen even for tall spotlight targets.
      box.y > vh / 2
      ? { left: box.x, top: Math.max(12, box.y - 16), transform: "translateY(-100%)" }
      : { left: box.x, top: Math.min(box.y + box.h + 16, vh - 240) }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  return (
    <>
      {/* Spotlight + click-blocking backdrop */}
      <div
        className="fixed inset-0 z-[90] bg-background/70"
        onClick={finish}
        role="presentation"
      />
      {box ? (
        <div
          className="pointer-events-none fixed z-[91] border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }}
        />
      ) : null}

      {/* Step card */}
      <aside
        aria-label="Product tour"
        className="fixed z-[92] max-w-md border border-foreground/25 bg-background p-5"
        style={{ ...cardStyle, maxHeight: vh - 24, overflowY: "auto" }}
      >
        <p className="font-mono text-[10px] uppercase text-foreground/60">{step.kicker}</p>
        <h2 className="mt-2 text-2xl leading-tight">{step.title}</h2>
        <p className="mt-2 text-sm text-foreground/80">{step.body}</p>
        {step.cli ? (
          <pre className="mt-3 overflow-x-auto border border-foreground/15 bg-muted p-2 font-mono text-[11px]">
            {step.cli}
          </pre>
        ) : null}
        <div className="mt-4 flex items-center gap-2">
          <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>
            ‹ Back
          </button>
          {index < TOUR_STEPS.length - 1 ? (
            <button type="button" onClick={() => go(index + 1)}>
              Next ›
            </button>
          ) : (
            <button type="button" onClick={finish}>
              Finish
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] uppercase text-foreground/60">
            {progress} · {pathname === step.path ? "here" : `→ ${step.path}`}
          </span>
        </div>
      </aside>
    </>
  );
}

/** Header button: restarts the tour on demand. */
export function TourButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <button
      type="button"
      className="font-mono text-[10px] uppercase"
      onClick={() => {
        localStorage.removeItem(TOUR_KEY);
        (window as unknown as { __veriflowTour?: { start: () => void } }).__veriflowTour?.start();
      }}
      style={{ visibility: mounted ? "visible" : "hidden" }}
    >
      ? Tour
    </button>
  );
}
