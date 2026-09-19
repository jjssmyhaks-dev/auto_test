"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ONBOARDING_ACTIONS,
  dismissOnboarding,
  onboardingAllDone,
  useOnboarding,
} from "@/lib/onboarding";

/**
 * First-run checklist widget: lives at the top of /runs until all four key
 * actions are done or the user dismisses it.
 */
export function OnboardingChecklist() {
  const { done, dismissed } = useOnboarding();

  // Hydration-safe: first client render shows nothing, then it appears.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || dismissed) return null;

  const total = ONBOARDING_ACTIONS.length;
  const completed = ONBOARDING_ACTIONS.filter((a) => done[a.key]).length;
  const complete = completed === total;

  if (complete) {
    return (
      <div
        data-onboarding
        className="mb-6 border border-primary bg-primary/5"
        role="region"
        aria-label="Getting started complete"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/20 px-4 py-3">
          <p className="font-mono text-[10px] uppercase text-primary">
            Getting started · 4/4 ✓ You're set
          </p>
          <button type="button" className="font-mono text-[10px] uppercase" onClick={dismissOnboarding}>
            Dismiss
          </button>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-foreground/85">
            You've queued a run, scrubbed a trace, saved a flow, and set an alert. Two places to go
            from here:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/docs/cli"
              className="border border-foreground/25 px-3 py-1.5 font-mono text-[10px] uppercase no-underline"
            >
              CLI quickstart →
            </Link>
            <Link
              href="/docs/mcp"
              className="border border-foreground/25 px-3 py-1.5 font-mono text-[10px] uppercase no-underline"
            >
              MCP setup →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-onboarding
      className="mb-6 border border-foreground/25 bg-muted/40"
      role="region"
      aria-label="Getting started"
    >
      <div className="flex items-center justify-between border-b border-foreground/15 px-4 py-3">
        <p className="font-mono text-[10px] uppercase text-foreground/70">
          Getting started · {completed}/{total}
        </p>
        <button type="button" className="font-mono text-[10px] uppercase" onClick={dismissOnboarding}>
          Dismiss
        </button>
      </div>
      <ul className="divide-y divide-foreground/10">
        {ONBOARDING_ACTIONS.map((a) => {
          const isDone = !!done[a.key];
          return (
            <li key={a.key} className="flex items-center gap-3 px-4 py-2.5">
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] leading-none ${
                  isDone ? "border-primary bg-primary text-background" : "border-foreground/40"
                }`}
              >
                {isDone ? "✓" : ""}
              </span>
              {isDone ? (
                <span className="text-sm text-foreground/60 line-through">{a.label}</span>
              ) : (
                <Link href={a.href} className="text-sm no-underline">
                  {a.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
