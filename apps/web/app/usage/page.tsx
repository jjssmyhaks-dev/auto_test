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

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api<Usage>("/v1/usage")
      .then(setUsage)
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
    <AppPage kicker="Usage" title="Free, Starter, Team.">
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
    </AppPage>
  );
}
