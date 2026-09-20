import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { MemoryStore, resetRateLimits } from "./store.js";
import { FsBlobStore } from "./blobs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The auth rate limiter buckets all test requests under one shared IP;
// clear the window between tests so each starts with a fresh budget.
beforeEach(() => resetRateLimits());

async function json(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${res.status} ${path} → non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body };
}

describe("Veriflow API", () => {
  it("signs up, creates a key, enforces quota, stores runs and spans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-api-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const health = await json(app, "/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", password: "password1" }),
    });
    expect(signup.status).toBe(200);
    const token = signup.body.token as string;
    const auth = { authorization: `Bearer ${token}` };

    const me = await json(app, "/v1/me", { headers: auth });
    expect((me.body.user as { email: string }).email).toBe("a@example.com");

    const projects = await json(app, "/v1/projects", { headers: auth });
    const projectId = (projects.body.projects as { id: string }[])[0].id;
    const keyRes = await json(app, `/v1/projects/${projectId}/keys`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "ci" }),
    });
    expect(keyRes.status).toBe(200);
    const apiKey = keyRes.body.key as string;
    expect(apiKey.startsWith("vf_")).toBe(true);

    const ingest = await json(app, "/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        id: "run_test1",
        objective: "heading",
        status: "passed",
        startedAt: new Date().toISOString(),
        stepCount: 1,
        costUsd: 0.02,
        events: [
          { ts: new Date().toISOString(), type: "decide", payload: { action: { type: "finish", success: true, reason: "ok" } } },
        ],
        spans: [
          {
            id: "sp1",
            runId: "run_test1",
            kind: "VERIFY",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            ok: true,
          },
        ],
        files: [{ path: "screenshots/step-0.png", contentBase64: Buffer.from("png").toString("base64") }],
      }),
    });
    expect(ingest.status).toBe(200);

    const got = await json(app, "/v1/runs/run_test1", { headers: { "x-api-key": apiKey } });
    expect(got.status).toBe(200);
    expect((got.body.spans as unknown[]).length).toBe(1);

    const usage = await json(app, "/v1/usage", { headers: auth });
    expect((usage.body.used as number) >= 1).toBe(true);

    const upgrade = await json(app, "/v1/billing/upgrade", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ tier: "starter" }),
    });
    expect(upgrade.status).toBe(200);
    expect((upgrade.body.user as { tier: string }).tier).toBe("starter");

    const alerts = await json(app, "/v1/alerts", { headers: auth });
    expect(alerts.status).toBe(200);
    expect(Array.isArray(alerts.body.alerts)).toBe(true);

    const trace = await json(app, "/v1/runs/run_test1/trace", { headers: { "x-api-key": apiKey } });
    expect(trace.status).toBe(200);
    expect((trace.body.screenshots as unknown[]).length).toBeGreaterThan(0);
  });

  it("derives real step status, filters runs, and serves OTLP JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-filters-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "f@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    const ts = new Date().toISOString();
    await json(app, "/v1/runs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: "run_mix1",
        flowId: "flow_A",
        objective: "mixed outcome",
        status: "failed",
        events: [
          { ts, type: "decide", stepIndex: 0, payload: { action: { type: "click", target: { ref: "@e1" } } } },
          { ts, type: "act", stepIndex: 0, payload: { ok: false, detail: "ref gone" } },
          { ts, type: "decide", stepIndex: 1, payload: { action: { type: "finish", success: false, reason: "gave up" } } },
          { ts, type: "verify", stepIndex: 1, payload: { finish: true, success: false, reason: "gave up" } },
        ],
      }),
    });
    const got = await json(app, "/v1/runs/run_mix1", { headers: auth });
    const steps = got.body.steps as { index: number; status: string }[];
    expect(steps.find((s) => s.index === 0)?.status).toBe("failed");

    const failedOnly = await json(app, "/v1/runs?status=failed", { headers: auth });
    expect((failedOnly.body.runs as { id: string }[]).every((r) => r.status === "failed")).toBe(true);
    const flowOnly = await json(app, "/v1/runs?flowId=flow_A", { headers: auth });
    expect((flowOnly.body.runs as { id: string }[]).length).toBe(1);

    const otlp = await json(app, "/v1/runs/run_mix1/otlp", { headers: auth });
    expect(otlp.status).toBe(200);
  });

  it("manages alert rules and flags triggered ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-rules-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "r@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    // (channel defaults to the generic webhook)
    const created = await json(app, "/v1/alerts/rules", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ metric: "success_rate", threshold: 0.9 }),
    });
    expect(created.status).toBe(200);
    const ruleId = (created.body.rule as { id: string }).id;

    // Seed enough failed runs to trip the success-rate rule.
    const ts = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      await json(app, "/v1/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ objective: `fail run ${i}`, status: "failed" }),
      });
    }
    const alerts = await json(app, "/v1/alerts", { headers: auth });
    const triggered = alerts.body.triggeredRules as { ruleId: string }[];
    expect(triggered.some((t) => t.ruleId === ruleId)).toBe(true);

    const rules = await json(app, "/v1/alerts/rules", { headers: auth });
    const saved = (rules.body.rules as { id: string; lastTriggeredAt?: string }[]).find((r) => r.id === ruleId);
    expect(saved?.lastTriggeredAt).toBeTruthy();

    const deleted = await json(app, `/v1/alerts/rules/${ruleId}`, { method: "DELETE", headers: auth });
    expect(deleted.status).toBe(200);
  });

  it("syncs per-user progress (onboarding + tour) across sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-progress-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "p@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    // Empty initially.
    const empty = await json(app, "/v1/progress", { headers: auth });
    expect((empty.body.progress as { onboardingDone: string[] }).onboardingDone).toEqual([]);

    // PUT merges and persists: onboarding actions + paused tour step.
    const put1 = await json(app, "/v1/progress", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ onboardingDone: ["queue_run", "scrub_trace"], tourStep: 2, tourMode: "interactive" }),
    });
    expect(put1.status).toBe(200);
    expect((put1.body.progress as { onboardingDone: string[] }).onboardingDone).toEqual(["queue_run", "scrub_trace"]);

    // A later PUT with only onboarding fields keeps the tour step (merge).
    const put2 = await json(app, "/v1/progress", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ onboardingDone: ["queue_run", "scrub_trace", "create_flow"] }),
    });
    const merged = put2.body.progress as { tourStep?: number; onboardingDone: string[] };
    expect(merged.tourStep).toBe(2);
    expect(merged.onboardingDone).toEqual(["queue_run", "scrub_trace", "create_flow"]);

    // Union semantics: a device that only knows about queue_run doesn't erase
    // the other ticks, invalid names are dropped, and dismissal is sticky.
    const put3 = await json(app, "/v1/progress", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ onboardingDone: ["queue_run", "nope"], onboardingDismissed: true }),
    });
    const sanitized = put3.body.progress as { onboardingDone: string[]; onboardingDismissed: boolean };
    expect(sanitized.onboardingDone).toEqual(["queue_run", "scrub_trace", "create_flow"]);
    expect(sanitized.onboardingDismissed).toBe(true);

    // Finishing the tour clears the step on the account.
    const put4 = await json(app, "/v1/progress", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ tourStep: null }),
    });
    expect((put4.body.progress as { tourStep?: number }).tourStep).toBeUndefined();

    // It persists across "sessions".
    const again = await json(app, "/v1/progress", { headers: auth });
    expect((again.body.progress as { tourStep?: number }).tourStep).toBeUndefined();

    // Reset onboarding: DELETE clears the account row entirely.
    const cleared = await json(app, "/v1/progress", { method: "DELETE", headers: auth });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ status: "cleared", deleted: true });
    const afterReset = await json(app, "/v1/progress", { headers: auth });
    expect((afterReset.body.progress as { onboardingDone: string[] }).onboardingDone).toEqual([]);
    // Second delete reports nothing removed.
    const clearedAgain = await json(app, "/v1/progress", { method: "DELETE", headers: auth });
    expect(clearedAgain.body).toEqual({ status: "cleared", deleted: false });
  });

  it("aggregates the onboarding funnel across a team's accounts", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-funnel")) });
    const signup = async (email: string) => {
      const r = await json(app, "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password1" }),
      });
      const headers = { authorization: `Bearer ${r.body.token as string}`, "content-type": "application/json" };
      return headers;
    };
    const a = await signup("f1@example.com");
    const b = await signup("f2@example.com");
    // b joins a's project so the aggregation covers a shared team.
    const projectsA = await json(app, "/v1/projects", { headers: a });
    const projectA = (projectsA.body.projects as { id: string }[])[0].id;
    const inv = await json(app, `/v1/projects/${projectA}/invites`, {
      method: "POST", headers: a, body: JSON.stringify({ email: "f2@example.com", role: "member" }),
    });
    expect(inv.status).toBe(200);
    await json(app, "/v1/invites/accept", { method: "POST", headers: b, body: JSON.stringify({ token: inv.body.acceptToken }) });
    await json(app, "/v1/progress", { method: "PUT", headers: a, body: JSON.stringify({ onboardingDone: ["queue_run", "scrub_trace"] }) });
    await json(app, "/v1/progress", { method: "PUT", headers: b, body: JSON.stringify({ onboardingDone: ["queue_run"] }) });

    const funnel = await json(app, "/v1/onboarding/funnel", { headers: a });
    expect(funnel.status).toBe(200);
    const body = funnel.body as {
      total: number;
      steps: { action: string; count: number; pct: number }[];
      completedAll: number;
    };
    expect(body.total).toBe(2);
    expect(body.steps.find((s) => s.action === "queue_run")).toEqual({ action: "queue_run", count: 2, pct: 100 });
    expect(body.steps.find((s) => s.action === "scrub_trace")).toEqual({ action: "scrub_trace", count: 1, pct: 50 });
    expect(body.steps.find((s) => s.action === "create_flow")?.count).toBe(0);
    expect(body.completedAll).toBe(0);
  });

  it("gates the funnel to admins and demo reset to members (role-based)", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-tier")) });
    const signup = async (email: string) => {
      const r = await json(app, "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password1" }),
      });
      return { authorization: `Bearer ${r.body.token as string}`, "content-type": "application/json" };
    };
    const owner = await signup("owner@example.com");
    const member = await signup("member@example.com");
    const outsider = await signup("outsider@example.com");

    const projects = await json(app, "/v1/projects", { headers: owner });
    const projectId = (projects.body.projects as { id: string }[])[0].id;

    // Owner invites the member as "member"; the member accepts via token.
    const inv = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    });
    expect(inv.status).toBe(200);
    const accepted = await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: member,
      body: JSON.stringify({ token: inv.body.acceptToken }),
    });
    expect(accepted.status).toBe(200);

    // Member (not admin): demo reset allowed, funnel denied.
    const memberReset = await json(app, "/v1/demo-reset", { method: "POST", headers: member });
    expect(memberReset.status).toBe(200);
    const memberFunnel = await json(app, "/v1/onboarding/funnel", { headers: member });
    expect(memberFunnel.status).toBe(403);

    // Non-member: nothing.
    const outsiderFunnel = await json(app, "/v1/onboarding/funnel", { headers: outsider });
    expect(outsiderFunnel.status).toBe(403);
    const outsiderMembers = await json(app, `/v1/projects/${projectId}/members`, { headers: outsider });
    expect(outsiderMembers.status).toBe(403);

    // Owner: everything.
    const ownerFunnel = await json(app, "/v1/onboarding/funnel", { headers: owner });
    expect(ownerFunnel.status).toBe(200);
  });

  it("manages team roles: invite → accept → role matrix → owner protections", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-roles")) });
    const signup = async (email: string) => {
      const r = await json(app, "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password1" }),
      });
      return { authorization: `Bearer ${r.body.token as string}`, "content-type": "application/json" };
    };
    const owner = await signup("boss@example.com");
    const admin = await signup("admin@example.com");
    const member = await signup("worker@example.com");
    const viewer = await signup("watcher@example.com");

    const projects = await json(app, "/v1/projects", { headers: owner });
    const projectId = (projects.body.projects as { id: string }[])[0].id;

    // Invite the admin.
    const invAdmin = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST", headers: owner, body: JSON.stringify({ email: "admin@example.com", role: "admin" }),
    });
    expect(invAdmin.status).toBe(200);
    expect((await json(app, "/v1/invites/accept", { method: "POST", headers: admin, body: JSON.stringify({ token: invAdmin.body.acceptToken }) })).status).toBe(200);

    // Owner protections: cannot invite above… actually invites can't be owner.
    const invOwner = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST", headers: owner, body: JSON.stringify({ email: "x@example.com", role: "owner" }),
    });
    expect(invOwner.status).toBe(400);

    // Invite wrong-email guard.
    const invWrong = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST", headers: owner, body: JSON.stringify({ email: "someone-else@example.com", role: "viewer" }),
    });
    const wrongAccept = await json(app, "/v1/invites/accept", { method: "POST", headers: member, body: JSON.stringify({ token: invWrong.body.acceptToken }) });
    expect(wrongAccept.status).toBe(403);

    // Admin (invited by owner) invites member + viewer — admin rank suffices.
    const invMember = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST", headers: admin, body: JSON.stringify({ email: "worker@example.com", role: "member" }),
    });
    expect(invMember.status).toBe(200);
    await json(app, "/v1/invites/accept", { method: "POST", headers: member, body: JSON.stringify({ token: invMember.body.acceptToken }) });
    const invViewer = await json(app, `/v1/projects/${projectId}/invites`, {
      method: "POST", headers: admin, body: JSON.stringify({ email: "watcher@example.com", role: "viewer" }),
    });
    await json(app, "/v1/invites/accept", { method: "POST", headers: viewer, body: JSON.stringify({ token: invViewer.body.acceptToken }) });

    // Member list shows all four roles.
    const members = await json(app, `/v1/projects/${projectId}/members`, { headers: owner });
    expect(members.status).toBe(200);
    const roles = (members.body.members as { email?: string; role: string }[]).map((m) => m.role).sort();
    expect(roles).toEqual(["admin", "member", "owner", "viewer"]);

    // Viewer: read ok, write denied — viewer can't mint API keys.
    const viewerKeys = await json(app, `/v1/projects/${projectId}/keys`, { method: "POST", headers: viewer, body: JSON.stringify({ name: "k" }) });
    expect(viewerKeys.status).toBe(403);
    // Member: can mint keys.
    const memberKeys = await json(app, `/v1/projects/${projectId}/keys`, { method: "POST", headers: member, body: JSON.stringify({ name: "k" }) });
    expect(memberKeys.status).toBe(200);

    // Role matrix on invites: viewer can't invite, member can't invite, admin can.
    for (const [who, expected] of [[viewer, 403], [member, 403], [admin, 200]] as const) {
      const res = await json(app, `/v1/projects/${projectId}/invites`, {
        method: "POST", headers: who, body: JSON.stringify({ email: `new-${Math.random().toString(36).slice(2)}@example.com`, role: "viewer" }),
      });
      expect(res.status).toBe(expected);
    }

    // Owner protections come first: admin can't remove/demote the owner.
    const ownerId = ((members.body.members as { role: string; userId: string }[]).find((m) => m.role === "owner")!).userId;
    const removeOwner = await json(app, `/v1/projects/${projectId}/members/${ownerId}`, { method: "DELETE", headers: admin });
    expect(removeOwner.status).toBe(400);

    // Member can't remove the admin; owner can.
    const adminId = ((members.body.members as { email?: string; userId: string }[]).find((m) => m.email === "admin@example.com")!).userId;
    const memberRemovesAdmin = await json(app, `/v1/projects/${projectId}/members/${adminId}`, { method: "DELETE", headers: member });
    expect(memberRemovesAdmin.status).toBe(403);
    const ownerRemovesAdmin = await json(app, `/v1/projects/${projectId}/members/${adminId}`, { method: "DELETE", headers: owner });
    expect(ownerRemovesAdmin.status).toBe(200);
  });

  it("delivers alert-rule and human-pause notifications with retry (email/slack)", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-deliver")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pager@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    // A flaky receiver: fails the first two attempts, then 200s. Verifies the
    // retry policy actually re-POSTs instead of giving up after one failure.
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503);
        res.end("nope");
        return;
      }
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        res.writeHead(200);
        res.end(raw || "ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    // Rule delivering to Slack — the receiver doubles as a Slack webhook.
    const rule = await json(app, "/v1/alerts/rules", {
      method: "POST", headers: auth,
      body: JSON.stringify({ metric: "success_rate", threshold: 0.99, channel: `slack:http://127.0.0.1:${port}/hook` }),
    });
    expect(rule.status).toBe(200);

    // Bad channel format is rejected.
    const badRule = await json(app, "/v1/alerts/rules", {
      method: "POST", headers: auth,
      body: JSON.stringify({ metric: "success_rate", threshold: 0.5, channel: "carrier-pigeon:huh" }),
    });
    expect(badRule.status).toBe(400);

    // Trigger the rule: make the success rate low by ingesting a failed run.
    const projects = await json(app, "/v1/projects", { headers: auth });
    const projectId = (projects.body.projects as { id: string }[])[0].id;
    await json(app, "/v1/runs", {
      method: "POST", headers: auth,
      body: JSON.stringify({ id: "run_pager", projectId, status: "failed", startedAt: new Date().toISOString(), kind: "browser", objective: "x", costUsd: 0.01, steps: 1 }),
    });
    const evalRes = await json(app, "/v1/alerts", { headers: auth });
    expect(evalRes.status).toBe(200);
    expect(evalRes.body.delivery).toBe("multi_channel");
    const summary = evalRes.body as { delivered: number; failed: number; results: { status: string; attempts: number }[] };
    expect(summary.delivered).toBeGreaterThanOrEqual(1);
    expect(summary.results.some((r) => r.attempts === 3)).toBe(true);

    // Human pause → delivery to the same rule's channel.
    const pause = await json(app, "/v1/human-pauses", {
      method: "POST", headers: auth,
      body: JSON.stringify({ runId: "run_pager", reason: "captcha" }),
    });
    expect(pause.status).toBe(200);
    const pauseSummary = pause.body as { delivery: { delivered: number } };
    expect(pauseSummary.delivery.delivered).toBeGreaterThanOrEqual(1);

    // Email with no transport → skipped, not failed.
    const emailRule = await json(app, "/v1/alerts/rules", {
      method: "POST", headers: auth,
      body: JSON.stringify({ metric: "cost_spike", threshold: 999, channel: "email:ops@example.com" }),
    });
    expect(emailRule.status).toBe(200);
    server.close();
  });

  it("generates a GitHub Actions cron workflow for a scheduled flow", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-yaml")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "cron@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    const flow = await json(app, "/v1/flows", {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "nightly checkout", objective: "buy things", schedule: "0 3 * * *" }),
    });
    expect(flow.status).toBe(200);
    const flowId = (flow.body.flow as { id: string }).id;

    const gen = await json(app, `/v1/flows/${flowId}/cron-workflow`, { headers: auth });
    expect(gen.status).toBe(200);
    expect(gen.body.filename).toContain(flowId);
    const yaml = gen.body.workflow as string;
    expect(yaml).toContain("cron: \"0 3 * * *\"");
    expect(yaml).toContain("veriflow schedules due --execute");
    expect(yaml).toContain("secrets.VERIFLOW_API_KEY");

    // Free-form generator validates the cron expression.
    const bad = await json(app, "/v1/flows/cron-workflow", {
      method: "POST", headers: auth, body: JSON.stringify({ schedule: "nope" }),
    });
    expect(bad.status).toBe(400);
    const good = await json(app, "/v1/flows/cron-workflow", {
      method: "POST", headers: auth, body: JSON.stringify({ schedule: "*/10 * * * *", flowName: "all" }),
    });
    expect(good.status).toBe(200);
    expect(good.body.workflow as string).toContain("*/10 * * * *");
  });

  it("demo reset wipes the project's runs, flows, rules, and ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-reset-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reset@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    await json(app, "/v1/billing/upgrade", { method: "POST", headers: auth, body: JSON.stringify({ tier: "team" }) });

    // Create a run (with steps, spans, and a blob), a flow, an alert rule, and usage.
    const ing = await json(app, "/v1/runs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        objective: "demo run",
        envUrl: "https://example.com",
        status: "passed",
        steps: [{ index: 0, type: "navigate", label: "goto", status: "ok" }],
        spans: [{ id: "sp1", type: "act", label: "goto", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
        files: [{ path: "trace.json", contentBase64: Buffer.from("{}").toString("base64") }],
      }),
    });
    expect(ing.status).toBe(200);
    const runId = (ing.body as { run?: { id?: string }; id?: string }).run?.id ?? (ing.body as { id?: string }).id;
    if (!runId) throw new Error(`ingest returned no run id: ${JSON.stringify(ing.body).slice(0, 200)}`);
    await json(app, "/v1/flows", { method: "POST", headers: auth, body: JSON.stringify({ name: "demo-flow", objective: "x" }) });
    await json(app, "/v1/alerts/rules", { method: "POST", headers: auth, body: JSON.stringify({ metric: "cost_spike", threshold: 10 }) });

    // Everything exists before the reset.
    expect(((await json(app, "/v1/runs", { headers: auth })).body.runs as unknown[]).length).toBe(1);
    expect(((await json(app, "/v1/flows", { headers: auth })).body.flows as unknown[]).length).toBe(1);
    expect(((await json(app, "/v1/alerts/rules", { headers: auth })).body.rules as unknown[]).length).toBe(1);

    const reset = await json(app, "/v1/demo-reset", { method: "POST", headers: auth });
    expect(reset.status).toBe(200);
    const body = reset.body as { runs: number; flows: number; alertRules: number; blobsRemoved: number };
    expect(body.runs).toBe(1);
    expect(body.flows).toBe(1);
    expect(body.alertRules).toBe(1);
    expect(body.blobsRemoved).toBeGreaterThanOrEqual(1);

    // Everything is gone after the reset.
    expect(((await json(app, "/v1/runs", { headers: auth })).body.runs as unknown[]).length).toBe(0);
    expect(((await json(app, "/v1/flows", { headers: auth })).body.flows as unknown[]).length).toBe(0);
    expect(((await json(app, "/v1/alerts/rules", { headers: auth })).body.rules as unknown[]).length).toBe(0);
    const runFetch = await json(app, `/v1/runs/${runId}`, { headers: auth });
    expect(runFetch.status).toBe(404);
    // ...and the run lookup for the blob route is gone, so evidence is unreachable.
    const blobFetch = await json(app, `/v1/runs/${runId}/blobs/trace.json`, { headers: auth });
    expect(blobFetch.status).toBe(404);
  });

  it("creates, lists, and resolves a human pause (CI magic link)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-pause-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "p@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    const created = await json(app, "/v1/human-pauses", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runId: "run_otp", reason: "otp", prompt: "enter the code", ttlSeconds: 60 }),
    });
    expect(created.status).toBe(200);
    const pause = created.body.pause as { id: string; status: string };
    expect(pause.status).toBe("pending");
    expect(created.body.magicLink).toBe(`/human-pauses/${pause.id}`);

    const listed = await json(app, "/v1/human-pauses", { headers: auth });
    expect((listed.body.pauses as unknown[]).length).toBe(1);

    const resolveAgain = await json(app, `/v1/human-pauses/${pause.id}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ response: "code 123456 entered" }),
    });
    expect(resolveAgain.status).toBe(200);
    expect((resolveAgain.body.pause as { status: string }).status).toBe("resolved");

    // Resolving twice must 409 — the run must not resume on a stale link.
    const second = await json(app, `/v1/human-pauses/${pause.id}/resolve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
  });

  it("runs an agent test against a stub chat endpoint and ingests it as a run", async () => {
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const last = String(body).match(/"content":"([^"]*)"\}\]$/)?.[1] ?? "";
        const orderId = last.match(/A-\d+/)?.[0];
        const reply = orderId
          ? `Noted, order ${orderId}.`
          : /reset/i.test(last)
            ? "Visit /reset and enter your email."
            : /trash/i.test(last)
              ? "Sorry you're upset — how can I help?"
              : /1-hour/i.test(last)
                ? "Refunds take 5 business days."
                : /who are you/i.test(last)
                  ? "I'm Acme support, happy to help."
                  : "I only handle orders, refunds, and account questions.";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r as never));
    const port = (stub.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), "vf-agent-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ag@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    const res = await json(app, "/v1/agent-tests", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${port}/chat`, scenarios: 12 }),
    });
    expect(res.status).toBe(200);
    const report = res.body.report as { verdict: string; turns: unknown[]; metrics: { passRate: number } };
    expect(["green", "yellow", "red"]).toContain(report.verdict);
    expect(report.metrics.passRate).toBeLessThanOrEqual(1);
    expect(report.turns.length).toBeGreaterThan(10);

    const runId = res.body.runId as string;
    const got = await json(app, `/v1/runs/${runId}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(String((got.body.run as { objective: string }).objective)).toContain("agent-test");
    stub.close();
  });

  it("computes per-flow metric rollups from stored events (spec 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-roll-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "m@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    const ts = new Date().toISOString();

    // Flow A: one passed run with a successful self-heal; one failed run with a human pause + guard abort.
    await json(app, "/v1/runs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: "run_roll_a1",
        flowId: "flow_A",
        objective: "ok run",
        status: "passed",
        stepCount: 4,
        costUsd: 0.02,
        events: [
          { ts, type: "decide", stepIndex: 0, payload: { action: { type: "click", target: { ref: "@e1" } } } },
          { ts, type: "retry", stepIndex: 0, payload: { ok: false } },
          { ts, type: "retry", stepIndex: 0, payload: { ok: true, healed: true } },
        ],
      }),
    });
    await json(app, "/v1/runs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: "run_roll_a2",
        flowId: "flow_A",
        objective: "blocked run",
        status: "failed",
        stepCount: 2,
        costUsd: 0.04,
        events: [
          { ts, type: "human", stepIndex: 1, payload: { reason: "otp" } },
          { ts, type: "guard", stepIndex: 2, payload: { ok: false, code: "loop_detected" } },
        ],
      }),
    });
    // Flow B: single passing run.
    await json(app, "/v1/runs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "run_roll_b1", flowId: "flow_B", objective: "fine", status: "passed", stepCount: 1 }),
    });

    const refreshed = await json(app, "/v1/metrics/rollups/refresh", { method: "POST", headers: auth });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshed as number).toBe(4); // 2 flows x 2 windows

    const all = await json(app, "/v1/metrics/rollups", { headers: auth });
    const rollups = all.body.rollups as Array<{
      flowId: string;
      windowDays: number;
      runs: number;
      successRate: number;
      selfHealRate: number;
      humanInterventionRate: number;
      guardAbortRate: number;
      medianSteps: number;
      avgCostUsd: number;
    }>;
    const a30 = rollups.find((r) => r.flowId === "flow_A" && r.windowDays === 30)!;
    expect(a30.runs).toBe(2);
    expect(a30.successRate).toBeCloseTo(0.5);
    expect(a30.selfHealRate).toBeCloseTo(0.5); // 1 of 2 retries healed
    expect(a30.humanInterventionRate).toBeCloseTo(0.5); // 1 pause in 2 runs
    expect(a30.guardAbortRate).toBeCloseTo(0.5);
    expect(a30.medianSteps).toBe(3); // median of 4 and 2
    expect(a30.avgCostUsd).toBeCloseTo(0.03);

    const bOnly = await json(app, "/v1/metrics/rollups?flowId=flow_B", { headers: auth });
    const b = (bOnly.body.rollups as Array<{ flowId: string }>);
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b.every((r) => r.flowId === "flow_B")).toBe(true);
  });

  it("returns 402 when monthly cloud quota is exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-quota-"));
    class TightQuotaStore extends MemoryStore {
      async monthlyRunCount(): Promise<number> {
        return 50;
      }
    }
    const app = createApp({ store: new TightQuotaStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "q@example.com", password: "password1" }),
    });
    const token = signup.body.token as string;
    const blocked = await json(app, "/v1/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ objective: "x", status: "passed" }),
    });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe("quota_exceeded");
  });

  it("rate-limits the auth endpoints (429 after the burst window)", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-rl")) });
    const attempt = (n: number) =>
      json(app, "/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
        body: JSON.stringify({ email: `u${n}@example.com`, password: "wrongpass1" }),
      });
    // Limit is 10 per window — the 11th gets a 429.
    for (let i = 0; i < 10; i++) {
      const res = await attempt(i);
      expect(res.status).toBe(401);
    }
    const blocked = await attempt(11);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("too many attempts");
    // A different IP still has its own budget.
    const otherIp = await json(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.2" },
      body: JSON.stringify({ email: "x@example.com", password: "wrongpass1" }),
    });
    expect(otherIp.status).toBe(401);
  });

  it("expires sessions after the TTL and supports httpOnly cookie auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-sess-"));
    const store = new MemoryStore();
    const app = createApp({ store, blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "cookie@example.com", password: "password1", setCookie: true }),
    });
    const token = signup.body.token as string;

    // Cookie-only request authenticates (token never in a header).
    const viaCookie = await json(app, "/v1/me", {
      headers: { cookie: `vf_session=${token}` },
    });
    expect(viaCookie.status).toBe(200);
    expect((viaCookie.body.user as { email: string }).email).toBe("cookie@example.com");

    // Force-expire the session: the cookie and the bearer both stop working.
    const rows = await (store as unknown as { db: { sessions: { tokenHash: string; createdAt: string }[] } }).db.sessions;
    const session = rows.find(() => true);
    expect(session).toBeDefined();
    session!.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const expiredBearer = await json(app, "/v1/me", { headers: { authorization: `Bearer ${token}` } });
    expect(expiredBearer.status).toBe(401);
    const expiredCookie = await json(app, "/v1/me", { headers: { cookie: `vf_session=${token}` } });
    expect(expiredCookie.status).toBe(401);
  });

  it("claims due scheduled flows exactly once per minute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-sched-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sched@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    const bad = await json(app, "/v1/flows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "bad", objective: "x", schedule: "not a cron" }),
    });
    expect(bad.status).toBe(400);

    const made = await json(app, "/v1/flows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "nightly", objective: "check the cart", schedule: "* * * * *" }),
    });
    expect(made.status).toBe(200);
    expect((made.body.flow as { schedule?: string }).schedule).toBe("* * * * *");
    const flowId = (made.body.flow as { id: string }).id;

    // Same minute, two claims: the first lists the flow, the second is empty.
    const now = new Date("2026-09-19T12:00:00.000Z");
    const first = await json(app, "/v1/schedules/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ now: now.toISOString() }),
    });
    expect(first.body.due).toHaveLength(1);
    expect((first.body.due as { flowId: string }[])[0].flowId).toBe(flowId);
    const second = await json(app, "/v1/schedules/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ now: now.toISOString() }),
    });
    expect(second.body.due).toHaveLength(0);

    // A later minute claims again.
    const later = await json(app, "/v1/schedules/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ now: new Date(now.getTime() + 60_000).toISOString() }),
    });
    expect(later.body.due).toHaveLength(1);

    // Clearing the schedule (null) detaches the flow from the scheduler.
    const cleared = await json(app, "/v1/flows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: flowId, name: "nightly", objective: "check the cart", schedule: null }),
    });
    expect(cleared.status).toBe(200);
    const afterClear = await json(app, "/v1/schedules/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ now: new Date(now.getTime() + 120_000).toISOString() }),
    });
    expect(afterClear.body.due).toHaveLength(0);
  });

  it("device cloud: register, queue, claim FIFO, complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-dev-"));
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(dir, "blobs")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };

    const reg = await json(app, "/v1/devices", { method: "POST", headers: auth, body: JSON.stringify({ name: "worker-1" }) });
    expect(reg.status).toBe(200);
    const deviceId = (reg.body.device as { id: string }).id;

    // Empty claim.
    const empty = await json(app, "/v1/devices/${deviceId}/claim".replace("${deviceId}", deviceId), { method: "POST", headers: auth, body: "{}" });
    expect(empty.body.job).toBeNull();

    // Queue two jobs (one via flowId indirection), claim FIFO.
    const flow = await json(app, "/v1/flows", { method: "POST", headers: auth, body: JSON.stringify({ name: "f", objective: "flow objective text" }) });
    await json(app, "/v1/device-jobs", { method: "POST", headers: auth, body: JSON.stringify({ objective: "first job", envUrl: "https://example.com" }) });
    await json(app, "/v1/device-jobs", { method: "POST", headers: auth, body: JSON.stringify({ flowId: (flow.body.flow as { id: string }).id }) });

    const claim1 = await json(app, `/v1/devices/${deviceId}/claim`, { method: "POST", headers: auth, body: "{}" });
    expect((claim1.body.job as { objective: string }).objective).toBe("first job");
    const claim2 = await json(app, `/v1/devices/${deviceId}/claim`, { method: "POST", headers: auth, body: "{}" });
    expect((claim2.body.job as { objective: string }).objective).toBe("flow objective text");
    const jobId = (claim2.body.job as { id: string }).id;

    const done = await json(app, `/v1/device-jobs/${jobId}/complete`, { method: "POST", headers: auth, body: JSON.stringify({ runId: "run_x" }) });
    expect((done.body.job as { status: string }).status).toBe("done");

    const devices = await json(app, "/v1/devices", { headers: auth });
    expect((devices.body.devices as { status: string }[])[0].status).toBe("online");
  });

  it("redteam endpoint ingests a probe run (safe stub => green)", async () => {
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        // A well-behaved agent: refuses everything.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply: "Sorry, I cannot help with that. I only support Acme orders." }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r as never));
    const port = (stub.address() as { port: number }).port;
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-rt")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rt@example.com", password: "password1" }),
    });
    const auth = { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" };
    const res = await json(app, "/v1/redteam", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${port}/chat` }),
    });
    expect(res.status).toBe(200);
    const report = res.body.report as { verdict: string; mode: string; turns: { pass: boolean }[] };
    expect(report.verdict).toBe("green");
    expect(report.turns.length).toBeGreaterThanOrEqual(8);
    const got = await json(app, `/v1/runs/${res.body.runId as string}`, { headers: auth });
    expect(String((got.body.run as { objective: string }).objective)).toContain("redteam");
    stub.close();
  });

  it("stripe webhook flips the tier on a valid signature and rejects bad ones", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-stripe")) });
    const signup = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bill@example.com", password: "password1" }),
    });
    const userId = (signup.body.user as { id: string }).id;
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_123", metadata: { userId, tier: "team" } } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const { createHmac } = await import("node:crypto");
    const sig = `t=${timestamp},v1=${createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex")}`;

    const ok = await json(app, "/v1/billing/stripe-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: payload,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.tier).toBe("team");

    const bad = await json(app, "/v1/billing/stripe-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)}` },
      body: payload,
    });
    expect(bad.status).toBe(400);

    // Simulated upgrade still works without Stripe env configured.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const sim = await json(app, "/v1/billing/upgrade", {
      method: "POST",
      headers: { authorization: `Bearer ${signup.body.token as string}`, "content-type": "application/json" },
      body: JSON.stringify({ tier: "starter" }),
    });
    expect(sim.body.status).toBe("upgraded");
  });

  it("workspace layer: create, invite, cross-project roles, attach, usage rollup", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-ws")) });
    const signup = async (email: string) => {
      const r = await json(app, "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": email },
        body: JSON.stringify({ email, password: "password1" }),
      });
      return { token: r.body.token as string, id: (r.body.user as { id: string }).id };
    };
    const owner = await signup("ws-owner@example.com");
    const mate = await signup("ws-mate@example.com");
    const H = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

    // Create a workspace and invite the teammate as a workspace admin.
    const ws = await json(app, "/v1/workspaces", {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ name: "Acme QA" }),
    });
    expect(ws.status).toBe(201);
    const wsId = ws.body.workspace.id as string;

    const inv = await json(app, `/v1/workspaces/${wsId}/invites`, {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ email: "ws-mate@example.com", role: "admin" }),
    });
    expect(inv.status).toBe(201);
    const accepted = await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: H(mate.token),
      body: JSON.stringify({ token: inv.body.invite.token as string }),
    });
    expect(accepted.status).toBe(200);

    // Mate (workspace admin) can add members to the workspace.
    const third = await signup("ws-third@example.com");
    const added = await json(app, `/v1/workspaces/${wsId}/members`, {
      method: "POST",
      headers: H(mate.token),
      body: JSON.stringify({ email: "ws-third@example.com", role: "viewer" }),
    });
    expect(added.status).toBe(201);
    expect(third.id).toBeTruthy();

    // Owner's project attaches to the workspace; mate gains access WITHOUT a
    // per-project membership — and can even create flows in it.
    const proj = await json(app, "/v1/projects", {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ name: "Owned project" }),
    });
    const projectId = proj.body.project.id as string;
    const attach = await json(app, `/v1/workspaces/${wsId}/projects`, {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ projectId }),
    });
    expect(attach.status).toBe(200);

    const flow = await json(app, "/v1/flows", {
      method: "POST",
      headers: H(mate.token),
      body: JSON.stringify({ projectId, name: "Via workspace", objective: "check out" }),
    });
    expect(flow.status).toBe(200);

    // A viewer can't write: add a third user as workspace viewer.
    const peek = await signup("ws-peek@example.com");
    const vInv = await json(app, `/v1/workspaces/${wsId}/invites`, {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ email: "ws-peek@example.com", role: "viewer" }),
    });
    await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: H(peek.token),
      body: JSON.stringify({ token: vInv.body.invite.token as string }),
    });
    const denied = await json(app, "/v1/flows", {
      method: "POST",
      headers: H(peek.token),
      body: JSON.stringify({ projectId, name: "Nope", objective: "x" }),
    });
    expect(denied.status).toBe(403);

    // Workspace-scoped usage rollup: queue a run, check it sums by project.
    await json(app, "/v1/runs", {
      method: "POST",
      headers: H(owner.token),
      body: JSON.stringify({ projectId, objective: "ws rollup run" }),
    });
    const usage = await json(app, `/v1/workspaces/${wsId}/usage`, { headers: H(owner.token) });
    expect(usage.status).toBe(200);
    const rollup = usage.body as { projects: { projectId: string; runs: number }[]; totals: { runs: number } };
    expect(rollup.projects).toHaveLength(1);
    expect(rollup.projects[0].projectId).toBe(projectId);
    expect(rollup.totals.runs).toBe(1);

    // Mate (workspace admin) sees the rollup too.
    const mateUsage = await json(app, `/v1/workspaces/${wsId}/usage`, { headers: H(mate.token) });
    expect(mateUsage.status).toBe(200);

    // Non-members can't see it.
    const stranger = await signup("ws-stranger@example.com");
    const nope = await json(app, `/v1/workspaces/${wsId}/usage`, { headers: H(stranger.token) });
    expect(nope.status).toBe(403);

    // Owner protections: nobody demotes the workspace owner.
    const members = await json(app, `/v1/workspaces/${wsId}/members`, { headers: H(owner.token) });
    const ownerRow = (members.body.members as { userId: string; role: string }[]).find(
      (m) => m.role === "owner",
    );
    expect(ownerRow).toBeDefined();
    const demote = await json(app, `/v1/workspaces/${wsId}/members/${ownerRow!.userId}`, {
      method: "PATCH",
      headers: H(mate.token),
      body: JSON.stringify({ role: "viewer" }),
    });
    expect([400, 403]).toContain(demote.status);
  });

  it("flow versioning: snapshot, history, rollback, last-green", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-ver")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ver@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };

    // v1
    const f1 = await json(app, "/v1/flows", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "checkout", objective: "buy the thing" }),
    });
    expect(f1.body.flow.version).toBe(1);
    // v2 — a real definition change
    const f2 = await json(app, "/v1/flows", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: f1.body.flow.id, name: "checkout", objective: "buy TWO things", note: "double it" }),
    });
    expect(f2.body.flow.version).toBe(2);
    // A no-op save must NOT create v3 (hash-identical).
    const f2b = await json(app, "/v1/flows", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: f1.body.flow.id, name: "checkout", objective: "buy TWO things" }),
    });
    expect(f2b.body.flow.version).toBe(2);

    const hist = await json(app, `/v1/flows/${f1.body.flow.id}/versions`, { headers: H });
    expect(hist.body.versions).toHaveLength(2);
    expect(hist.body.versions[0].version).toBe(2);
    expect(hist.body.versions[0].note).toBe("double it");

    // Rollback to v1 → creates v3 with v1's objective.
    const rb = await json(app, `/v1/flows/${f1.body.flow.id}/rollback`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ version: 1 }),
    });
    expect(rb.body.flow.objective).toBe("buy the thing");
    expect(rb.body.flow.version).toBe(3);

    // Last-green: a passing run stamped with the flow's version marks it green.
    const run = await json(app, "/v1/runs", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ flowId: f1.body.flow.id, objective: "buy the thing", status: "passed", events: [] }),
    });
    expect(run.status).toBe(200);
    const hist2 = await json(app, `/v1/flows/${f1.body.flow.id}/versions`, { headers: H });
    const v3 = (hist2.body.versions as { version: number; lastGreenRunId?: string }[]).find((v) => v.version === 3);
    expect(v3?.lastGreenRunId).toBe(run.body.id);
  });

  it("flake detection + quarantine + retry policy round-trip", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-flake")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "flaky@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };
    const flow = await json(app, "/v1/flows", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "wobbly", objective: "flaky flow", retryPolicy: { maxAttempts: 3, backoffSeconds: 5 } }),
    });
    const flowId = flow.body.flow.id as string;

    // pass-fail-pass-fail → 3 flips over 4 runs → score 1.0. Explicit ascending
    // timestamps: same-millisecond runs would make recency order ambiguous.
    let seq = 0;
    for (const status of ["passed", "failed", "passed", "failed"]) {
      const posted = await json(app, "/v1/runs", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ flowId, objective: "x", status, startedAt: new Date(Date.now() + seq++ * 1_000).toISOString(), events: [] }),
      });
      expect(posted.status).toBe(200);
    }
    const report = await json(app, `/v1/flows/${flowId}/flake`, { headers: H });
    expect(report.body.runsConsidered).toBe(4);
    expect(report.body.flips).toBe(3);
    expect(report.body.flakeScore).toBe(1);
    expect(report.body.retryPolicy).toMatchObject({ maxAttempts: 3, backoffSeconds: 5 });

    // Quarantine: the claim endpoint must skip it.
    await json(app, "/v1/flows", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: flowId, name: "wobbly", objective: "flaky flow", schedule: "* * * * *", quarantined: true }),
    });
    const claim = await json(app, "/v1/schedules/claim", { method: "POST", headers: H, body: JSON.stringify({ now: new Date().toISOString() }) });
    expect((claim.body.due as unknown[]).length).toBe(0);
  });

  it("outbound webhooks: create, HMAC-signed delivery on run events, audit", async () => {
    const { createHmac } = await import("node:crypto");
    const received: { sig: string | null; body: string }[] = [];
    const receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        received.push({ sig: req.headers["veriflow-signature"] ?? null, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r as never));
    const port = (receiver.address() as { port: number }).port;

    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-wh")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "hooks@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };

    const created = await json(app, "/v1/webhooks", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, events: ["*"] }),
    });
    expect(created.status).toBe(201);
    const secret = created.body.webhook.secret as string;

    // A failed run must fire run.failed with a verifiable signature.
    await json(app, "/v1/runs", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ objective: "will fail", status: "failed", error: "boom", events: [] }),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(1);
    const sigMatch = received[0].sig!.match(/t=(\d+),v1=([0-9a-f]+)/);
    expect(sigMatch).toBeTruthy();
    const expected = createHmac("sha256", secret).update(`${sigMatch![1]}.${received[0].body}`).digest("hex");
    expect(sigMatch![2]).toBe(expected);
    expect(received[0].body).toContain("run.failed");

    // Audit trail captured the delivery + webhook creation.
    const audit = await json(app, "/v1/audit", { headers: H });
    const actions = (audit.body.entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain("run.failed");
    expect(actions).toContain("webhook.created");

    // Secrets are never listed back.
    const list = await json(app, "/v1/webhooks", { headers: H });
    expect(JSON.stringify(list.body)).not.toContain(secret);
    receiver.close();
  });

  it("retention purge deletes old runs and reports the tier window", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-ret")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ret@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await json(app, "/v1/runs", { method: "POST", headers: H, body: JSON.stringify({ objective: "ancient", status: "passed", startedAt: old, events: [] }) });
    await json(app, "/v1/runs", { method: "POST", headers: H, body: JSON.stringify({ objective: "fresh", status: "passed", events: [] }) });
    const purge = await json(app, "/v1/retention/purge", { method: "POST", headers: H, body: JSON.stringify({}) });
    expect(purge.body.retentionDays).toBe(7); // free tier
    expect(purge.body.runsPurged).toBeGreaterThanOrEqual(1);
    const runs = await json(app, "/v1/runs", { headers: H });
    const objectives = (runs.body.runs as { objective: string }[]).map((r) => r.objective);
    expect(objectives).not.toContain("ancient");
    expect(objectives).toContain("fresh");
  });

  it("cost cap: setting a cap makes run ingest 402 once spend exceeds it", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-cap")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "cap@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };
    await json(app, "/v1/settings/cost-cap", { method: "POST", headers: H, body: JSON.stringify({ costCapUsd: 0.001 }) });
    // First run is within cap (incoming 0).
    const ok = await json(app, "/v1/runs", { method: "POST", headers: H, body: JSON.stringify({ objective: "cheap", status: "passed", events: [] }) });
    expect(ok.status).toBe(200);
    // Second run costs more than the remaining cap → 402 cost_cap_exceeded.
    const blocked = await json(app, "/v1/runs", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ objective: "pricey", status: "passed", costUsd: 1, events: [] }),
    });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe("cost_cap_exceeded");
  });

  it("live frames: ingest + SSE stream replay", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-live")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "live@example.com", password: "password1" }),
    });
    const H = { authorization: `Bearer ${su.body.token as string}`, "content-type": "application/json" };
    const run = await json(app, "/v1/runs", { method: "POST", headers: H, body: JSON.stringify({ objective: "live", status: "running", events: [] }) });
    const runId = run.body.id as string;

    const pushed = await json(app, `/v1/runs/${runId}/frames`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ stepIndex: 0, url: "http://x.test/", pngBase64: Buffer.from("png0").toString("base64") }),
    });
    expect(pushed.status).toBe(200);

    // SSE: subscribe with the token in the query string (EventSource can't set
    // headers) and expect the hello event + replayed frame. Unauthenticated → 401.
    const denied = await app.request(`/v1/runs/${runId}/stream`);
    expect(denied.status).toBe(401);
    const res = await app.request(`/v1/runs/${runId}/stream?token=${su.body.token as string}`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !text.includes("cG5nMA==")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel().catch(() => {});
    expect(text).toContain("event: frame");
    expect(text).toContain("event: hello");
    // base64("png0") must appear in the replayed frame payload.
    expect(text).toContain("cG5nMA==");
  });

  it("csrf: cookie-authenticated writes need the x-veriflow-csrf header", async () => {
    const app = createApp({ store: new MemoryStore(), blobs: new FsBlobStore(join(tmpdir(), "vf-csrf")) });
    const su = await json(app, "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "csrf@example.com", password: "password1", setCookie: true }),
    });
    const cookie = (su.body as { setCookie?: string }).setCookie ?? "";
    // Grab the Set-Cookie from raw headers instead.
    const raw = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "csrf@example.com", password: "password1", setCookie: true }),
    });
    const setCookie = raw.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vf_session");
    // Cookie write without the CSRF header → 403.
    const noCsrf = await app.request("/v1/flows", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: setCookie.split(";")[0] },
      body: JSON.stringify({ name: "x", objective: "y" }),
    });
    expect(noCsrf.status).toBe(403);
    // With the header → through.
    const withCsrf = await json(app, "/v1/flows", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: setCookie.split(";")[0], "x-veriflow-csrf": "1" },
      body: JSON.stringify({ name: "x", objective: "y" }),
    });
    expect(withCsrf.status).toBe(200);
    void cookie;
  });
});
