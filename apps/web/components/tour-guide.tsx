"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";

export interface TourWait {
  /** Selector the action must happen inside. */
  selector: string;
  /** DOM event that counts as performing the action. */
  event: "click" | "input" | "change";
  /** Instruction shown while waiting, e.g. "Type an objective in the box". */
  hint: string;
}

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
  /** In interactive mode, the real user action this step waits for. */
  waitFor?: TourWait;
}

export const TOUR_STEPS: TourStep[] = [
  {
    path: "/runs",
    target: "main h1",
    kicker: "01 · RUNS",
    title: "Queue an objective",
    body:
      "Everything starts with a plain-English objective. Type one here and Veriflow queues a cloud record — the browser harness itself runs from your CLI, keeping the browser (and your credentials) local.",
    cli: 'veriflow run "log in, add an item to the cart, assert the total"',
    waitFor: { selector: "main textarea", event: "input", hint: "Type an objective in the box below" },
  },
  {
    path: "/runs",
    target: "main table",
    kicker: "02 · RUNS",
    title: "Every run keeps its paper trail",
    body:
      "Each row is one execution: status, objective, when it ran, and what it cost. Click a run to open its trace.",
    waitFor: { selector: "main table tbody a", event: "click", hint: "Open a run from the history" },
  },
  {
    path: "/runs/:first",
    target: '[aria-label="Trace scrubber"]',
    kicker: "03 · SCRUBBER",
    title: "Scrub the run like a video",
    body:
      "This is the evidence: a timeline of steps synced to screenshots, the action taken, guard verdicts, and what VERIFY checked at each step. Arrow keys scrub; the filmstrip below shows every screenshot at a glance.",
    waitFor: {
      selector: '[aria-label="Trace scrubber"]',
      event: "click",
      hint: "Scrub the timeline or click a filmstrip frame",
    },
  },
  {
    path: "/flows",
    kicker: "04 · FLOWS",
    title: "Save flows, re-run them",
    body:
      "Every run automatically saves its objective as a Flow. Re-run a flow to regression-check it later, or import existing Playwright tests so migration doesn't start from zero.",
    cli: "veriflow import --from playwright ./checkout.spec.ts",
    waitFor: { selector: "main table button", event: "click", hint: "Queue a re-run of a flow" },
  },
  {
    path: "/evidence",
    kicker: "05 · EVIDENCE",
    title: "Shareable evidence packs",
    body:
      "Non-technical teammates can open a packed run — screenshots, traces, network, console — without installing anything. Secrets are redacted before anything leaves your machine.",
    cli: "veriflow trace <run-id>",
    waitFor: { selector: "main select", event: "change", hint: "Pick a run to replay its evidence" },
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
  {
    path: "/docs/cli",
    target: "main ol",
    kicker: "09 · DOCS",
    title: "Keep the docs at hand",
    body:
      "The CLI quickstart and MCP setup pages cover everything a human or a coding agent needs to drive Veriflow outside the dashboard. Reach them any time from the completion card or the nav.",
  },
];

const TOUR_KEY = "veriflow_tour_done";
const TOUR_RESUME_KEY = "veriflow_tour_step";
const TOUR_MODE_KEY = "veriflow_tour_mode";

type TourApi = { start: (opts?: { interactive?: boolean; step?: number }) => void };

/** Push tour position to the account when signed in; fire-and-forget. */
function pushTourRemote(step: number | null, mode: "guided" | "interactive") {
  if (typeof window === "undefined" || !getToken()) return;
  api("/v1/progress", {
    method: "PUT",
    body: JSON.stringify({ tourStep: step, tourMode: mode }),
  }).catch(() => {
    // Offline — local resume key remains the fallback.
  });
}

export function TourGuide() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [acted, setActed] = useState(false);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const step = TOUR_STEPS[index];
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  const start = useCallback((opts?: { interactive?: boolean; step?: number }) => {
    const saved = Number.parseInt(localStorage.getItem(TOUR_RESUME_KEY) ?? "0", 10);
    const savedStep = Number.isFinite(saved) ? Math.max(0, Math.min(TOUR_STEPS.length - 1, saved)) : 0;
    setIndex(Math.max(0, Math.min(TOUR_STEPS.length - 1, opts?.step ?? savedStep)));
    const savedMode = localStorage.getItem(TOUR_MODE_KEY) === "interactive";
    setInteractive(opts?.interactive ?? savedMode);
    setActed(false);
    setActive(true);
  }, []);

  // Auto-start/resume: merge local progress with the account's (farthest step
  // wins) so returning users — on any device — continue where they left off.
  useEffect(() => {
    (window as unknown as { __veriflowTour?: TourApi }).__veriflowTour = { start };
    let cancelled = false;
    const localDone = typeof window !== "undefined" && !!localStorage.getItem(TOUR_KEY);
    if (!localDone) {
      const localStep = Number.parseInt(localStorage.getItem(TOUR_RESUME_KEY) ?? "", 10);
      const merge = (remoteStep: number | null, remoteMode: string | null) => {
        if (cancelled) return;
        const base = Number.isFinite(localStep) ? localStep : 0;
        const target = Math.max(0, Math.min(TOUR_STEPS.length - 1, Math.max(base, remoteStep ?? 0)));
        start({ interactive: remoteMode === "interactive" ? true : undefined, step: target });
      };
      if (typeof window !== "undefined" && getToken()) {
        api<{ progress: { tourStep?: number; tourMode?: string } }>("/v1/progress")
          .then(({ progress }) => merge(progress.tourStep ?? null, progress.tourMode ?? null))
          .catch(() => merge(null, null));
      } else {
        merge(null, null);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [start]);

  // Persist progress while the tour is open (locally + to the account) so a
  // reload — or another device — returns to this step.
  useEffect(() => {
    if (active) {
      localStorage.setItem(TOUR_RESUME_KEY, String(index));
      pushTourRemote(index, interactive ? "interactive" : "guided");
    }
  }, [active, index, interactive]);

  // Persist the chosen mode locally.
  useEffect(() => {
    if (active) localStorage.setItem(TOUR_MODE_KEY, interactive ? "interactive" : "guided");
  }, [active, interactive]);

  const targetSelector = step?.target;
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

  // Escape / backdrop = pause: progress is kept, the tour resumes on return.
  const pause = useCallback(() => {
    setActive(false);
  }, []);

  // Reaching the end = done: progress cleared (local + account), no more
  // auto-starts.
  const finish = useCallback(() => {
    setActive(false);
    localStorage.removeItem(TOUR_RESUME_KEY);
    localStorage.setItem(TOUR_KEY, "1");
    pushTourRemote(null, interactive ? "interactive" : "guided");
  }, [interactive]);

  const restart = useCallback(() => {
    localStorage.removeItem(TOUR_RESUME_KEY);
    setIndex(0);
    setActed(false);
    pushTourRemote(0, interactive ? "interactive" : "guided");
  }, [interactive]);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(TOUR_STEPS.length - 1, next));
      setIndex(clamped);
      const target = TOUR_STEPS[clamped];
      // "/runs/:first" means "the most recent run's detail page" when one exists.
      let path = target.path;
      if (path === "/runs/:first") {
        if (/^\/runs\/[^/]+$/.test(window.location.pathname)) {
          // Already on a run detail page (e.g. the user just clicked a run) — stay put.
          path = window.location.pathname;
        } else {
          const firstRun = document.querySelector<HTMLAnchorElement>("main table tbody a");
          path = firstRun?.getAttribute("href") ?? "/runs";
        }
      }
      if (window.location.pathname !== path) router.push(path);
    },
    [router],
  );

  // Interactive mode: listen (capture) for the real user action on this step's
  // target, mark it done, and auto-advance shortly after.
  const waitFor = interactive ? step?.waitFor : undefined;
  useEffect(() => {
    if (!active || !waitFor || acted) return;
    const { selector, event } = waitFor;
    const handler = (e: Event) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function" || !t.closest(selector)) return;
      setActed(true);
    };
    document.addEventListener(event, handler, true);
    return () => document.removeEventListener(event, handler, true);
  }, [active, waitFor, acted]);

  useEffect(() => {
    if (!acted || !active) return;
    const t = window.setTimeout(() => {
      if (index < TOUR_STEPS.length - 1) go(index + 1);
      else finish();
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acted]);

  // Reset the action flag whenever the step or mode changes.
  useEffect(() => setActed(false), [index, interactive]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") pause();
      if (e.key === "ArrowRight" && !(interactive && waitFor && !acted)) go(index + 1);
      if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, index, go, pause, interactive, waitFor, acted]);

  const progress = useMemo(() => `${index + 1} / ${TOUR_STEPS.length}`, [index]);

  if (!active || !step) return null;

  const waiting = interactive && !!waitFor && !acted;
  const cardStyle: React.CSSProperties = box
    ? // Prefer the side with more room, then clamp into the viewport so the
      // card is always on-screen even for tall spotlight targets.
      box.y > vh / 2
      ? { left: box.x, top: Math.max(12, box.y - 16), transform: "translateY(-100%)" }
      : { left: box.x, top: Math.min(box.y + box.h + 16, vh - 240) }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  return (
    <>
      {/* Spotlight + click-blocking backdrop. In interactive mode the page stays
          live so the user can actually perform the step's action. */}
      <div
        className="fixed inset-0 z-[90] bg-background/70"
        style={{ pointerEvents: interactive ? "none" : "auto" }}
        onClick={interactive ? undefined : pause}
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
        {interactive && waitFor ? (
          <p className="mt-3 border border-primary/40 bg-primary/5 p-2 font-mono text-[11px] uppercase text-primary">
            {acted ? "✓ done — advancing…" : `Your turn: ${waitFor.hint}`}
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-2">
          <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>
            ‹ Back
          </button>
          {index < TOUR_STEPS.length - 1 ? (
            <button type="button" onClick={() => go(index + 1)} disabled={waiting}>
              {waiting ? "Waiting…" : "Next ›"}
            </button>
          ) : (
            <button type="button" onClick={finish} disabled={waiting}>
              {waiting ? "Waiting…" : "Finish"}
            </button>
          )}
          <button
            type="button"
            className="ml-2 font-mono text-[10px] uppercase"
            onClick={() => setInteractive((v) => !v)}
          >
            {interactive ? "Guided mode" : "Try it"}
          </button>
          <button
            type="button"
            className="ml-2 font-mono text-[10px] uppercase"
            onClick={restart}
            disabled={index === 0}
          >
            ↺ Restart
          </button>
          <span className="ml-auto font-mono text-[10px] uppercase text-foreground/60">
            {progress} · {pathname === step.path || (step.path === "/runs/:first" && /^\/runs\/[^/]+$/.test(pathname)) ? "here" : `→ ${step.path}`}
          </span>
        </div>
      </aside>
    </>
  );
}

/** Header buttons: restart or resume the tour on demand. */
export function TourButton({ interactive = false }: { interactive?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [resumable, setResumable] = useState(false);
  useEffect(() => {
    setMounted(true);
    setResumable(!!localStorage.getItem(TOUR_RESUME_KEY) && !localStorage.getItem(TOUR_KEY));
  }, []);
  return (
    <button
      type="button"
      className="font-mono text-[10px] uppercase"
      onClick={() => {
        localStorage.removeItem(TOUR_KEY);
        setResumable(false);
        (window as unknown as { __veriflowTour?: TourApi }).__veriflowTour?.start({ interactive });
      }}
      style={{ visibility: mounted ? "visible" : "hidden" }}
    >
      {interactive ? "? Try it" : resumable ? "? Resume tour" : "? Tour"}
    </button>
  );
}
