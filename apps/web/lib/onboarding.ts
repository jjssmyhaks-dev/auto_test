"use client";

import { useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";

/**
 * First-run onboarding checklist: tracks whether the user has performed the
 * key actions of the product (not just visited the pages). Progress lives in
 * localStorage as cache/fallback and, when the user is signed in, syncs to
 * their account via the API so it follows them across devices.
 */

export type OnboardingAction = "queue_run" | "scrub_trace" | "create_flow" | "create_alert_rule";

export const ONBOARDING_ACTIONS: { key: OnboardingAction; label: string; href: string }[] = [
  { key: "queue_run", label: "Queue a run", href: "/runs" },
  { key: "scrub_trace", label: "Scrub a trace", href: "/runs" },
  { key: "create_flow", label: "Save a flow", href: "/flows" },
  { key: "create_alert_rule", label: "Create an alert rule", href: "/alerts" },
];

const KEY = "veriflow_onboarding";

interface OnboardingState {
  done: Partial<Record<OnboardingAction, boolean>>;
  dismissed: boolean;
}

function readLocal(): OnboardingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OnboardingState>;
    return { done: parsed.done ?? {}, dismissed: parsed.dismissed ?? false };
  } catch {
    return { done: {}, dismissed: false };
  }
}

function writeLocal(s: OnboardingState) {
  localStorage.setItem(KEY, JSON.stringify(s));
  listeners.forEach((l) => l());
}

let listeners: (() => void)[] = [];

/** Push progress to the account when signed in; fire-and-forget. */
function pushRemote(s: OnboardingState) {
  if (typeof window === "undefined" || !getToken()) return;
  api("/v1/progress", {
    method: "PUT",
    body: JSON.stringify({
      onboardingDone: Object.keys(s.done).filter((k) => s.done[k as OnboardingAction]),
      onboardingDismissed: s.dismissed,
    }),
  }).catch(() => {
    // Offline or API down — local cache remains the source of truth.
  });
}

/** Pull account progress after login; union with anything done locally. */
export async function syncOnboardingFromAccount(): Promise<OnboardingState> {
  const local = readLocal();
  try {
    const { progress } = await api<{
      progress: { onboardingDone: string[]; onboardingDismissed: boolean };
    }>("/v1/progress");
    const done: Partial<Record<OnboardingAction, boolean>> = { ...local.done };
    for (const a of progress.onboardingDone) {
      if (a === "queue_run" || a === "scrub_trace" || a === "create_flow" || a === "create_alert_rule") {
        done[a] = true;
      }
    }
    const merged: OnboardingState = {
      done,
      dismissed: local.dismissed || progress.onboardingDismissed,
    };
    writeLocal(merged);
    // Push the union back so the account has everything too.
    pushRemote(merged);
    return merged;
  } catch {
    return local;
  }
}

export function getOnboarding(): OnboardingState {
  return typeof window === "undefined" ? { done: {}, dismissed: false } : readLocal();
}

export function markOnboardingAction(key: OnboardingAction) {
  const s = readLocal();
  if (s.done[key]) return;
  s.done[key] = true;
  writeLocal(s);
  pushRemote(s);
}

export function resetOnboarding() {
  writeLocal({ done: {}, dismissed: false });
  pushRemote({ done: {}, dismissed: false });
}

export function dismissOnboarding() {
  const s = { ...readLocal(), dismissed: true };
  writeLocal(s);
  pushRemote(s);
}

export function onboardingAllDone(): boolean {
  const s = readLocal();
  return ONBOARDING_ACTIONS.every((a) => s.done[a.key]);
}

let pulledThisSession = false;

/** Reactive snapshot for components. Pulls account progress once per session
 *  when signed in, so an already-authed device picks up cross-device changes
 *  without needing a fresh login. */
export function useOnboarding(): OnboardingState {
  const [state, setState] = useState<OnboardingState>({ done: {}, dismissed: false });

  useEffect(() => {
    const sync = () => setState(readLocal());
    sync();
    listeners.push(sync);
    if (!pulledThisSession && getToken()) {
      pulledThisSession = true;
      void syncOnboardingFromAccount();
    }
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
