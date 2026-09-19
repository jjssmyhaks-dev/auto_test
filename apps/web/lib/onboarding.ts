"use client";

import { useEffect, useState } from "react";

/**
 * First-run onboarding checklist: tracks whether the user has performed the
 * key actions of the product (not just visited the pages), persisted in
 * localStorage so progress survives reloads.
 */

export type OnboardingAction = "queue_run" | "scrub_trace" | "create_flow" | "create_alert_rule";

export const ONBOARDING_ACTIONS: { key: OnboardingAction; label: string; href: string }[] = [
  { key: "queue_run", label: "Queue a run", href: "/runs" },
  { key: "scrub_trace", label: "Scrub a trace", href: "/runs" },
  { key: "create_flow", label: "Save a flow", href: "/flows" },
  { key: "create_alert_rule", label: "Create an alert rule", href: "/alerts" },
];

const KEY = "veriflow_onboarding";
const DONE_KEY = "veriflow_onboarding_done";

interface OnboardingState {
  done: Partial<Record<OnboardingAction, boolean>>;
  dismissed: boolean;
}

function read(): OnboardingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OnboardingState>;
    return { done: parsed.done ?? {}, dismissed: parsed.dismissed ?? false };
  } catch {
    return { done: {}, dismissed: false };
  }
}

function write(s: OnboardingState) {
  localStorage.setItem(KEY, JSON.stringify(s));
  listeners.forEach((l) => l());
}

let listeners: (() => void)[] = [];

export function getOnboarding(): OnboardingState {
  return typeof window === "undefined" ? { done: {}, dismissed: false } : read();
}

export function markOnboardingAction(key: OnboardingAction) {
  const s = read();
  if (s.done[key]) return;
  s.done[key] = true;
  write(s);
  if (ONBOARDING_ACTIONS.every((a) => s.done[a.key])) {
    localStorage.setItem(DONE_KEY, "1");
  }
}

export function resetOnboarding() {
  write({ done: {}, dismissed: false });
  localStorage.removeItem(DONE_KEY);
}

export function dismissOnboarding() {
  write({ ...read(), dismissed: true });
}

export function onboardingAllDone(): boolean {
  const s = read();
  return ONBOARDING_ACTIONS.every((a) => s.done[a.key]);
}

/** Reactive snapshot for components. */
export function useOnboarding(): { done: Partial<Record<OnboardingAction, boolean>>; dismissed: boolean } {
  const [state, setState] = useState<OnboardingState>({ done: {}, dismissed: false });

  useEffect(() => {
    const sync = () => setState(read());
    sync();
    listeners.push(sync);
    return () => {
      listeners = listeners.filter((l) => l !== sync);
    };
  }, []);

  return state;
}

/** Fire-and-forget helper safe to call from any handler. */
export function markAction(key: OnboardingAction) {
  try {
    markOnboardingAction(key);
  } catch {
    // storage unavailable — onboarding is best-effort
  }
}
