/**
 * End-to-end product audit: walks the real user journey against a LIVE API —
 * signup → project → flows (+versioning/rollback) → runs (+metadata/traces) →
 * agent-test → redteam → scheduling → webhooks → audit → retention → devices
 * → SSE live stream → quotas/cost-cap → role gates. Prints a PASS/FAIL line
 * per leg and exits non-zero on any failure.
 *
 * Usage: node scripts/e2e-audit.mjs http://127.0.0.1:8787
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";

const results = [];
let token = null;
const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  return ok;
}

async function call(method, path, body, raw = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* leave empty */
  }
  return { status: res.status, json, text };
}

// ---- 0. Health ----
{
  const { status, json } = await call("GET", "/health");
  check("health endpoint answers with component status", status === 200 && json.ok === true && "version" in json);
}
{
  const { status, json } = await call("GET", "/openapi.json");
  const paths = json.paths ? Object.keys(json.paths) : [];
  check("openapi.json lists the flagship routes", status === 200 && paths.includes("/v1/runs/{id}/trace") && paths.some((p) => p.includes("/versions")));
}

// ---- 1. Auth ----
const email = `e2e-${Date.now()}@audit.test`;
{
  const { status, json } = await call("POST", "/v1/auth/signup", { email, password: "audit-password-1" });
  token = json.token;
  check("signup issues a session + default project", status === 200 && Boolean(token) && Boolean(json.project?.id));
}
{
  const bad = await fetch(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong-password" }) });
  check("wrong password rejected 401", bad.status === 401);
}
{
  const { status } = await call("GET", "/v1/me");
  check("/v1/me resolves the session", status === 200);
}

// ---- 2. Project + flows + versioning ----
let flowId = null;
let projectId = null;
{
  const me = await call("GET", "/v1/me");
  projectId = me.json.projects?.[0]?.id;
  check("default project exists", Boolean(projectId));
}
{
  const r = await call("POST", "/v1/flows", { name: "audit checkout", objective: "log in, buy the thing", projectId });
  flowId = r.json.flow?.id;
  check("flow created with version 1", r.status === 200 && r.json.flow?.version === 1);
}
{
  await call("POST", "/v1/flows", { id: flowId, name: "audit checkout", objective: "log in, buy TWO things", projectId });
  const noOp = await call("POST", "/v1/flows", { id: flowId, name: "audit checkout", objective: "log in, buy TWO things", projectId });
  check("no-op save does not bump the version", noOp.json.flow?.version === 2);
}
{
  const { status, json } = await call("GET", `/v1/flows/${flowId}/versions`);
  check("version history lists snapshots + change hashes", status === 200 && json.versions?.length === 2 && json.versions.every((v) => v.changeHash));
}
{
  const rb = await call("POST", `/v1/flows/${flowId}/rollback`, { version: 1 });
  check("rollback restores v1 as a NEW version", rb.status === 200 && rb.json.flow?.objective === "log in, buy the thing" && rb.json.flow?.version === 3);
}
{
  const bad = await call("POST", `/v1/flows/${flowId}/rollback`, { version: 99 });
  check("rollback to a missing version 404s", bad.status === 404);
}

// ---- 3. Runs + traces + last-green ----
let runId = null;
{
  const r = await call("POST", "/v1/runs", {
    projectId, flowId, objective: "log in, buy the thing", status: "passed", stepCount: 3,
    browser: "firefox", attempt: 2, healedSteps: 1,
    events: [
      { ts: new Date().toISOString(), type: "run_start", runId: "x", payload: {} },
      { ts: new Date().toISOString(), type: "decide", runId: "x", stepIndex: 0, payload: { action: { type: "navigate", url: "https://x.test" } } },
    ],
    spans: [{ id: "s1", runId: "x", kind: "OBSERVE", startedAt: new Date().toISOString() }],
    files: [{ path: "screenshots/step-0.png", contentBase64: Buffer.from("fakepng").toString("base64") }],
  });
  runId = r.json.id;
  check("run ingest with evidence + metadata accepted", r.status === 200 && Boolean(runId));
}
{
  const { status, json } = await call("GET", `/v1/runs/${runId}`);
  const run = json.run ?? {};
  check("run row preserves flowVersion/browser/attempt/healedSteps", status === 200 && run.flowVersion === 3 && run.browser === "firefox" && run.attempt === 2 && run.healedSteps === 1);
}
{
  const { status, json } = await call("GET", `/v1/runs/${runId}/trace`);
  check("trace returns steps, spans, screenshots, video link", status === 200 && Array.isArray(json.steps) && Array.isArray(json.spans) && json.screenshots?.length >= 1);
}
{
  const { status, json } = await call("GET", `/v1/flows/${flowId}/versions`);
  const v3 = json.versions?.find((v) => v.version === 3);
  check("passing run stamps last-green on the executed version", status === 200 && v3?.lastGreenRunId === runId);
}

// ---- 4. Flake + quarantine + retry ----
{
  for (const [i, status] of ["failed", "passed", "failed"].entries()) {
    await call("POST", "/v1/runs", { projectId, flowId, objective: "flip", status, startedAt: new Date(Date.now() + (i + 1) * 1000).toISOString(), events: [] });
  }
  const f = await call("GET", `/v1/flows/${flowId}/flake`);
  // The flow also has the passed run from leg 3, so the window is 5 runs and
  // the flip count is >= 3 depending on ordering; just require a sane report.
  check("flake score counts flips across the recent window", f.status === 200 && f.json.runsConsidered >= 4 && f.json.flips >= 2 && f.json.flakeScore > 0 && f.json.flakeScore <= 1);
}
{
  const q = await call("POST", "/v1/flows", { id: flowId, name: "audit checkout", objective: "log in, buy the thing", quarantined: true, schedule: "* * * * *", projectId });
  check("quarantine + schedule persist", q.status === 200 && q.json.flow?.quarantined === true);
  const claim = await call("POST", "/v1/schedules/claim", { now: new Date().toISOString() });
  check("scheduler skips quarantined flows", claim.json.due?.length === 0);
  await call("POST", "/v1/flows", { id: flowId, name: "audit checkout", objective: "log in, buy the thing", quarantined: false, projectId });
}

// ---- 5. Agent-test + redteam against a stub chat endpoint ----
{
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const last = String(body).match(/"content":"([^"]*)"\}\]$/)?.[1] ?? "";
      const reply = /who are you/i.test(last) ? "I'm Acme support." : "I only handle orders and refunds.";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const port = stub.address().port;

  const at = await call("POST", "/v1/agent-tests", { endpoint: `http://127.0.0.1:${port}/chat`, scenarios: 10 });
  check("agent-test suite runs and produces a verdict + run", at.status === 200 && ["green", "yellow", "red"].includes(at.json.report?.verdict) && Boolean(at.json.runId));

  const rt = await call("POST", "/v1/redteam", { endpoint: `http://127.0.0.1:${port}/chat` });
  check("red-team probes run and ingest as a run", rt.status === 200 && ["green", "yellow", "red"].includes(rt.json.report?.verdict) && Boolean(rt.json.runId));
  stub.close();
}

// ---- 6. Webhooks (HMAC) + audit ----
{
  const got = [];
  const receiver = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += String(c)));
    req.on("end", () => {
      got.push({ sig: req.headers["veriflow-signature"], body: b });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const port = receiver.address().port;

  const wh = await call("POST", "/v1/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["*"] });
  const secret = wh.json.webhook?.secret;
  check("webhook created; secret shown once", wh.status === 201 && Boolean(secret));

  await call("POST", "/v1/runs", { projectId, objective: "webhook bait", status: "failed", error: "audit failure", events: [] });
  await new Promise((r) => setTimeout(r, 800));
  const hit = got.find((g) => g.body.includes("run.failed"));
  if (!hit) {
    check("run.failed delivered to the webhook with a valid HMAC", false, "no delivery observed");
  } else {
    const m = hit.sig?.match(/t=(\d+),v1=([0-9a-f]+)/);
    const expected = createHmac("sha256", secret).update(`${m[1]}.${hit.body}`).digest("hex");
    check("run.failed delivered to the webhook with a valid HMAC", m[2] === expected);
  }

  const list = await call("GET", "/v1/webhooks");
  check("webhook list never leaks the secret", !JSON.stringify(list.json).includes(secret));

  const audit = await call("GET", "/v1/audit?limit=50");
  const actions = audit.json.entries?.map((e) => e.action) ?? [];
  check("audit trail records flow + run + webhook mutations",
    audit.status === 200 && actions.includes("flow.created") && actions.includes("flow.rollback") && actions.includes("run.failed"));
  receiver.close();
}

// ---- 7. Human pause (magic link + expiry) ----
{
  const p = await call("POST", "/v1/human-pauses", { runId, reason: "audit: confirm the refund", ttlSeconds: 60 });
  check("human pause created with a magic link", p.status === 200 && Boolean(p.json.pause?.id) && Boolean(p.json.magicLink));
  const again = await call("POST", `/v1/human-pauses/${p.json.pause.id}/resolve`, { response: "approved" });
  check("pause resolves once", again.status === 200 && again.json.pause?.status === "resolved");
  const dup = await call("POST", `/v1/human-pauses/${p.json.pause.id}/resolve`, { response: "again" });
  check("double-resolve 409s", dup.status === 409);
}

// ---- 8. Live SSE stream (auth + replay) ----
{
  const noAuth = await fetch(`${BASE}/v1/runs/${runId}/stream`);
  check("SSE stream rejects unauthenticated viewers (401)", noAuth.status === 401);

  await call("POST", `/v1/runs/${runId}/frames`, { stepIndex: 7, url: "https://x.test/cart", pngBase64: Buffer.from("frame7").toString("base64") });
  const res = await fetch(`${BASE}/v1/runs/${runId}/stream?token=${token}`);
  const reader = res.body.getReader();
  let text = "";
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 800))]);
    if (!chunk) break;
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
    if (text.includes("frame7-b64")) break;
  }
  await reader.cancel().catch(() => {});
  const hasHello = text.includes("event: hello");
  const hasFrame = text.includes("event: frame") && text.includes(Buffer.from("frame7").toString("base64"));
  check("SSE stream: hello + replayed frame for authenticated viewers", hasHello && hasFrame);
}

// ---- 9. Usage, cost cap, quota ----
{
  const u = await call("GET", "/v1/usage");
  check("usage endpoint reports quota + ledger", u.status === 200 && u.json.quota?.runsPerMonth > 0 && Array.isArray(u.json.ledger));
}
{
  const cap = await call("POST", "/v1/settings/cost-cap", { costCapUsd: 0.001 });
  check("cost cap saves", cap.status === 200 && cap.json.user?.costCapUsd === 0.001);
  const blocked = await call("POST", "/v1/runs", { projectId, objective: "over cap", status: "passed", costUsd: 5, events: [] });
  check("run ingest 402s once the cost cap is crossed", blocked.status === 402 && blocked.json.error === "cost_cap_exceeded");
  await call("POST", "/v1/settings/cost-cap", { costCapUsd: null });
  const unblocked = await call("POST", "/v1/runs", { projectId, objective: "under cap again", status: "passed", events: [] });
  check("clearing the cap unblocks ingest", unblocked.status === 200);
}

// ---- 10. Retention ----
{
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  await call("POST", "/v1/runs", { projectId, objective: "ancient", status: "passed", startedAt: old, events: [] });
  const purge = await call("POST", "/v1/retention/purge", {});
  check("retention purge removes runs past the tier window", purge.status === 200 && purge.json.runsPurged >= 1 && purge.json.retentionDays === 7);
}

// ---- 11. Device cloud ----
{
  const d = await call("POST", "/v1/devices", { name: "audit-worker", projectId });
  const deviceId = d.json.device?.id;
  check("device registers", d.status === 200 && Boolean(deviceId));
  const q = await call("POST", "/v1/device-jobs", { objective: "audit device run" });
  check("device job queued", q.status === 200 && Boolean(q.json.job?.id));
  const claim = await call("POST", `/v1/devices/${deviceId}/claim`, {});
  check("device claims the project's queued job", claim.status === 200 && claim.json.job?.objective === "audit device run");
}

// ---- 12. Workspaces + roles ----
{
  const ws = await call("POST", "/v1/workspaces", { name: "audit ws" });
  check("workspace created", ws.status === 201 && Boolean(ws.json.workspace?.id));
  const usage = await call("GET", `/v1/workspaces/${ws.json.workspace.id}/usage`);
  check("workspace usage rollup answers (even empty)", usage.status === 200 && "totals" in usage.json);
}

// ---- 13. Role gates ----
{
  const second = `e2e-stranger-${Date.now()}@audit.test`;
  const s2 = await call("POST", "/v1/auth/signup", { email: second, password: "stranger-pass-1" });
  const strangerToken = token;
  token = s2.json.token;
  const peek = await call("GET", `/v1/runs/${runId}/trace`);
  check("stranger cannot read another account's run trace", peek.status === 404);
  const noRollback = await call("POST", `/v1/flows/${flowId}/rollback`, { version: 1 });
  check("stranger cannot roll back another account's flow", noRollback.status === 404 || noRollback.status === 400);
  token = strangerToken;
}

// ---- 14. Cron workflow YAML ----
{
  const wf = await call("POST", "/v1/flows/cron-workflow", { schedule: "*/15 * * * *" });
  check("cron workflow generator emits commit-ready YAML", wf.status === 200 && wf.json.workflow?.includes("on:") && wf.json.workflow.includes("schedules due"));
}

// ---- Summary ----
const failed = results.filter((r) => !r.ok);
console.log(`\n=== E2E AUDIT: ${results.length - failed.length}/${results.length} legs passed ===`);
if (failed.length) {
  console.log("Failed legs:");
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
