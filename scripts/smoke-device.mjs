/**
 * Live smoke for the unified device cloud queue: a run queued from the
 * dashboard is claimable by a connected device (run-backed job), the worker
 * executes under the same run id (queued → running → passed), the sync
 * ingests events/steps in place, and the job completes with the result run.
 *
 * Usage: node scripts/smoke-device.mjs [baseUrl]
 */
const B = process.argv[2] ?? "http://127.0.0.1:8787";
let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}
async function call(method, path, body, token) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const email = `smoke-device-${Date.now()}@example.com`;
const su = await call("POST", "/v1/auth/signup", { email, password: "password1" });
const T = su.body.token;
check("signup", su.status === 200);

// ---- 1. A real device worker registers ----
const reg = await call("POST", "/v1/devices", { name: "smoke-worker" }, T);
check("device registers", reg.status === 200 && reg.body.device?.id);
const deviceId = reg.body.device.id;

// ---- 2. The dashboard queues a run (status queued) ----
const queued = await call(
  "POST",
  "/v1/runs",
  { objective: "open example.com and assert the heading", envUrl: "https://example.com", status: "queued", stepCount: 0 },
  T,
);
check("dashboard run queues", queued.status === 200 && queued.body.id);
const runId = queued.body.id;

// ---- 3. The worker claims it: job materializes from the queued run ----
const claim = await call("POST", `/v1/devices/${deviceId}/claim`, {}, T);
const job = claim.body.job;
check("claim returns a run-backed job", Boolean(job) && job.runId === runId, JSON.stringify(claim.body).slice(0, 160));
const mid = await call("GET", `/v1/runs/${runId}`, undefined, T);
check("claimed run flips to running", mid.body.run?.status === "running", `got ${mid.body.run?.status}`);

// ---- 4. No double-claim: a second claim comes back empty ----
const claim2 = await call("POST", `/v1/devices/${deviceId}/claim`, {}, T);
check("no double-claim", claim2.body.job === null || claim2.body.job === undefined, JSON.stringify(claim2.body).slice(0, 120));

// ---- 5. The worker executes under the same run id and syncs the result ----
const now = new Date().toISOString();
const later = new Date(Date.now() + 5_000).toISOString();
const ingest = await call(
  "POST",
  "/v1/runs",
  {
    id: runId,
    objective: "open example.com and assert the heading",
    envUrl: "https://example.com",
    status: "passed",
    stepCount: 3,
    startedAt: now,
    endedAt: later,
    browser: "chromium",
    events: [
      { type: "run_start", ts: now, payload: { objective: "open example.com and assert the heading", envUrl: "https://example.com" } },
      { type: "decide", ts: now, stepIndex: 0, payload: { action: { type: "open", url: "https://example.com" } } },
      { type: "act", ts: now, stepIndex: 0, payload: { ok: true, detail: "navigated" } },
      { type: "decide", ts: later, stepIndex: 1, payload: { action: { type: "finish", success: true, reason: "heading asserted" } } },
      { type: "run_end", ts: later, payload: { status: "passed", steps: 3 } },
    ],
  },
  T,
);
check("worker syncs result under the claimed run id", ingest.status === 200, JSON.stringify(ingest.body).slice(0, 160));
const finalRun = await call("GET", `/v1/runs/${runId}`, undefined, T);
check("run row updated in place (passed, 3 steps)", finalRun.body.run?.status === "passed" && finalRun.body.run?.stepCount === 3, JSON.stringify(finalRun.body.run).slice(0, 160));
check("steps derived from synced events", Array.isArray(finalRun.body.steps) && finalRun.body.steps.length >= 2, `got ${finalRun.body.steps?.length}`);

// ---- 6. The job completes with the result run ----
const done = await call("POST", `/v1/device-jobs/${job.id}/complete`, { runId }, T);
check("job completes with result run", done.body.job?.status === "done" && done.body.job?.resultRunId === runId, JSON.stringify(done.body).slice(0, 160));

// ---- 7. A plain device job still takes priority over queued runs ----
await call(
  "POST",
  "/v1/runs",
  { objective: "second queued dashboard run", envUrl: "https://example.com", status: "queued", stepCount: 0 },
  T,
);
await call("POST", "/v1/device-jobs", { objective: "explicit job" }, T);
const claim3 = await call("POST", `/v1/devices/${deviceId}/claim`, {}, T);
check("explicit device job beats queued runs", claim3.body.job?.objective === "explicit job", JSON.stringify(claim3.body).slice(0, 120));
const claim4 = await call("POST", `/v1/devices/${deviceId}/claim`, {}, T);
check("then the queued run claims", claim4.body.job?.runId !== undefined, JSON.stringify(claim4.body).slice(0, 120));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
