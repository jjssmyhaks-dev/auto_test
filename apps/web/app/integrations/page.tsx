"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Webhook = { id: string; url: string; events: string[]; secretHint?: string; lastDeliveryOk?: boolean; lastDeliveryAt?: string };
type AuditEntry = { id: string; actor: string; action: string; target?: string; detail?: Record<string, unknown>; createdAt: string };

/**
 * Integrations: outbound signed webhooks (HMAC, retried) and the audit log
 * (who changed what). Both are per-project, read through the cloud API.
 */
export default function IntegrationsPage() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [url, setUrl] = useState("");
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ webhooks: Webhook[] }>("/v1/webhooks")
      .then((r) => setHooks(r.webhooks))
      .catch((e: Error) => setError(e.message));
    api<{ entries: AuditEntry[] }>("/v1/audit?limit=50")
      .then((r) => setAudit(r.entries))
      .catch(() => setAudit([]));
  }

  useEffect(() => {
    load();
  }, []);

  async function createHook() {
    if (!url.startsWith("http")) return setNote("enter an https:// URL");
    try {
      const r = await api<{ webhook: { secret: string } }>("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, events: ["*"] }),
      });
      setSecretOnce(r.webhook.secret);
      setUrl("");
      setNote("webhook created — copy the secret now, it is shown only once");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeHook(id: string) {
    try {
      await api(`/v1/webhooks/${id}`, { method: "DELETE" });
      setNote("webhook deleted");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function testHooks() {
    try {
      const r = await api<{ results: { url: string; ok: boolean; attempts: number; error?: string }[] }>("/v1/webhooks/test", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setNote(
        r.results.length === 0
          ? "no webhooks configured yet"
          : r.results.map((x) => `${x.url} → ${x.ok ? "delivered" : `failed (${x.error})`} in ${x.attempts} attempt(s)`).join("; "),
      );
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <AppPage kicker="Integrations" title="Webhooks out, audit trail in.">
        <p className="error">{error}. <a href="/login">Sign in</a> first.</p>
      </AppPage>
    );
  }

  return (
    <AppPage
      kicker="Integrations"
      title="Webhooks out, audit trail in."
      hint={{
        steps: [
          "Webhooks push run.passed / run.failed / pause.created to your URL, signed with HMAC-SHA256 (veriflow-signature header) and retried 3×.",
          "The secret is shown once at creation — store it in your receiver to verify signatures.",
          "The audit log records every flow edit, rollback, member change, key mint, and purge — queryable, append-only.",
        ],
      }}
    >
      <h2>Outbound webhooks</h2>
      {hooks === null ? (
        <p className="empty">Loading…</p>
      ) : hooks.length === 0 ? (
        <p className="empty">No webhooks yet — add one to get push events.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Events</th>
              <th>Secret</th>
              <th>Last delivery</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id}>
                <td className="font-mono text-[10px]">{h.url}</td>
                <td>{h.events.join(", ")}</td>
                <td className="font-mono text-[10px]">{h.secretHint}</td>
                <td>{h.lastDeliveryOk === undefined ? "—" : h.lastDeliveryOk ? "ok" : "failed"}</td>
                <td>
                  <button type="button" onClick={() => removeHook(h.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/veriflow" />
        <button type="button" onClick={createHook}>
          Add webhook
        </button>
        <button type="button" onClick={testHooks}>
          Send test event
        </button>
      </div>
      {secretOnce ? (
        <p className="font-mono text-xs">
          Secret (copy now, shown once): <strong>{secretOnce}</strong>
        </p>
      ) : null}

      <h2>Audit log</h2>
      <p className="empty">Newest first — every mutation on this project.</p>
      {audit.length === 0 ? (
        <p className="empty">No entries yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{a.createdAt.slice(0, 16).replace("T", " ")}</td>
                <td className="font-mono text-[10px]">{a.actor.slice(0, 14)}</td>
                <td>{a.action}</td>
                <td className="font-mono text-[10px]">{a.target ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
