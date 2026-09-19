#!/usr/bin/env node
/**
 * Seeds the local Veriflow API with a demo run for the trace-viewer scrubber.
 *
 * No workspace deps — plain Node (crypto/zlib/fetch only):
 *   node scripts/seed-demo-run.mjs [apiBase]
 *
 * Creates (or reuses) a demo user, then upserts run `run_scrubber_demo`:
 * a failing checkout flow — login ok, add-to-cart ok, checkout click fails
 * on a stale ref, self-heal retries, then the run exhausts its step cap.
 */
import { deflateSync } from "node:zlib";

const API = process.argv[2] ?? "http://127.0.0.1:8787";
const RUN_ID = "run_scrubber_demo";
const EMAIL = "demo@veriflow.dev";
const PASSWORD = "demo-password-123";

// ---------- tiny PNG encoder (truecolor, single fill color) ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function pngBytes([r, g, b], width = 320, height = 200) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- demo trace: steps, events, spans ----------
const SHOT_COLORS = {
  0: [0x1a, 0x1a, 0x1a], // login page (dark)
  1: [0x2a, 0x4a, 0x3a], // dashboard after login
  2: [0x3a, 0x5a, 0x4a], // product page
  3: [0xb5, 0x6a, 0x4a], // shop — checkout button missing here
  4: [0x6a, 0x4a, 0xb5], // final observe — cart still empty
};

// Ordered harness events (same shape the CLI uploads; steps are derived
// from the `decide` events that carry an action).
function buildEvents(baseMs) {
  const t = (i) => new Date(baseMs + i * 1200).toISOString();
  return [
    { ts: t(0), type: "run_start", runId: RUN_ID, payload: { objective: "Log in, add the Pro plan to the cart, verify the checkout total" } },
    { ts: t(0), type: "decide", runId: RUN_ID, stepIndex: 0, payload: { action: { type: "fill", ref: "@e3", value: "demo@veriflow.dev" }, reasoning: "Objective asks to log in first; email field is ref @e3." } },
    { ts: t(1), type: "decide", runId: RUN_ID, stepIndex: 1, payload: { action: { type: "click", ref: "@e6", description: "Sign in button" } } },
    { ts: t(2), type: "decide", runId: RUN_ID, stepIndex: 2, payload: { action: { type: "click", ref: "@e9", description: "Pro plan card" } } },
    { ts: t(3), type: "decide", runId: RUN_ID, stepIndex: 3, payload: { action: { type: "click", ref: "@e12", description: "Go to checkout" } } },
    { ts: t(4), type: "decide", runId: RUN_ID, stepIndex: 4, payload: { action: { type: "finish", result: "fail", reason: "Checkout button not reachable — cart never updated; step cap reached." } } },
    { ts: t(5), type: "run_end", runId: RUN_ID, payload: { status: "failed", reason: "exhausted_steps" } },
  ];
}

function buildSpans(baseMs) {
  const t = (i) => new Date(baseMs + i * 1200).toISOString();
  const t2 = (i) => new Date(baseMs + i * 1200 + 600).toISOString();
  const stepId = (i) => `${RUN_ID}_step_${i}`;
  return [
    { id: `${RUN_ID}_s0o`, runId: RUN_ID, stepId: stepId(0), kind: "OBSERVE", startedAt: t(0), endedAt: t(0), ok: true, attributes: { stepIndex: 0, url: "https://shop.example/login" } },
    { id: `${RUN_ID}_s0d`, runId: RUN_ID, stepId: stepId(0), kind: "DECIDE", startedAt: t(0), endedAt: t2(0), ok: true, attributes: { stepIndex: 0, actionType: "fill", model: "veriflow-managed", promptTokens: 1840, completionTokens: 38, costUsd: 0.0031 } },
    { id: `${RUN_ID}_s0g`, runId: RUN_ID, stepId: stepId(0), kind: "GUARD", startedAt: t2(0), endedAt: t2(0), ok: true, attributes: { stepIndex: 0, guards: ["step_cap", "loop_detection", "cost_cap"], destructive: false } },
    { id: `${RUN_ID}_s0a`, runId: RUN_ID, stepId: stepId(0), kind: "ACT", startedAt: t2(0), endedAt: t(1), ok: true, attributes: { stepIndex: 0, actionType: "fill", target: "@e3" } },
    { id: `${RUN_ID}_s0v`, runId: RUN_ID, stepId: stepId(0), kind: "VERIFY", startedAt: t(1), endedAt: t(1), ok: true, attributes: { stepIndex: 0, detail: "email field value matches (masked) — 1 change detected" } },

    { id: `${RUN_ID}_s1o`, runId: RUN_ID, stepId: stepId(1), kind: "OBSERVE", startedAt: t(1), endedAt: t(1), ok: true, attributes: { stepIndex: 1, url: "https://shop.example/login" } },
    { id: `${RUN_ID}_s1d`, runId: RUN_ID, stepId: stepId(1), kind: "DECIDE", startedAt: t(1), endedAt: t2(1), ok: true, attributes: { stepIndex: 1, actionType: "click", model: "veriflow-managed", promptTokens: 1912, completionTokens: 21, costUsd: 0.0029 } },
    { id: `${RUN_ID}_s1g`, runId: RUN_ID, stepId: stepId(1), kind: "GUARD", startedAt: t2(1), endedAt: t2(1), ok: true, attributes: { stepIndex: 1, guards: ["step_cap", "loop_detection"], destructive: false } },
    { id: `${RUN_ID}_s1a`, runId: RUN_ID, stepId: stepId(1), kind: "ACT", startedAt: t2(1), endedAt: t(2), ok: true, attributes: { stepIndex: 1, actionType: "click", target: "@e6" } },
    { id: `${RUN_ID}_s1v`, runId: RUN_ID, stepId: stepId(1), kind: "VERIFY", startedAt: t(2), endedAt: t(2), ok: true, attributes: { stepIndex: 1, detail: "navigated to /dashboard — h1 now 'Welcome back'" } },

    { id: `${RUN_ID}_s2o`, runId: RUN_ID, stepId: stepId(2), kind: "OBSERVE", startedAt: t(2), endedAt: t(2), ok: true, attributes: { stepIndex: 2, url: "https://shop.example/dashboard" } },
    { id: `${RUN_ID}_s2d`, runId: RUN_ID, stepId: stepId(2), kind: "DECIDE", startedAt: t(2), endedAt: t2(2), ok: true, attributes: { stepIndex: 2, actionType: "click", model: "veriflow-managed", promptTokens: 2050, completionTokens: 24, costUsd: 0.0033 } },
    { id: `${RUN_ID}_s2g`, runId: RUN_ID, stepId: stepId(2), kind: "GUARD", startedAt: t2(2), endedAt: t2(2), ok: true, attributes: { stepIndex: 2, guards: ["step_cap", "loop_detection"], destructive: false } },
    { id: `${RUN_ID}_s2a`, runId: RUN_ID, stepId: stepId(2), kind: "ACT", startedAt: t2(2), endedAt: t(3), ok: true, attributes: { stepIndex: 2, actionType: "click", target: "@e9" } },
    { id: `${RUN_ID}_s2v`, runId: RUN_ID, stepId: stepId(2), kind: "VERIFY", startedAt: t(3), endedAt: t(3), ok: true, attributes: { stepIndex: 2, detail: "Pro plan card selected — 'Add to cart' visible" } },

    { id: `${RUN_ID}_s3o`, runId: RUN_ID, stepId: stepId(3), kind: "OBSERVE", startedAt: t(3), endedAt: t(3), ok: true, attributes: { stepIndex: 3, url: "https://shop.example/shop" } },
    { id: `${RUN_ID}_s3d`, runId: RUN_ID, stepId: stepId(3), kind: "DECIDE", startedAt: t(3), endedAt: t2(3), ok: true, attributes: { stepIndex: 3, actionType: "click", model: "veriflow-managed", promptTokens: 2210, completionTokens: 26, costUsd: 0.0036 } },
    { id: `${RUN_ID}_s3g`, runId: RUN_ID, stepId: stepId(3), kind: "GUARD", startedAt: t2(3), endedAt: t2(3), ok: true, attributes: { stepIndex: 3, guards: ["step_cap", "loop_detection"], destructive: false } },
    { id: `${RUN_ID}_s3a`, runId: RUN_ID, stepId: stepId(3), kind: "ACT", startedAt: t2(3), endedAt: t(4), ok: false, error: "ref @e12 not on page — element drifted after redesign", attributes: { stepIndex: 3, actionType: "click", target: "@e12", healing: false } },
    { id: `${RUN_ID}_s3r`, runId: RUN_ID, stepId: stepId(3), kind: "RETRY", startedAt: t(4), endedAt: t(4), ok: false, error: "re-observe still has no checkout control on /shop", attributes: { stepIndex: 3, attempt: 2 } },
    { id: `${RUN_ID}_s3v`, runId: RUN_ID, stepId: stepId(3), kind: "VERIFY", startedAt: t(4), endedAt: t(4), ok: false, error: "expected cart badge > 0, got 0", attributes: { stepIndex: 3, detail: "expected cart badge > 0, got 0 — item was never added" } },

    { id: `${RUN_ID}_s4o`, runId: RUN_ID, stepId: stepId(4), kind: "OBSERVE", startedAt: t(4), endedAt: t(4), ok: true, attributes: { stepIndex: 4, url: "https://shop.example/shop" } },
    { id: `${RUN_ID}_s4f`, runId: RUN_ID, stepId: stepId(4), kind: "FINISH", startedAt: t(5), endedAt: t(5), ok: false, error: "exhausted steps", attributes: { stepIndex: 4, reason: "exhausted_steps", costUsd: 0.0129 } },
  ];
}

async function main() {
  // 1. Auth: reuse the demo user if it exists.
  let res = await fetch(`${API}/v1/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status === 409) {
    res = await fetch(`${API}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  }
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
  const { token, user, project } = await res.json();
  console.log(`auth ok: user=${user.id} project=${project?.id ?? "(resolved per request)"}`);

  // 2. Upsert the demo run with events + spans + screenshots.
  const baseMs = Date.now() - 6 * 1200;
  const events = buildEvents(baseMs);
  const spans = buildSpans(baseMs);
  const files = Object.entries(SHOT_COLORS).map(([step, color]) => ({
    path: `screenshots/step-${step}.png`,
    contentBase64: pngBytes(color).toString("base64"),
  }));

  res = await fetch(`${API}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: RUN_ID,
      objective: "Log in, add the Pro plan to the cart, verify the checkout total",
      envUrl: "https://shop.example",
      status: "failed",
      startedAt: new Date(baseMs).toISOString(),
      endedAt: new Date(baseMs + 6 * 1200).toISOString(),
      stepCount: 5,
      costUsd: 0.0129,
      error: "exhausted steps — checkout control never appeared after UI drift",
      events,
      spans,
      files,
    }),
  });
  if (!res.ok) throw new Error(`run upload failed: ${res.status} ${await res.text()}`);
  const out = await res.json();
  console.log(`seeded run ${out.id} (quota ${out.quota.used}/${out.quota.limit}, tier ${out.quota.tier})`);
  console.log(`view: /runs/${out.id}  ·  login token stored below`);
  console.log(`TOKEN=${token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
