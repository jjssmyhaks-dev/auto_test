import { createHmac } from "node:crypto";
import type { WebhookRow } from "./auth.js";

/**
 * Outbound webhook delivery: HMAC-SHA256-signed POSTs with exponential-backoff
 * retry (3 attempts). Signing scheme mirrors Stripe's: `t=<unix>,v1=<hmac>`
 * over `<timestamp>.<body>`, so receivers can share verification code.
 */

export interface WebhookDeliveryResult {
  webhookId: string;
  url: string;
  event: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

async function postWithTimeout(url: string, headers: Record<string, string>, body: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverWebhook(
  hook: WebhookRow,
  event: string,
  data: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
  const body = JSON.stringify({ event, data, deliveredAt: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhook(hook.secret, timestamp, body);
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await postWithTimeout(
        hook.url,
        { "content-type": "application/json", "veriflow-signature": signature, "veriflow-event": event },
        body,
        10_000,
      );
      if (res.ok) return { webhookId: hook.id, url: hook.url, event, ok: true, attempts: attempt };
      lastError = `HTTP ${res.status}`;
      // Permanent client errors: retrying won't help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  return { webhookId: hook.id, url: hook.url, event, ok: false, attempts: 3, error: lastError };
}

/** Fan an event out to every enabled webhook of a project (fire-and-forget safe). */
export async function fanOutWebhooks(
  hooks: WebhookRow[],
  event: string,
  data: Record<string, unknown>,
  mark: (id: string, ok: boolean, at: string) => Promise<void>,
): Promise<WebhookDeliveryResult[]> {
  const now = new Date().toISOString();
  const targets = hooks.filter((h) => !h.disabled && (h.events.length === 0 || h.events.includes(event) || h.events.includes("*")));
  const results = await Promise.all(targets.map((h) => deliverWebhook(h, event, data)));
  await Promise.all(results.map((r) => mark(r.webhookId, r.ok, now)));
  return results;
}
