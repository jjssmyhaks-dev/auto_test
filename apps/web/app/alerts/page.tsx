"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Alert = { kind: string; severity: string; message: string; value?: number };

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [delivery, setDelivery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ alerts: Alert[]; delivery: string }>("/v1/alerts")
      .then((r) => {
        setAlerts(r.alerts);
        setDelivery(r.delivery);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <AppPage kicker="Alerts" title="Cost and success rate.">
        <p className="error">{error}</p>
      </AppPage>
    );
  }
  if (!alerts) {
    return (
      <AppPage kicker="Alerts" title="Cost and success rate.">
        <p className="empty">Loading alerts…</p>
      </AppPage>
    );
  }

  return (
    <AppPage kicker="Alerts" title="Cost and success rate.">
      <p className="empty">Delivery: {delivery} (cost_spike / success_rate)</p>
      {alerts.length === 0 ? (
        <p>No alerts on recent cloud runs.</p>
      ) : (
        <ul>
          {alerts.map((a, i) => (
            <li key={i}>
              <strong>{a.severity}</strong> {a.kind}: {a.message}
            </li>
          ))}
        </ul>
      )}
    </AppPage>
  );
}
