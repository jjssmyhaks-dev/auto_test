import { Hono } from "hono";
import { cors } from "hono/cors";
import { TIER_QUOTAS, type BillingTier, type Span } from "@veriflow/schema";
import { spansToOtlp } from "@veriflow/telemetry";
import { runAgentTest } from "@veriflow/harness";
import {
  hashPassword,
  hashToken,
  newId,
  newToken,
  verifyPassword,
  type AuthContext,
  type RunRow,
  type SpanRow,
  type StepRow,
} from "./auth.js";
import { computeAlerts, MemoryStore, monthStartIso, QUOTAS, type CloudStore } from "./store.js";
import type { BlobStore } from "./blobs.js";
import { FsBlobStore } from "./blobs.js";

export interface AppDeps {
  store: CloudStore;
  blobs: BlobStore;
}

function stepsFromEvents(runId: string, events: Array<{ type: string; ts: string; stepIndex?: number; payload: Record<string, unknown> }>): StepRow[] {
  const decides = events.filter((e) => e.type === "decide" && e.payload.action);
  // Derive per-step status from act/verify events (previously everything was
  // "ok", which made failed steps look green on the dashboard).
  const actOk = new Map<number, boolean>();
  const verifyFail = new Map<number, string>();
  for (const e of events) {
    if (e.stepIndex === undefined) continue;
    if (e.type === "act" && typeof e.payload.ok === "boolean") {
      actOk.set(e.stepIndex, (actOk.get(e.stepIndex) ?? true) && e.payload.ok);
    }
    if (e.type === "verify" && e.payload.ok === false) {
      verifyFail.set(e.stepIndex, typeof e.payload.detail === "string" ? e.payload.detail : "assert failed");
    }
  }
  return decides.map((e, i) => {
    const index = e.stepIndex ?? i;
    const ok = actOk.get(index) ?? true;
    const assertFail = verifyFail.get(index);
    const action = e.payload.action as { type?: string } | undefined;
    const isFinish = action?.type === "finish";
    const status = isFinish || assertFail ? (ok && !assertFail ? "ok" : "failed") : ok ? "ok" : "failed";
    return {
      id: `${runId}_step_${i}`,
      runId,
      index,
      action: e.payload.action,
      status,
      startedAt: e.ts,
      endedAt: e.ts,
    };
  });
}

export function createApp(deps?: Partial<AppDeps>) {
  const store = deps?.store ?? MemoryStore.fromFile(process.env.VERIFLOW_CLOUD_DIR ?? ".veriflow-data");
  const blobs = deps?.blobs ?? new FsBlobStore(process.env.VERIFLOW_BLOBS_DIR ?? ".veriflow-data/blobs");
  const app = new Hono();
  app.use("*", cors());

  app.get("/health", async (c) =>
    c.json({
      ok: true,
      service: "veriflow",
      store: store.constructor.name,
      blobs: blobs.kind,
      postgres: Boolean(process.env.DATABASE_URL),
      s3: Boolean(process.env.S3_ENDPOINT),
    }),
  );

  app.get("/openapi.json", (c) =>
    c.json({
      openapi: "3.1.0",
      info: { title: "Veriflow API", version: "0.2.0" },
      paths: {
        "/health": { get: {} },
        "/v1/auth/signup": { post: {} },
        "/v1/auth/login": { post: {} },
        "/v1/me": { get: {} },
        "/v1/projects": { get: {}, post: {} },
        "/v1/projects/{id}/keys": { get: {}, post: {} },
        "/v1/runs": { get: {}, post: {} },
        "/v1/runs/{id}": { get: {} },
        "/v1/runs/{id}/trace": { get: {} },
        "/v1/runs/{id}/otlp": { get: {} },
        "/v1/runs/{id}/blobs/{path}": { get: {} },
        "/v1/flows": { get: {}, post: {} },
        "/v1/usage": { get: {} },
        "/v1/billing/upgrade": { post: {} },
        "/v1/alerts": { get: {} },
        "/v1/alerts/rules": { get: {}, post: {} },
        "/v1/alerts/rules/{id}": { delete: {} },
        "/v1/human-pauses": { post: {} },
        "/v1/human-pauses/{id}": { get: {} },
        "/v1/human-pauses/{id}/resolve": { post: {} },
        "/v1/agent-tests": { post: {} },
        "/v1/metrics/{flowId}": { get: {} },
      },
    }),
  );

  const issueSession = async (userId: string) => {
    const token = newToken("sess");
    await store.createSession(userId, hashToken(token));
    return token;
  };

  app.post("/v1/auth/signup", async (c) => {
    const body = (await c.req.json()) as { email?: string; password?: string };
    if (!body.email || !body.password || body.password.length < 8) {
      return c.json({ error: "email and password (8+ chars) required" }, 400);
    }
    try {
      const user = await store.createUser(body.email, hashPassword(body.password));
      const project = await store.createProject(user.id, "Default");
      const token = await issueSession(user.id);
      return c.json({ token, user: { id: user.id, email: user.email, tier: user.tier }, project });
    } catch (err) {
      const status = (err as { status?: number }).status === 409 ? 409 : 400;
      return c.json({ error: err instanceof Error ? err.message : "signup failed" }, status);
    }
  });

  app.post("/v1/auth/login", async (c) => {
    const body = (await c.req.json()) as { email?: string; password?: string };
    const user = body.email ? await store.getUserByEmail(body.email) : undefined;
    if (!user || !body.password || !verifyPassword(body.password, user.passwordHash)) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    const token = await issueSession(user.id);
    const projects = await store.listProjects(user.id);
    return c.json({ token, user: { id: user.id, email: user.email, tier: user.tier }, projects });
  });

  const auth = async (c: { req: { header: (n: string) => string | undefined } }): Promise<AuthContext | undefined> => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const row = await store.findApiKey(hashToken(apiKey));
      if (!row) return undefined;
      const project = await store.getProject(row.projectId);
      if (!project) return undefined;
      const user = await store.getUser(project.userId);
      if (!user) return undefined;
      return { user, project, via: "api_key" };
    }
    if (bearer) {
      const session = await store.getSession(hashToken(bearer));
      if (!session) return undefined;
      const user = await store.getUser(session.userId);
      if (!user) return undefined;
      return { user, via: "session" };
    }
    return undefined;
  };

  const requireAuth = async (
    c: Parameters<typeof auth>[0] & { json: (b: unknown, s?: number) => Response },
  ) => {
    const ctx = await auth(c);
    if (!ctx) return { error: c.json({ error: "unauthorized" }, 401) as unknown as Response };
    return { ctx };
  };

  app.get("/v1/me", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const projects = await store.listProjects(ctx.user.id);
    return c.json({ user: { id: ctx.user.id, email: ctx.user.email, tier: ctx.user.tier }, projects });
  });

  app.get("/v1/projects", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    return c.json({ projects: await store.listProjects(ctx.user.id) });
  });

  app.post("/v1/projects", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as { name?: string };
    const project = await store.createProject(ctx.user.id, body.name ?? "Project");
    return c.json({ project });
  });

  app.get("/v1/projects/:id/keys", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const keys = await store.listApiKeys(project.id);
    return c.json({
      keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt })),
    });
  });

  app.post("/v1/projects/:id/keys", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const plaintext = newToken("vf");
    const row = await store.createApiKey({
      id: newId("key"),
      projectId: project.id,
      name: body.name ?? "cli",
      keyHash: hashToken(plaintext),
      prefix: plaintext.slice(0, 10),
      createdAt: new Date().toISOString(),
    });
    return c.json({ key: plaintext, id: row.id, prefix: row.prefix, name: row.name });
  });

  const resolveProject = async (ctx: AuthContext, projectId?: string) => {
    if (ctx.project) return ctx.project;
    if (projectId) {
      const p = await store.getProject(projectId);
      if (p && p.userId === ctx.user.id) return p;
    }
    const list = await store.listProjects(ctx.user.id);
    return list[0];
  };

  app.get("/v1/runs", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx, c.req.query("projectId"));
    if (!project) return c.json({ runs: [] });
    let runs = await store.listRuns(project.id);
    // Filters for the dashboard/CI: status and flow (spec §10 run history queries).
    const status = c.req.query("status");
    if (status) runs = runs.filter((r) => r.status === status);
    const flowId = c.req.query("flowId");
    if (flowId) runs = runs.filter((r) => r.flowId === flowId);
    const limit = Number(c.req.query("limit"));
    if (Number.isFinite(limit) && limit > 0) runs = runs.slice(0, limit);
    return c.json({ runs });
  });

  app.post("/v1/runs", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as {
      id?: string;
      projectId?: string;
      flowId?: string;
      objective?: string;
      envUrl?: string;
      status?: string;
      startedAt?: string;
      endedAt?: string;
      stepCount?: number;
      costUsd?: number;
      error?: string;
      events?: unknown;
      spans?: Span[];
      files?: { path: string; contentBase64: string }[];
    };
    const project = await resolveProject(ctx, body.projectId);
    if (!project) return c.json({ error: "no project" }, 400);
    const used = await store.monthlyRunCount(project.id, monthStartIso());
    const quota = QUOTAS[ctx.user.tier].runsPerMonth;
    if (used >= quota) {
      return c.json(
        { error: "quota_exceeded", tier: ctx.user.tier, used, quota, message: "Upgrade to ingest more cloud runs" },
        402,
      );
    }
    const runId = body.id ?? newId("run");
    const run: RunRow = {
      id: runId,
      projectId: project.id,
      flowId: body.flowId,
      objective: body.objective ?? "",
      envUrl: body.envUrl,
      status: body.status ?? "passed",
      startedAt: body.startedAt ?? new Date().toISOString(),
      endedAt: body.endedAt,
      stepCount: body.stepCount ?? 0,
      costUsd: body.costUsd,
      error: typeof body.error === "string" ? body.error : undefined,
      events: body.events,
    };
    await store.upsertRun(run);
    const events = Array.isArray(body.events) ? (body.events as Parameters<typeof stepsFromEvents>[1]) : [];
    await store.replaceSteps(runId, stepsFromEvents(runId, events));
    const spans: SpanRow[] = (body.spans ?? []).map((s) => ({
      id: s.id,
      runId,
      stepId: s.stepId,
      kind: s.kind,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      ok: s.ok,
      error: s.error,
      attributes: s.attributes as Record<string, unknown> | undefined,
    }));
    await store.replaceSpans(runId, spans);
    await store.addUsage({
      id: newId("use"),
      projectId: project.id,
      runId,
      kind: "run",
      amount: 1,
      unit: "run",
      createdAt: new Date().toISOString(),
    });
    if (body.costUsd && body.costUsd > 0) {
      await store.addUsage({
        id: newId("use"),
        projectId: project.id,
        runId,
        kind: "llm",
        amount: body.costUsd,
        unit: "usd",
        createdAt: new Date().toISOString(),
      });
    }
    for (const file of body.files ?? []) {
      await blobs.put(`${runId}/${file.path}`, Buffer.from(file.contentBase64, "base64"));
    }
    return c.json({ id: runId, quota: { used: used + 1, limit: quota, tier: ctx.user.tier } });
  });

  app.get("/v1/runs/:id", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const run = await store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const project = await store.getProject(run.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const steps = await store.listSteps(run.id);
    const spans = await store.listSpans(run.id);
    return c.json({ run, steps, spans });
  });

  app.get("/v1/runs/:id/trace", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const run = await store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const project = await store.getProject(run.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const steps = await store.listSteps(run.id);
    const spans = await store.listSpans(run.id);
    const shotKeys = (await blobs.list(`${run.id}/screenshots`)).filter((k) => k.endsWith(".png"));
    if (shotKeys.length === 0) {
      for (const step of steps) {
        shotKeys.push(`${run.id}/screenshots/step-${step.index}.png`);
      }
    }
    const shots: string[] = [];
    for (const key of shotKeys) {
      const buf = await blobs.get(key);
      if (buf) shots.push(`data:image/png;base64,${buf.toString("base64")}`);
    }
    const captureBuf = await blobs.get(`${run.id}/capture.json`);
    let capture: unknown;
    if (captureBuf) {
      try {
        capture = JSON.parse(captureBuf.toString("utf8"));
      } catch {
        capture = undefined;
      }
    }
    return c.json({ run, steps, spans, screenshots: shots, capture });
  });

  app.get("/v1/runs/:id/blobs/*", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run) return c.json({ error: "not found" }, 404);
    const rest = c.req.path.replace(`/v1/runs/${runId}/blobs/`, "");
    const buf = await blobs.get(`${runId}/${rest}`);
    if (!buf) return c.json({ error: "not found" }, 404);
    return c.body(Uint8Array.from(buf), 200, {
      "content-type": rest.endsWith(".png") ? "image/png" : "application/octet-stream",
    });
  });

  // Spec 2.8: OTel-shaped JSON for a synced run — pipe it to any OTLP collector.
  app.get("/v1/runs/:id/otlp", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const run = await store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const project = await store.getProject(run.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const spans = (await store.listSpans(run.id)) as unknown as Parameters<typeof spansToOtlp>[0];
    return c.json(spansToOtlp(spans));
  });

  app.get("/v1/flows", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ flows: [] });
    return c.json({ flows: await store.listFlows(project.id) });
  });

  app.post("/v1/flows", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { id?: string; name?: string; objective?: string; envUrl?: string };
    const flow = await store.saveFlow({
      id: body.id ?? newId("flow"),
      projectId: project.id,
      name: body.name ?? "flow",
      objective: body.objective ?? "",
      envUrl: body.envUrl,
    });
    return c.json({ flow });
  });

  app.get("/v1/usage", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ usage: [], quota: QUOTAS[ctx.user.tier] });
    const usage = await store.listUsage(project.id);
    const used = await store.monthlyRunCount(project.id, monthStartIso());
    return c.json({
      tier: ctx.user.tier,
      quota: QUOTAS[ctx.user.tier],
      used,
      remaining: Math.max(0, QUOTAS[ctx.user.tier].runsPerMonth - used),
      ledger: usage,
    });
  });

  app.post("/v1/billing/upgrade", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as { tier?: BillingTier };
    const tier = body.tier;
    if (!tier || !TIER_QUOTAS[tier]) return c.json({ error: "tier must be free|starter|team" }, 400);
    if (process.env.STRIPE_SECRET_KEY) {
      return c.json({
        status: "stripe_not_wired",
        message: "STRIPE_SECRET_KEY is set but checkout is simulated in this build",
        checkoutUrl: `https://example.invalid/upgrade?tier=${tier}`,
      });
    }
    const user = await store.setTier(ctx.user.id, tier);
    return c.json({ status: "upgraded", user: { id: user?.id, email: user?.email, tier: user?.tier } });
  });

  app.get("/v1/alerts", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    const runs = project ? await store.listRuns(project.id) : [];
    const alerts = computeAlerts(runs);
    // Per-project alert rules (spec §4): mark rules whose threshold the current
    // signal crosses, and record lastTriggeredAt.
    const now = new Date().toISOString();
    const rules = project ? await store.listAlertRules(project.id) : [];
    const triggeredRules: { ruleId: string; metric: string; message: string }[] = [];
    if (project && rules.length && runs.length) {
      const recent = runs.slice(0, 20);
      const passRate = recent.filter((r) => r.status === "passed").length / Math.max(recent.length, 1);
      const costs = runs.map((r) => r.costUsd ?? 0).filter((v) => v > 0);
      const lastCost = costs[0] ?? 0;
      for (const rule of rules) {
        const hit =
          rule.metric === "success_rate"
            ? passRate < rule.threshold
            : lastCost > 0 && lastCost > rule.threshold;
        if (hit) {
          triggeredRules.push({
            ruleId: rule.id,
            metric: rule.metric,
            message: `rule ${rule.metric} crossed (threshold ${rule.threshold})`,
          });
          await store.markAlertTriggered(rule.id, now);
        }
      }
    }
    const webhook = process.env.VERIFLOW_ALERT_WEBHOOK;
    let delivery = "log_only";
    if (webhook && (alerts.length || triggeredRules.length)) {
      delivery = "webhook";
      // Fire-and-forget POST; a slow webhook must not delay the API response.
      void fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project?.id, alerts, triggeredRules, at: now }),
      }).catch((err) => console.error("alert webhook failed:", err instanceof Error ? err.message : err));
    }
    return c.json({ alerts, rules, triggeredRules, delivery });
  });

  // Spec 1.4 human-in-the-loop for headless/CI: a run creates a pause request,
  // a human resolves the magic link (or POSTs), the CLI polls until resolved.
  app.post("/v1/human-pauses", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { runId?: string; reason?: string; prompt?: string; ttlSeconds?: number };
    if (!body.runId || !body.reason) return c.json({ error: "runId and reason required" }, 400);
    const ttl = Math.min(Math.max(body.ttlSeconds ?? 900, 30), 3600);
    const now = Date.now();
    const pause = await store.createHumanPause({
      id: newId("pause"),
      runId: body.runId,
      projectId: project.id,
      reason: body.reason,
      prompt: body.prompt,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    });
    return c.json({ pause, magicLink: `/human-pauses/${pause.id}` });
  });

  app.get("/v1/human-pauses/:id", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const pause = await store.getHumanPause(c.req.param("id"));
    if (!pause) return c.json({ error: "not found" }, 404);
    const project = await store.getProject(pause.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    return c.json({ pause });
  });

  app.post("/v1/human-pauses/:id/resolve", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const pause = await store.getHumanPause(c.req.param("id"));
    if (!pause) return c.json({ error: "not found" }, 404);
    const project = await store.getProject(pause.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { response?: string };
    const resolved = await store.resolveHumanPause(pause.id, body.response ?? "confirmed by human");
    if (!resolved) return c.json({ error: `pause is ${pause.status}, not pending` }, 409);
    return c.json({ pause: resolved });
  });

  app.get("/v1/human-pauses", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ pauses: [] });
    return c.json({ pauses: await store.listHumanPauses(project.id) });
  });

  app.post("/v1/alerts/rules", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { metric?: string; threshold?: number; channel?: string };
    if ((body.metric !== "success_rate" && body.metric !== "cost_spike") || typeof body.threshold !== "number") {
      return c.json({ error: "metric must be success_rate|cost_spike and threshold a number" }, 400);
    }
    const rule = await store.saveAlertRule({
      id: newId("rule"),
      projectId: project.id,
      metric: body.metric,
      threshold: body.threshold,
      channel: body.channel ?? "webhook",
      createdAt: new Date().toISOString(),
    });
    return c.json({ rule });
  });

  app.get("/v1/alerts/rules", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ rules: [] });
    return c.json({ rules: await store.listAlertRules(project.id) });
  });

  app.delete("/v1/alerts/rules/:id", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "not found" }, 404);
    const ok = await store.deleteAlertRule(project.id, c.req.param("id"));
    return ok ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
  });

  // Spec 8.3: agent tests as first-class runs — run an eval against a chat
  // endpoint server-side and ingest the report as a run of kind agent-test.
  app.post("/v1/agent-tests", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { endpoint?: string; scenarios?: number };
    if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);
    if (body.scenarios !== undefined && (!Number.isFinite(body.scenarios) || body.scenarios < 1 || body.scenarios > 60)) {
      return c.json({ error: "scenarios must be 1-60" }, 400);
    }
    try {
      const report = await runAgentTest({ endpoint: body.endpoint, scenarios: body.scenarios });
      const runId = report.runId;
      await store.upsertRun({
        id: runId,
        projectId: project.id,
        objective: `agent-test ${body.endpoint} (${report.turns.length} turns)`,
        status: report.verdict === "red" ? "failed" : report.verdict === "yellow" ? "paused" : "passed",
        startedAt: new Date().toISOString(),
        stepCount: report.turns.length,
        error: report.verdict === "red" ? "agent verdict red" : undefined,
        events: report.turns.map((t, i) => ({
          ts: new Date().toISOString(),
          type: "decide",
          runId,
          stepIndex: i,
          payload: { action: { type: "finish", success: t.pass, reason: `scenario ${t.scenarioId} turn ${t.turn}` }, reply: t.reply.slice(0, 200) },
        })),
      });
      await store.replaceSpans(
        runId,
        report.spans.map((s, i) => ({
          id: `${runId}_s${i}`,
          runId,
          kind: s.kind,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          ok: s.ok,
          error: s.error,
          attributes: s.attributes as Record<string, unknown> | undefined,
        })),
      );
      await store.addUsage({
        id: newId("use"),
        projectId: project.id,
        runId,
        kind: "run",
        amount: 1,
        unit: "run",
        createdAt: new Date().toISOString(),
      });
      return c.json({ report, runId });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "agent test failed" }, 502);
    }
  });

  app.get("/v1/metrics/:flowId", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const flowId = c.req.param("flowId");
    const project = await resolveProject(ctx);
    const runs = project ? (await store.listRuns(project.id)).filter((r) => r.flowId === flowId || r.id.includes(flowId) || r.objective.includes(flowId)) : [];
    const passed = runs.filter((r) => r.status === "passed").length;
    return c.json({
      flowId,
      runs: runs.length,
      passRate: runs.length ? passed / runs.length : 0,
      avgCostUsd: runs.length ? runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) / runs.length : 0,
    });
  });

  return app;
}
