"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { markAction } from "@/lib/onboarding";

type Alert = { kind: string; severity: string; message: string; value?: number };
type Rule = { id: string; metric: string; threshold: number; channel: string; lastTriggeredAt?: string };

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [delivery, setDelivery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"success_rate" | "cost_spike">("success_rate");
  const [threshold, setThreshold] = useState("0.8");
  const [channel, setChannel] = useState("slack:");
  const [note, setNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  function load() {
    api<{ alerts: Alert[]; rules?: Rule[]; delivery: string }>('/v1/alerts')
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
        body: JSON.stringify({ metric, threshold: value, channel }),
      });
      setNote(`rule saved: ${metric} @ ${value} → ${channel}`);
      markAction("create_alert_rule");
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

  async function sendTest() {
    setTestResult(null);
    try {
      const res = await api<{
        result: { status: string; kind: string; attempts: number; error?: string };
      }>("/v1/alerts/test", {
        method: "POST",
        body: JSON.stringify({ channel }),
      });
      const r = res.result;
      setTestResult(
        r.status === "delivered"
          ? `Delivered to ${r.kind} after ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}.`
          : r.status === "skipped"
            ? `Skipped — ${r.error ?? "channel not configured"}`
            : `Failed — ${r.error ?? "unknown error"} (after ${r.attempts} attempts)`,
      );
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
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
    <AppPage
      kicker="Alerts"
      title="Cost and success rate."
      hint={{
        steps: [
          "Rules watch per-flow reliability — e.g. fire when success drops below 50% or cost spikes.",
          "Each rule delivers to its own channel: email:<address>, slack:<webhook-url>, or webhook:<url>.",
          "Email needs VERIFLOW_SMTP_URL or VERIFLOW_EMAIL_ENDPOINT on the server; delivery retries 3× with backoff.",
        ],
      }}
    >
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
      <label>
        Deliver to
        <select value={channel.startsWith("email:") ? "email" : channel.startsWith("slack:") ? "slack" : "webhook"} onChange={(e) => setChannel(`${e.target.value}:`)}>
          <option value="slack">Slack (VERIFLOW_SLACK_WEBHOOK)</option>
          <option value="email">Email (per-rule address)</option>
          <option value="webhook">Generic webhook</option>
        </select>
      </label>
      {channel.startsWith("email:") ? (
        <label>
          Email address
          <input
            value={channel.slice("email:".length)}
            placeholder="ops@acme.dev"
            onChange={(e) => setChannel(`email:${e.target.value}`)}
          />
        </label>
      ) : null}
      {channel.startsWith("slack:") || channel.startsWith("webhook:") ? (
        <label>
          Webhook URL (blank = server env default)
          <input
            value={channel.slice(channel.indexOf(":") + 1)}
            placeholder="https://hooks.slack.com/services/…"
            onChange={(e) => setChannel(`${channel.slice(0, channel.indexOf(":") + 1)}${e.target.value}`)}
          />
        </label>
      ) : null}
      <button type="button" onClick={addRule}>
        Add rule
      </button>
      {" "}
      <button type="button" className="secondary" onClick={sendTest}>
        Send test notification
      </button>
      {testResult ? <p className="empty">Test: {testResult}</p> : null}
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
