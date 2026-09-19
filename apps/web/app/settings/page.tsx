"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { ONBOARDING_ACTIONS, resetOnboarding, useOnboarding } from "@/lib/onboarding";



/**
 * Account settings. The reset control clears onboarding progress in BOTH
 * places it lives: the account row (DELETE /v1/progress) and the local
 * cache, so the checklist and completion state genuinely start over.
 */
export default function SettingsPage() {
  const { done, dismissed } = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const router = useRouter();

  const completed = ONBOARDING_ACTIONS.filter((a) => done[a.key]).length;

  async function reset() {
    setBusy(true);
    setNote(null);
    // Clear the account's progress first; wipe the cache even if the API
    // is unreachable (it will re-sync whatever the account still has).
    try {
      await api("/v1/progress", { method: "DELETE" });
      resetOnboarding({ skipRemote: true });
      setNote("Progress cleared — the checklist and tour start over.");
    } catch {
      resetOnboarding();
      setNote("Couldn't reach the API; cleared local progress only.");
    }
    // Also drop the tour's local resume/done flags so it replays from 01.
    localStorage.removeItem("veriflow_tour_done");
    localStorage.removeItem("veriflow_tour_step");
    localStorage.removeItem("veriflow_tour_mode");
    setBusy(false);
    router.refresh();
  }

  // Demo reset: wipe the project's runs, flows, and alert rules (plus their
  // evidence blobs and usage ledger) server-side, then reload so the whole
  // dashboard replays from scratch. Team-gated like the API.
  async function demoReset() {
    if (!window.confirm("Delete all runs, flows, and alert rules for this project? This cannot be undone.")) return;
    setDemoBusy(true);
    setDemoNote(null);
    try {
      const res = await api<{ status: string; runs: number; flows: number; alertRules: number; blobsRemoved: number }>(
        "/v1/demo-reset",
        { method: "POST" },
      );
      setDemoNote(`Cleared ${res.runs} run(s), ${res.flows} flow(s), ${res.alertRules} rule(s), ${res.blobsRemoved} evidence file(s).`);
      router.refresh();
    } catch (e) {
      setDemoNote(e instanceof Error ? e.message : "Demo reset failed.");
    }
    setDemoBusy(false);
  }

  return (
    <AppPage
      kicker="Settings"
      title="Progress, under control."
      hint={{
        steps: [
          "Resetting onboarding clears the checklist, the 4/4 completion state, and the tour's resume point.",
          "Reset affects the account: every signed-in device picks it up on its next sync.",
        ],
      }}
    >
      <section aria-label="Onboarding progress">
        <h2>Onboarding</h2>
        <p>
          {completed} / {ONBOARDING_ACTIONS.length} key actions completed
          {dismissed ? " · checklist dismissed" : ""}.
        </p>
        <p className="text-sm text-foreground/70">
          Resetting re-arms the getting-started checklist and the guided tour — useful for demos or a
          fresh teammate sharing this account. Progress re-accumulates as the actions are performed.
        </p>
        <div className="mt-3 row">
          <button type="button" onClick={reset} disabled={busy}>
            {busy ? "Clearing…" : "Reset onboarding"}
          </button>
        </div>
        {note ? <p className="mt-2">{note}</p> : null}
      </section>
      <section aria-label="Demo data" className="mt-8">
        <h2>Demo data</h2>
        <p className="text-sm text-foreground/70">
          Wipes every run (with steps, spans, and evidence files), flow, alert rule, and usage
          ledger entry for this project, so the dashboard replays from an empty slate. Onboarding
          progress and the tour are kept — reset those separately above. Team tier only.
        </p>
        <div className="mt-3 row">
          <button type="button" className="secondary" onClick={demoReset} disabled={demoBusy}>
            {demoBusy ? "Wiping…" : "Reset demo data"}
          </button>
        </div>
        {demoNote ? <p className="mt-2">{demoNote}</p> : null}
      </section>
    </AppPage>
  );
}
