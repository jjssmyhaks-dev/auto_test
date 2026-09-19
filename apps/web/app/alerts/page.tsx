"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Alert = { kind: string; severity: string; message: string; value?: number };
type Rule = { id: string; metric: string; threshold: number; channel: string; lastTriggeredAt?: string };

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [delivery, setDelivery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"success_rate" | "cost_spike">("success_rate");
  const [threshold, setThreshold] = useState("0.8");
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api<{ alerts: Alert[]; rules?: Rule[]; delivery: string }>("/v1/alerts")
      .then((r) => {
        setAlerts(r.alerts);
        setRules(r.rules ?? []);
        setDelivery(r.delivery);
      })
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function addRule() {
    const value = Number(threshold);
    if (!Number.isFinite(value)) {
      setNote("threshold must be a number");
      return;
    }
    try {
      await api("/v1/alerts/rules", {
        method: "POST",
        body: JSON.stringify({ metric, threshold: value }),
      });
      setNote(`rule saved: ${metric} @ ${value}`);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeRule(id: string) {
    try {
      await api(`/v1/alerts/rules/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

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

      <h2>Alert rules</h2>
      {rules.length === 0 ? (
        <p className="empty">No rules — add one to watch success rate or per-run cost.</p>
      ) : (
        <ul>
          {rules.map((r) => (
            <li key={r.id}>
              <strong>{r.metric}</strong> threshold {r.threshold} · {r.channel}
              {r.lastTriggeredAt ? ` · last fired ${r.lastTriggeredAt}` : ""}{" "}
              <button type="button" onClick={() => removeRule(r.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        Metric
        <select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
          <option value="success_rate">success_rate (alert when pass rate falls below)</option>
          <option value="cost_spike">cost_spike (alert when latest run cost exceeds)</option>
        </select>
      </label>
      <label>
        Threshold
        <input value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <button type="button" onClick={addRule}>
        Add rule
      </button>
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
