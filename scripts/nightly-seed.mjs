/**
 * Seed for the nightly keyless-recipe CI job: signs up against a running API,
 * creates a flow, and ingests a synthetic passing run whose event log derives
 * a deterministic recipe (navigate → assert heading). Prints JSON on stdout:
 * { token, flowId }.
 *
 * Usage: node scripts/nightly-seed.mjs [baseUrl] [email] [envUrl]
 * (email is generated when omitted; pass one explicitly when the same account
 * must later be used by `veriflow login` in another step; envUrl defaults to
 * https://example.com — pass the local test-site URL for a network-free run)
 */
const B = process.argv[2] ?? "http://127.0.0.1:8787";
const email = process.argv[3] ?? `nightly-${Date.now()}@example.com`;
const envUrl = process.argv[4] ?? "https://example.com";
const su = await fetch(`${B}/v1/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "password1" }),
});
if (!su.ok) throw new Error(`signup failed ${su.status}: ${await su.text()}`);
const { token } = await su.json();

const H = { "content-type": "application/json", authorization: `Bearer ${token}` };
const flowName = `nightly heading flow (${envUrl})`;
const fl = await fetch(`${B}/v1/flows`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ name: flowName, objective: `open ${envUrl} and assert the heading`, envUrl }),
});
if (!fl.ok) throw new Error(`flow create failed ${fl.status}: ${await fl.text()}`);
const flow = (await fl.json()).flow;

const now = new Date().toISOString();
const run = await fetch(`${B}/v1/runs`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    flowId: flow.id,
    objective: flow.objective,
    envUrl,
    status: "passed",
    stepCount: 2,
    startedAt: now,
    endedAt: now,
    events: [
      { type: "run_start", ts: now, payload: { objective: flow.objective, envUrl } },
      { type: "decide", ts: now, stepIndex: 0, payload: { action: { type: "navigate", url: envUrl } } },
      { type: "act", ts: now, stepIndex: 0, payload: { ok: true, detail: "navigated" } },
      { type: "decide", ts: now, stepIndex: 1, payload: { action: { type: "assert", check: "heading_contains", value: "Example" } } },
      { type: "act", ts: now, stepIndex: 1, payload: { ok: true, detail: "h1 contains Example" } },
      { type: "run_end", ts: now, payload: { status: "passed", steps: 2 } },
    ],
  }),
});
if (!run.ok) throw new Error(`run ingest failed ${run.status}: ${await run.text()}`);

const rec = await fetch(`${B}/v1/flows/${flow.id}/recipe`, { headers: H });
if (!rec.ok) throw new Error(`recipe derive failed ${rec.status}: ${await rec.text()}`);
const recipe = await rec.json();
if (!Array.isArray(recipe.actions) || recipe.actions.length === 0) {
  throw new Error(`recipe derived no actions: ${JSON.stringify(recipe)}`);
}
console.log(JSON.stringify({ token, email, flowId: flow.id, actions: recipe.actions.length }));
