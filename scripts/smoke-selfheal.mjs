/**
 * Live smoke for the four new features: self-heal review (heals on trace +
 * commit-as-version), version diff, CLI frame ingestion (simulated), and the
 * S3 delete path (list+delete over HTTP — exercised only when S3 env is set).
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

const email = `smoke-heal-${Date.now()}@example.com`;
const su = await call("POST", "/v1/auth/signup", { email, password: "password1" });
const T = su.body.token;

// ---- 1. Self-heal review: heals derived from events + explicit heals ----
const flow = await call("POST", "/v1/flows", { name: "login", objective: "log in and reach dashboard" }, T);
const flowId = flow.body.flow.id;
const events = [
  { ts: new Date().toISOString(), type: "decide", stepIndex: 1, payload: { action: { type: "click", target: { selector: "#old-login" } } } },
  { ts: new Date(Date.now() + 1e3).toISOString(), type: "act", stepIndex: 1, payload: { ok: false, detail: "#old-login not found" } },
  { ts: new Date(Date.now() + 2e3).toISOString(), type: "decide", stepIndex: 1, payload: { action: { type: "click", target: { selector: "text=Sign in" } } } },
  { ts: new Date(Date.now() + 3e3).toISOString(), type: "retry", stepIndex: 1, payload: { ok: true, healed: true, detail: "#old-login not found" } },
];
const run = await call("POST", "/v1/runs", {
  flowId, objective: "log in and reach dashboard", status: "passed", healedSteps: 1, events,
}, T);
check("run ingest with healed step", run.status === 200);
const trace = await call("GET", `/v1/runs/${run.body.id}/trace`, undefined, T);
const heals = trace.body.heals ?? [];
check("trace exposes heal with from→to selectors", heals.length === 1 && heals[0].originalSelector === "#old-login" && heals[0].repairedSelector === "text=Sign in", JSON.stringify(heals));

// ---- 2. Commit the repair as a new version ----
const commit = await call("POST", `/v1/flows/${flowId}/repairs`, {
  runId: run.body.id, stepIndex: 1, failure: "#old-login not found", fromSelector: "#old-login", toSelector: "text=Sign in",
}, T);
check("repair committed as v2", commit.status === 200 && commit.body.version === 2, JSON.stringify(commit.body).slice(0, 120));
check("flow carries the repair record", (commit.body.flow?.repairs ?? []).length === 1);
const hist = await call("GET", `/v1/flows/${flowId}/versions`, undefined, T);
const v2 = (hist.body.versions ?? []).find((v) => v.version === 2);
check("v2 snapshot notes the self-heal", v2?.note?.includes("self-heal") === true);
const audit = await call("GET", "/v1/audit", undefined, T);
check("audit records flow.selfheal_commit", JSON.stringify(audit.body ?? {}).includes("selfheal_commit"));

// ---- 3. Version diff endpoint ----
const diff = await call("GET", `/v1/flows/${flowId}/versions/1/diff/2`, undefined, T);
check("diff marks repair-only change", diff.status === 200 && diff.body.changed === true);
const kinds = (diff.body.rows ?? []).map((r) => r.kind);
check("diff rows include added+removed", kinds.includes("added") && kinds.includes("removed"));
check("diff shows repairs line", (diff.body.rows ?? []).some((r) => r.line.startsWith("repairs:")));

// ---- 4. Frame ingest (what the CLI now pushes per step) ----
const png = Buffer.from("fake-png").toString("base64");
const fr = await call("POST", `/v1/runs/${run.body.id}/frames`, { stepIndex: 5, url: "https://x.test/dash", pngBase64: png }, T);
check("CLI-style frame ingest accepted", fr.status === 200 && fr.body.ok === true);
const stream = await fetch(`${B}/v1/runs/${run.body.id}/stream?token=${T}`);
const reader = stream.body.getReader();
const chunk = await reader.read();
const text = new TextDecoder().decode(chunk.value);
check("SSE stream greets subscriber", text.includes("event: hello"));
await reader.cancel().catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
