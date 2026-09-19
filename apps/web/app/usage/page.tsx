"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Usage = {
  tier: string;
  quota: { runsPerMonth: number; label: string };
  used: number;
  remaining: number;
  ledger: { kind: string; amount: number; unit: string; createdAt: string; runId?: string }[];
};

type Funnel = {
  total: number;
  completedAll: number;
  steps: { action: string; count: number; pct: number }[];
};

const FUNNEL_LABELS: Record<string, string> = {
  queue_run: "Queue a run",
  scrub_trace: "Scrub a trace",
  create_flow: "Save a flow",
  create_alert_rule: "Create an alert rule",
};

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api<Usage>("/v1/usage")
      .then((u) => {
        setUsage(u);
        // Funnel is team-gated; skip the call (and the 403 noise) for other tiers.
        if (u.tier === "team") api<Funnel>("/v1/onboarding/funnel").then(setFunnel).catch(() => {});
      })
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function upgrade(tier: string) {
    const res = await api<{ status: string; user?: { tier: string } }>("/v1/billing/upgrade", {
      method: "POST",
      body: JSON.stringify({ tier }),
    });
    setNote(`Upgrade ${res.status} → ${res.user?.tier ?? tier}`);
    load();
  }

  if (error) {
    return (
      <AppPage kicker="Usage" title="Free, Starter, Team.">
        <p className="error">{error}</p>
      </AppPage>
    );
  }
  if (!usage) {
    return (
      <AppPage kicker="Usage" title="Free, Starter, Team.">
        <p className="empty">Loading usage…</p>
      </AppPage>
    );
  }

  return (
    <AppPage
      kicker="Usage"
      title="Free, Starter, Team."
      hint={{
        steps: [
          "Runs and agent-tests consume quota; every event writes to the ledger below.",
          "Alert rules fire on cost spikes or success-rate drops before you burn the month's quota.",
        ],
      }}
    >
      <p>
        Plan <strong>{usage.quota.label}</strong> — {usage.used} / {usage.quota.runsPerMonth} cloud runs this
        month ({usage.remaining} remaining).
      </p>
      <div className="row">
        <button type="button" onClick={() => upgrade("starter")}>
          Upgrade to Starter (simulated)
        </button>
        <button type="button" className="secondary" onClick={() => upgrade("team")}>
          Upgrade to Team (simulated)
        </button>
      </div>
      {note ? <p>{note}</p> : null}
      <h2>Ledger</h2>
      {usage.ledger.length === 0 ? (
        <p className="empty">No usage yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Amount</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {usage.ledger.map((row, i) => (
              <tr key={i}>
                <td>{row.kind}</td>
                <td>
                  {row.amount} {row.unit}
                </td>
                <td>{row.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {funnel ? (
        <section aria-label="Activation funnel">
          <h2>Activation funnel</h2>
          <p className="text-sm text-foreground/70">
            How many accounts completed each getting-started action{funnel.total ? ` — ${funnel.total} account${funnel.total === 1 ? "" : "s"} with progress so far` : ""}.
          </p>
          {funnel.total === 0 ? (
            <p className="empty">No accounts with onboarding progress yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Accounts</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {funnel.steps.map((s) => (
                  <tr key={s.action}>
                    <td>{FUNNEL_LABELS[s.action] ?? s.action}</td>
                    <td>{s.count}</td>
                    <td>{s.pct}%</td>
                  </tr>
                ))}
                <tr>
                  <td>All four done</td>
                  <td>{funnel.completedAll}</td>
                  <td>{funnel.total === 0 ? 0 : Math.round((funnel.completedAll / funnel.total) * 100)}%</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </AppPage>
  );
}
