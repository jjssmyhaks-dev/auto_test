/**
 * Delivery channels for alert rules and human pauses: email, Slack, and plain
 * webhooks — with bounded retry. Channel strings are stored on the rule, e.g.
 *   email:ops@acme.dev            → SMTP (VERIFLOW_SMTP_URL) or HTTP relay
 *   slack:https://hooks.slack.com/… → Slack incoming webhook
 *   webhook:https://…              → generic JSON POST
 *
 * Email transport: when VERIFLOW_SMTP_URL is set we speak SMTP directly
 * (nodemailer-style inline client over TLS/25/465/587); otherwise we POST a
 * JSON envelope to VERIFLOW_EMAIL_ENDPOINT (works with Resend/SendGrid-style
 * HTTP APIs and keeps tests + zero-config deploys honest). With neither set,
 * email delivery is recorded as "skipped" — visible in the eval response
 * rather than silently dropped.
 */

export interface DeliveryResult {
  channel: string;
  kind: "email" | "slack" | "webhook" | "unknown";
  status: "delivered" | "skipped" | "failed";
  attempts: number;
  error?: string;
}

export const DELIVERY_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseChannel(channel: string): { kind: DeliveryResult["kind"]; target: string } | undefined {
  const idx = channel.indexOf(":");
  const kind = idx > 0 ? channel.slice(0, idx) : channel;
  const target = idx > 0 ? channel.slice(idx + 1).trim() : "";
  // Bare kinds ("webhook") fall back to their env-configured target.
  if (kind === "email") return { kind: "email", target };
  if (kind === "slack") return { kind: "slack", target: target || (process.env.VERIFLOW_SLACK_WEBHOOK ?? "") };
  if (kind === "webhook") return { kind: "webhook", target: target || (process.env.VERIFLOW_ALERT_WEBHOOK ?? "") };
  return undefined;
}

/** POST with bounded retry: 3 attempts, 300ms doubling backoff. */
export async function postWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  attempts = DELIVERY_ATTEMPTS,
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, attempts: attempt };
      // 4xx (other than 429) are permanent — retrying won't help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { ok: false, attempts: attempt, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) await sleep(300 * 2 ** (attempt - 1));
  }
  return { ok: false, attempts, error: lastError };
}

export async function deliver(channel: string, payload: unknown): Promise<DeliveryResult> {
  const parsed = parseChannel(channel);
  if (!parsed) return { channel, kind: "unknown", status: "failed", attempts: 0, error: "unparseable channel" };
  const { kind, target } = parsed;

  if (kind === "email") {
    const smtpUrl = process.env.VERIFLOW_SMTP_URL;
    const endpoint = process.env.VERIFLOW_EMAIL_ENDPOINT;
    if (!smtpUrl && !endpoint) {
      return { channel, kind, status: "skipped", attempts: 0, error: "no email transport (VERIFLOW_SMTP_URL or VERIFLOW_EMAIL_ENDPOINT)" };
    }
    if (endpoint) {
      const res = await postWithRetry(endpoint, { to: target, subject: "Veriflow notification", payload });
      return res.ok
        ? { channel, kind, status: "delivered", attempts: res.attempts }
        : { channel, kind, status: "failed", attempts: res.attempts, error: res.error };
    }
    // Minimal SMTP: VERIFLOW_SMTP_URL=smtp://user:pass@host:port — one-shot
    // client sufficient for transactional alerts (no pooling by design).
    try {
      const u = new URL(smtpUrl as string);
      const { connect } = await import("node:net");
      const secure = u.protocol === "smtps:" || Number(u.port) === 465;
      const socket = secure ? (await import("node:tls")).connect({ host: u.hostname, port: Number(u.port || 465) }) : connect(Number(u.port || 25), u.hostname);
      await new Promise<void>((resolve, reject) => {
        socket.once(secure ? "secureConnect" : "connect", () => resolve());
        socket.once("error", reject);
      });
      const read = () =>
        new Promise<string>((resolve) => {
          let buf = "";
          const onData = (d: Buffer) => {
            buf += d.toString();
            if (/\r?\n\d{3}[ -]/.test(buf)) {
              socket.off("data", onData);
              resolve(buf);
            }
          };
          socket.on("data", onData);
        });
      const cmd = async (s: string, expect: number) => {
        socket.write(`${s}\r\n`);
        const reply = await read();
        if (!reply.startsWith(`${expect}`)) throw new Error(`SMTP ${s.split(" ")[0]} → ${reply.split("\r\n")[0]}`);
        return reply;
      };
      await read(); // banner
      await cmd(`EHLO veriflow`, 250);
      if (u.username && u.password) {
        await cmd("AUTH LOGIN", 334);
        await cmd(Buffer.from(u.username).toString("base64"), 334);
        await cmd(Buffer.from(u.password).toString("base64"), 235);
      }
      const from = process.env.VERIFLOW_EMAIL_FROM ?? "veriflow@localhost";
      await cmd(`MAIL FROM:<${from}>`, 250);
      await cmd(`RCPT TO:<${target}>`, 250);
      await cmd("DATA", 354);
      const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
      socket.write(`From: Veriflow <${from}>\r\nTo: <${target}>\r\nSubject: Veriflow notification\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);
      await read();
      await cmd("QUIT", 221).catch(() => {});
      socket.end();
      return { channel, kind, status: "delivered", attempts: 1 };
    } catch (err) {
      return { channel, kind, status: "failed", attempts: 1, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // slack: / webhook: — JSON POST with retry.
  if (!target) return { channel, kind, status: "skipped", attempts: 0, error: "no target URL configured" };
  const body =
    kind === "slack"
      ? { text: summarise(payload) }
      : payload;
  const res = await postWithRetry(target, body);
  return res.ok
    ? { channel, kind, status: "delivered", attempts: res.attempts }
    : { channel, kind, status: "failed", attempts: res.attempts, error: res.error };
}

/** Slack wants a human-readable `text`. */
function summarise(payload: unknown): string {
  const p = payload as { alerts?: unknown[]; triggeredRules?: { message?: string }[]; pause?: { reason?: string; runId?: string } };
  const parts: string[] = [];
  for (const a of p.alerts ?? []) parts.push(`⚠️ ${typeof a === "string" ? a : JSON.stringify(a)}`);
  for (const r of p.triggeredRules ?? []) parts.push(`🔔 ${r.message ?? "rule crossed"}`);
  if (p.pause) parts.push(`⏸ Human input needed on run ${p.pause.runId}: ${p.pause.reason}`);
  return parts.length ? `Veriflow:\n${parts.join("\n")}` : `Veriflow notification: ${JSON.stringify(payload)}`;
}

export function deliverResultSummary(results: DeliveryResult[]) {
  return {
    attempted: results.length,
    delivered: results.filter((r) => r.status === "delivered").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
