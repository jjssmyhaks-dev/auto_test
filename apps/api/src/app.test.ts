import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";
import { FsBlobStore } from "./blobs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function json(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
});
