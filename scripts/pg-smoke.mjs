/**
 * PgStore smoke: connects to DATABASE_URL (CI postgres service), runs the
 * schema migration, and exercises the core CRUD paths — the SQL that unit
 * tests (MemoryStore) can't cover. Exits non-zero on any failure.
 */
import { PgStore } from "../apps/api/dist/pg.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const store = await PgStore.connect(url);
try {
  // Users + sessions
  const user = await store.createUser(`ci-${Date.now()}@veriflow.test`, "hash");
  if (!user.id) throw new Error("createUser failed");
  await store.createSession(user.id, "sesshash");
  const sess = await store.getSession("sesshash");
  if (!sess || sess.userId !== user.id) throw new Error("session round-trip failed");

  // Projects + flows + versions
  const project = await store.createProject(user.id, "CI");
  const flow = await store.saveFlow({
    id: `flow_ci_${Date.now()}`,
    projectId: project.id,
    name: "ci flow",
    objective: "smoke",
    version: 1,
    retryPolicy: { maxAttempts: 2, backoffSeconds: 1 },
    quarantined: false,
  });
  const flows = await store.listFlows(project.id);
  if (flows[0].retryPolicy?.maxAttempts !== 2) throw new Error("flow retryPolicy round-trip failed");
  await store.saveFlowVersion({
    id: `fv_ci_${Date.now()}`,
    flowId: flow.id,
    projectId: project.id,
    version: 1,
    name: flow.name,
    objective: flow.objective,
    changeHash: "abc123",
    createdBy: user.id,
    createdAt: new Date().toISOString(),
  });
  const versions = await store.listFlowVersions(flow.id);
  if (versions.length !== 1) throw new Error("flow_versions round-trip failed");
  await store.markVersionGreen(flow.id, 1, "run_x");
  const v1 = await store.getFlowVersion(flow.id, 1);
  if (v1?.lastGreenRunId !== "run_x") throw new Error("markVersionGreen failed");

  // Runs + flake source + purge
  const run = await store.upsertRun({
    id: `run_ci_${Date.now()}`,
    projectId: project.id,
    flowId: flow.id,
    objective: "smoke",
    status: "passed",
    startedAt: new Date().toISOString(),
    stepCount: 1,
    flowVersion: 1,
    attempt: 1,
    browser: "firefox",
    healedSteps: 2,
  });
  const recent = await store.listRecentRunsForFlow(flow.id, 5);
  if (recent.length !== 1 || recent[0].browser !== "firefox") throw new Error("run metadata round-trip failed");
  if (run.healedSteps !== 2) throw new Error("healedSteps round-trip failed");

  // Webhooks + audit
  await store.saveWebhook({ id: `wh_ci_${Date.now()}`, projectId: project.id, url: "https://example.com/hook", secret: "s", events: ["*"], createdAt: new Date().toISOString() });
  const hooks = await store.listWebhooks(project.id);
  if (hooks.length !== 1) throw new Error("webhook round-trip failed");
  await store.addAudit({ id: `aud_ci_${Date.now()}`, projectId: project.id, actor: user.id, action: "ci.smoke", createdAt: new Date().toISOString() });
  const audit = await store.listAudit(project.id);
  if (audit.length !== 1) throw new Error("audit round-trip failed");

  // Retention purge
  const purged = await store.purgeRunsBefore(project.id, new Date(Date.now() + 1000).toISOString());
  if (purged.runs !== 1) throw new Error("purge failed");

  console.log("pg-smoke OK: users/sessions, flows+versions+green, runs+metadata, webhooks, audit, retention");
  process.exit(0);
} catch (err) {
  console.error("pg-smoke FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await store.close?.().catch(() => {});
}
