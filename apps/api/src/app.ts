import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { TIER_QUOTAS, type BillingTier, type Span } from "@veriflow/schema";
import { spansToOtlp } from "@veriflow/telemetry";
import { runAgentTest, runRedTeam, parseCron, compareSteps, verifyStripeSignature } from "@veriflow/harness";
import { rateLimit, SESSION_TTL_MS } from "./store.js";
import { ROLE_RANK, WORKSPACE_ROLE_RANK, type MetricRollupRow, type ProjectRole, type WorkspaceInviteRow, type WorkspaceRole } from "./auth.js";
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
import { githubActionsWorkflow } from "./workflow.js";
import type { BlobStore } from "./blobs.js";
import { deliver, deliverResultSummary, parseChannel } from "./deliver.js";
import { FsBlobStore } from "./blobs.js";

export interface AppDeps {
  store: CloudStore;
  blobs: BlobStore;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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
        "/v1/schedules/claim": { post: {} },
        "/v1/devices": { get: {}, post: {} },
        "/v1/devices/{id}/heartbeat": { post: {} },
        "/v1/devices/{id}/claim": { post: {} },
        "/v1/device-jobs": { get: {}, post: {} },
        "/v1/device-jobs/{id}/complete": { post: {} },
        "/v1/billing/stripe-webhook": { post: {} },
        "/v1/redteam": { post: {} },
        "/v1/compare": { get: {} },
        "/v1/usage": { get: {} },
        "/v1/billing/upgrade": { post: {} },
        "/v1/alerts": { get: {} },
        "/v1/alerts/rules": { get: {}, post: {} },
        "/v1/alerts/rules/{id}": { delete: {} },
        "/v1/human-pauses": { post: {} },
        "/v1/human-pauses/{id}": { get: {} },
        "/v1/human-pauses/{id}/resolve": { post: {} },
        "/v1/agent-tests": { post: {} },
        "/v1/progress": { get: {}, put: {}, delete: {} },
        "/v1/onboarding/funnel": { get: {} },
        "/v1/demo-reset": { post: {} },
        "/v1/metrics/rollups": { get: {} },
        "/v1/metrics/rollups/refresh": { post: {} },
        "/v1/metrics/{flowId}": { get: {} },
      },
    }),
  );

  const issueSession = async (userId: string) => {
    const token = newToken("sess");
    await store.createSession(userId, hashToken(token));
    return token;
  };

  // Opportunistic session purge — cheap when nothing is expired, and it
  // keeps long-running deployments from accumulating dead rows.
  let lastPurge = 0;
  const maybePurgeSessions = () => {
    const now = Date.now();
    if (now - lastPurge > 60 * 60 * 1000) {
      lastPurge = now;
      void store.purgeExpiredSessions().catch(() => {});
    }
  };

  // Fixed-window rate limit for credential endpoints (per IP): 10 attempts
  // per 5 minutes. Returns a 429 response when tripped, else undefined.
  const authRateLimit = (c: Context) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ||
      "unknown";
    const rl = rateLimit(`auth:${ip}`, 10, 5 * 60 * 1000);
    if (!rl.ok) return c.json({ error: "too many attempts", retryAfter: rl.retryAfter }, 429) as unknown as Response;
    return undefined;
  };

  // Set the session as an httpOnly cookie when requested (browser keeps no
  // JS-readable copy), while still returning the token for CLI/API use.
  const sessionCookie = (c: { header: (n: string, v: string) => void }, token: string, setCookie: boolean) => {
    if (!setCookie) return;
    c.header(
      "set-cookie",
      `vf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
  };

  app.post("/v1/auth/signup", async (c) => {
    const limited = authRateLimit(c);
    if (limited) return limited;
    const body = (await c.req.json()) as { email?: string; password?: string; setCookie?: boolean };
    if (!body.email || !body.password || body.password.length < 8) {
      return c.json({ error: "email and password (8+ chars) required" }, 400);
    }
    try {
      const user = await store.createUser(body.email, hashPassword(body.password));
      const project = await store.createProject(user.id, "Default");
      const token = await issueSession(user.id);
      maybePurgeSessions();
      sessionCookie(c, token, body.setCookie === true);
      return c.json({ token, user: { id: user.id, email: user.email, tier: user.tier }, project });
    } catch (err) {
      const status = (err as { status?: number }).status === 409 ? 409 : 400;
      return c.json({ error: err instanceof Error ? err.message : "signup failed" }, status);
    }
  });

  app.post("/v1/auth/login", async (c) => {
    const limited = authRateLimit(c);
    if (limited) return limited;
    const body = (await c.req.json()) as { email?: string; password?: string; setCookie?: boolean };
    const user = body.email ? await store.getUserByEmail(body.email) : undefined;
    if (!user || !body.password || !verifyPassword(body.password, user.passwordHash)) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    const token = await issueSession(user.id);
    const projects = await store.listProjects(user.id);
    maybePurgeSessions();
    sessionCookie(c, token, body.setCookie === true);
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
    // httpOnly cookie fallback (SET_VIA_COOKIE deployments): the browser
    // never holds the raw token in JS-readable storage.
    const cookie = c.req.header("cookie");
    if (cookie) {
      const match = /(?:^|;\s*)vf_session=([A-Za-z0-9._~+/=-]+)/.exec(cookie);
      if (match) {
        const session = await store.getSession(hashToken(match[1]));
        if (!session) return undefined;
        const user = await store.getUser(session.userId);
        if (!user) return undefined;
        return { user, via: "session" };
      }
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

  /** Resolve the caller's role on a project (project owner, else member row). */
  const roleOn = async (projectId: string, userId: string) => {
    const project = await store.getProject(projectId);
    if (!project) return undefined;
    return store.roleFor(projectId, userId);
  };

  /** Require a minimum role on the given project; undefined = caller isn't a
   *  member at all (403 "not a member"). Owner > admin > member > viewer. */
  const requireRole = async (c: Context, projectId: string, min: ProjectRole) => {
    const { ctx } = await requireAuth(c);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    // Cross-project: workspace roles act as a floor on every contained project.
    const role = await store.effectiveRoleFor(projectId, ctx.user.id);
    if (!role) return c.json({ error: "not a member of this project" }, 403);
    if (ROLE_RANK[role] < ROLE_RANK[min]) return c.json({ error: `requires ${min} role` }, 403);
    return undefined;
  };

  /** Same ladder for workspace-level routes. */
  const requireWorkspaceRole = async (c: Context, workspaceId: string, min: ProjectRole) => {
    const { ctx } = await requireAuth(c);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    const ws = await store.getWorkspace(workspaceId);
    if (!ws) return c.json({ error: "not found" }, 404);
    const role: ProjectRole | undefined =
      ws.userId === ctx.user.id
        ? "owner"
        : (await store.listWorkspaceMembers(workspaceId)).find((m) => m.userId === ctx.user.id)?.role;
    if (!role) return c.json({ error: "not a member of this workspace" }, 403);
    if (ROLE_RANK[role] < ROLE_RANK[min]) return c.json({ error: `requires ${min} role` }, 403);
    return undefined;
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
    if (!project) return c.json({ error: "not found" }, 404);
    // Role-aware: members+ can mint API keys for projects they belong to.
    const denied = await requireRole(c, project.id, "member");
    if (denied) return denied;
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
      // Membership-aware (incl. workspace floor): owner or any effective role can resolve.
      if (p && (p.userId === ctx.user.id || (await store.effectiveRoleFor(p.id, ctx.user.id)))) return p;
    }
    const list = await store.listProjects(ctx.user.id);
    return list[0];
  };

  // ---- Team roles -------------------------------------------------------
  // Ready-to-commit GitHub Actions workflow for a flow's schedule (or all
  // scheduled flows). Returns YAML the /flows page offers as a download.
  app.get("/v1/flows/:id/cron-workflow", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx, c.req.query("projectId"));
    if (!project) return c.json({ error: "no project" }, 400);
    const flow = (await store.listFlows(project.id)).find((f) => f.id === c.req.param("id"));
    if (!flow) return c.json({ error: "not found" }, 404);
    return c.json({
      filename: `veriflow-schedule-${flow.id}.yml`,
      workflow: githubActionsWorkflow({
        name: `Veriflow schedule: ${flow.name}`,
        schedule: flow.schedule ?? "*/15 * * * *",
        apiUrl: process.env.VERIFLOW_PUBLIC_URL ?? `http://${c.req.header("host") ?? "localhost:8787"}`,
      }),
    });
  });

  app.post("/v1/flows/cron-workflow", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json().catch(() => ({}))) as { schedule?: string; flowName?: string; apiUrl?: string };
    const schedule = body.schedule ?? "*/15 * * * *";
    try {
      parseCron(schedule);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid schedule" }, 400);
    }
    return c.json({
      filename: "veriflow-schedule.yml",
      workflow: githubActionsWorkflow({
        name: `Veriflow schedule: ${body.flowName ?? "all scheduled flows"}`,
        schedule,
        apiUrl: body.apiUrl ?? process.env.VERIFLOW_PUBLIC_URL ?? `http://${c.req.header("host") ?? "localhost:8787"}`,      }),
    });
  });

  // Invites, membership CRUD, and role checks. Rules: owner > admin > member
  // > viewer; invites require admin; only admins+ see pending invites; no one
  // removes/demotes an owner; new invites can't exceed the inviter's rank.

  app.get("/v1/projects/:id/members", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "viewer");
    if (denied) return denied;
    const members = await store.listMembers(project.id);
    const owner = await store.getUser(project.userId);
    return c.json({
      members: [
        { userId: project.userId, email: owner?.email, role: "owner", addedBy: project.userId, createdAt: project.createdAt },
        ...members.filter((m) => m.userId !== project.userId),
      ],
    });
  });

  app.post("/v1/projects/:id/invites", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "admin");
    if (denied) return denied;
    const body = (await c.req.json()) as { email?: string; role?: ProjectRole };
    const email = body.email?.trim().toLowerCase();
    const role = body.role ?? "member";
    if (!email) return c.json({ error: "email required" }, 400);
    if (!(role in ROLE_RANK) || role === "owner") return c.json({ error: "role must be admin|member|viewer" }, 400);
    const inviterRole = await store.roleFor(project.id, ctx.user.id);
    if (inviterRole && ROLE_RANK[inviterRole] < ROLE_RANK[role]) return c.json({ error: "cannot invite above your role" }, 403);
    const existing = await store.findUserByEmail(email);
    const invite = await store.createInvite({
      id: newId("inv"),
      projectId: project.id,
      email,
      role,
      token: newToken("vin"),
      status: "pending",
      invitedBy: ctx.user.id,
      createdAt: new Date().toISOString(),
    });
    return c.json({ invite: { id: invite.id, email: invite.email, role: invite.role, createdAt: invite.createdAt }, acceptToken: invite.token, existingUser: !!existing });
  });

  app.get("/v1/projects/:id/invites", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "admin");
    if (denied) return denied;
    const invites = (await store.listInvites(project.id)).map(({ token: _t, ...rest }) => rest);
    return c.json({ invites });
  });

  app.delete("/v1/projects/:id/invites/:inviteId", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "admin");
    if (denied) return denied;
    const ok = await store.revokeInvite(project.id, c.req.param("inviteId"));
    return ok ? c.json({ revoked: true }) : c.json({ error: "not found" }, 404);
  });

  // Accept an invite: one-time token → membership. Works for existing accounts
  // (must be signed in) or brand-new signups (the web login page passes the
  // token through ?invite= and accepts right after signup/login). Handles both
  // project invites and workspace invites.
  app.post("/v1/invites/accept", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as { token?: string };
    if (!body.token) return c.json({ error: "token required" }, 400);
    // Try a workspace invite first, then a project invite.
    const wsInvite = await store.getWorkspaceInviteByToken(body.token);
    if (wsInvite) {
      if (wsInvite.email.toLowerCase() !== ctx.user.email.toLowerCase()) {
        return c.json({ error: `invite was sent to ${wsInvite.email}` }, 403);
      }
      const accepted = await store.acceptWorkspaceInvite(body.token, ctx.user.id);
      if (!accepted) return c.json({ error: "invite not found or no longer pending" }, 404);
      return c.json({ workspaceId: accepted.workspaceId, role: accepted.role });
    }
    const invite = await store.getInviteByToken(body.token);
    if (!invite) return c.json({ error: "invite not found or no longer pending" }, 404);
    if (invite.email.toLowerCase() !== ctx.user.email.toLowerCase()) {
      return c.json({ error: `invite was sent to ${invite.email}` }, 403);
    }
    const accepted = await store.acceptInvite(body.token, ctx.user.id);
    if (!accepted) return c.json({ error: "invite not found or no longer pending" }, 404);
    return c.json({ projectId: accepted.member.projectId, role: accepted.member.role });
  });

  app.delete("/v1/projects/:id/members/:userId", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "admin");
    if (denied) return denied;
    const targetId = c.req.param("userId");
    if (targetId === project.userId) return c.json({ error: "cannot remove the project owner" }, 400);
    // Only the owner manages admins.
    const actorRole = await store.roleFor(project.id, ctx.user.id);
    if (targetId !== ctx.user.id && actorRole !== "owner") {
      const targetRole = await store.roleFor(project.id, targetId);
      if (targetRole === "admin") return c.json({ error: "only the owner can manage admins" }, 403);
    }
    const ok = await store.removeMember(project.id, targetId);
    return ok ? c.json({ removed: true }) : c.json({ error: "not found" }, 404);
  });

  app.patch("/v1/projects/:id/members/:userId", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const denied = await requireRole(c, project.id, "admin");
    if (denied) return denied;
    const targetId = c.req.param("userId");
    if (targetId === project.userId) return c.json({ error: "cannot change the project owner's role" }, 400);
    const body = (await c.req.json()) as { role?: ProjectRole };
    if (!body.role || !(body.role in ROLE_RANK) || body.role === "owner") {
      return c.json({ error: "role must be admin|member|viewer" }, 400);
    }
    const updated = await store.setMemberRole(project.id, targetId, body.role);
    return updated ? c.json({ member: updated }) : c.json({ error: "not found" }, 404);
  });

  // ---- Workspaces: a layer above projects --------------------------------
  // A workspace groups projects; its role ladder (owner > admin > member >
  // viewer) acts as a FLOOR on every contained project via effectiveRoleFor.
  // Member adds are direct (by account email) — no invite flow here.

  app.post("/v1/workspaces", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as { name?: string };
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    const ws = await store.createWorkspace(ctx.user.id, body.name.trim());
    return c.json({ workspace: ws }, 201);
  });

  app.get("/v1/workspaces", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    return c.json({ workspaces: await store.listWorkspaces(ctx.user.id) });
  });

  app.get("/v1/workspaces/:id/members", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "viewer");
    if (denied) return denied;
    const ws = (await store.getWorkspace(c.req.param("id")))!;
    const owner = await store.getUser(ws.userId);
    return c.json({
      members: [
        { workspaceId: ws.id, userId: ws.userId, role: "owner", addedBy: ws.userId, email: owner?.email, createdAt: ws.createdAt },
        ...(await store.listWorkspaceMembers(ws.id)).filter((m) => m.userId !== ws.userId),
      ],
    });
  });

  app.post("/v1/workspaces/:id/members", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "admin");
    if (denied) return denied;
    const ws = (await store.getWorkspace(c.req.param("id")))!;
    const body = (await c.req.json()) as { email?: string; role?: ProjectRole };
    if (!body.email || !body.role || body.role === "owner" || !(body.role in ROLE_RANK)) {
      return c.json({ error: "email and role (admin|member|viewer) required" }, 400);
    }
    const target = await store.getUserByEmail(body.email);
    if (!target) return c.json({ error: "no account with that email" }, 404);
    const member = await store.addWorkspaceMember({
      workspaceId: ws.id,
      userId: target.id,
      role: body.role,
      addedBy: ctx.user.id,
      createdAt: new Date().toISOString(),
    });
    return c.json({ member: { ...member, email: target.email } }, 201);
  });

  app.patch("/v1/workspaces/:id/members/:userId", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "admin");
    if (denied) return denied;
    const ws = (await store.getWorkspace(c.req.param("id")))!;
    const targetId = c.req.param("userId");
    if (targetId === ws.userId) return c.json({ error: "cannot change the workspace owner's role" }, 400);
    const body = (await c.req.json()) as { role?: ProjectRole };
    if (!body.role || body.role === "owner" || !(body.role in ROLE_RANK)) {
      return c.json({ error: "role must be admin|member|viewer" }, 400);
    }
    const updated = await store.setWorkspaceMemberRole(ws.id, targetId, body.role);
    return updated ? c.json({ member: updated }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/v1/workspaces/:id/members/:userId", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "admin");
    if (denied) return denied;
    const ws = (await store.getWorkspace(c.req.param("id")))!;
    if (c.req.param("userId") === ws.userId) return c.json({ error: "cannot remove the workspace owner" }, 400);
    const removed = await store.removeWorkspaceMember(ws.id, c.req.param("userId"));
    return removed ? c.json({ status: "removed" }) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/workspaces/:id/projects", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "admin");
    if (denied) return denied;
    const body = (await c.req.json()) as { projectId?: string };
    const project = body.projectId ? await store.getProject(body.projectId) : undefined;
    if (!project) return c.json({ error: "projectId not found" }, 404);
    // Only the project owner (or a workspace admin who owns it) may attach.
    const { ctx } = await requireAuth(c);
    if (!ctx) return c.json({ error: "unauthorized" }, 401);
    if (project.userId !== ctx.user.id) return c.json({ error: "only the project owner can attach it" }, 403);
    const updated = await store.setProjectWorkspace(project.id, c.req.param("id"));
    return c.json({ project: updated });
  });

  /** Mint a one-time workspace invite (admin+ only). */
  app.post("/v1/workspaces/:id/invites", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "admin");
    if (denied) return denied;
    const body = (await c.req.json()) as { email?: string; role?: WorkspaceRole };
    if (!body.email?.includes("@")) return c.json({ error: "valid email required" }, 400);
    const role = body.role ?? "member";
    if (!(role in WORKSPACE_ROLE_RANK) || role === "owner")
      return c.json({ error: "role must be admin, member, or viewer" }, 400);
    const { ctx } = await requireAuth(c);
    const invite: WorkspaceInviteRow = {
      id: newId("wsi"),
      workspaceId: c.req.param("id"),
      email: body.email,
      role,
      token: randomUUID(),
      status: "pending",
      invitedBy: ctx!.user.id,
      createdAt: new Date().toISOString(),
    };
    await store.createWorkspaceInvite(invite);
    const origin = new URL(c.req.url).origin;
    return c.json({ invite, acceptUrl: `/login?invite=${invite.token}` }, 201);
  });

  /** Workspace-scoped usage rollup: runs + USD per project and totals. */
  app.get("/v1/workspaces/:id/usage", async (c) => {
    const denied = await requireWorkspaceRole(c, c.req.param("id"), "viewer");
    if (denied) return denied;
    const usage = await store.listUsageByWorkspace(c.req.param("id"));
    const byProject = new Map<string, { runs: number; usd: number }>();
    for (const row of usage) {
      const agg = byProject.get(row.projectId) ?? { runs: 0, usd: 0 };
      if (row.kind === "run") agg.runs += 1;
      if (row.unit === "usd") agg.usd += row.amount;
      byProject.set(row.projectId, agg);
    }
    const projects = [];
    for (const [projectId, agg] of byProject) {
      const project = await store.getProject(projectId);
      projects.push({ projectId, name: project?.name ?? projectId, ...agg });
    }
    projects.sort((a, b) => b.usd - a.usd);
    return c.json({
      projects,
      totals: {
        runs: projects.reduce((s, p) => s + p.runs, 0),
        usd: Math.round(projects.reduce((s, p) => s + p.usd, 0) * 1e4) / 1e4,
      },
    });
  });

  // ---- Role gates replacing the raw tier checks --------------------------
  // Same endpoints, now real permissions: admins+ for cross-project reads,
  // member+ for the destructive demo reset.

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

  // Side-by-side run comparison: align steps by index, diff type/status,
  // and surface each side's screenshot blob paths for the filmstrip.
  app.get("/v1/compare", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const a = c.req.query("a");
    const b = c.req.query("b");
    if (!a || !b) return c.json({ error: "a and b query params required" }, 400);
    const runA = await store.getRun(a);
    const runB = await store.getRun(b);
    if (!runA || !runB || runA.projectId !== runB.projectId) return c.json({ error: "runs not found or in different projects" }, 404);
    const project = await store.getProject(runA.projectId);
    if (!project || project.userId !== ctx.user.id) return c.json({ error: "not found" }, 404);
    const [stepsA, stepsB, blobsA, blobsB] = await Promise.all([
      store.listSteps(runA.id),
      store.listSteps(runB.id),
      blobs.list(`${runA.id}/`),
      blobs.list(`${runB.id}/`),
    ]);
    const shot = (prefix: string, list: string[], i: number) => list.find((k) => k.includes(`step-${i}`) && k.endsWith(".png")) ?? list.find((k) => k.endsWith(".png") && k.startsWith(prefix));
    const rows = compareSteps(runA.id, runB.id, stepsA as never, stepsB as never, runA.status as never, runB.status as never, blobsA, blobsB);
    // Attach screenshot blob paths per row index.
    for (const row of rows.rows) {
      const i = row.index;
      const aShot = blobsA.find((k) => k.endsWith(".png") && k.includes(`step-${i}`));
      const bShot = blobsB.find((k) => k.endsWith(".png") && k.includes(`step-${i}`));
      void shot;
      row.screenshotA = aShot ? `/v1/runs/${runA.id}/blobs/${aShot.replace(`${runA.id}/`, "")}` : undefined;
      row.screenshotB = bShot ? `/v1/runs/${runB.id}/blobs/${bShot.replace(`${runB.id}/`, "")}` : undefined;
    }
    return c.json({ comparison: rows, stepsA, stepsB });
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
    // Run video (recorded with --video): stream via the blob route.
    const videoKey = (await blobs.list(`${run.id}/`)).find((k) => k.endsWith(".webm"));
    const videoUrl = videoKey ? `/v1/runs/${run.id}/blobs/${videoKey.replace(`${run.id}/`, "")}` : undefined;
    return c.json({ run, steps, spans, screenshots: shots, capture, videoUrl });
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
      "content-type": rest.endsWith(".png") ? "image/png" : rest.endsWith(".webm") ? "video/webm" : "application/octet-stream",
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
    const body = (await c.req.json()) as { id?: string; name?: string; objective?: string; envUrl?: string; schedule?: string | null; projectId?: string };
    const project = await resolveProject(ctx, body.projectId);
    if (!project) return c.json({ error: "no project" }, 400);
    // Writing into someone else's project (e.g. via a workspace role) needs member+.
    if (project.userId !== ctx.user.id) {
      const denied = await requireRole(c, project.id, "member");
      if (denied) return denied;
    }
    // Validate the cron expression up front so the scheduler never chokes.
    if (body.schedule) {
      try {
        parseCron(body.schedule);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "invalid schedule" }, 400);
      }
    }
    const existing = body.id ? (await store.listFlows(project.id)).find((f) => f.id === body.id) : undefined;
    const flow = await store.saveFlow({
      id: body.id ?? newId("flow"),
      projectId: project.id,
      name: body.name ?? "flow",
      objective: body.objective ?? "",
      envUrl: body.envUrl,
      schedule: body.schedule === null ? undefined : (body.schedule ?? existing?.schedule),
    });
    return c.json({ flow });
  });

  // Due-claim endpoint for external schedulers (cron, GitHub Actions, K8s
  // CronJob): poll once a minute; every due flow is returned exactly once
  // per matching minute. Then execute each with `veriflow run --flow`.
  app.post("/v1/schedules/claim", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx, c.req.query("projectId"));
    if (!project) return c.json({ due: [] });
    const now = typeof (await c.req.json().catch(() => ({})))?.now === "string" ? new Date((await c.req.json().catch(() => ({}))).now) : new Date();
    const due = await store.claimDueFlows(project.id, Number.isNaN(now.getTime()) ? new Date() : now);
    return c.json({ due, now: new Date().toISOString() });
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
    // Live Stripe path: create a real Checkout Session (price IDs from env)
    // and let the webhook below flip the tier on `checkout.session.completed`.
    if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_STARTER && process.env.STRIPE_PRICE_TEAM) {
      const price = tier === "starter" ? process.env.STRIPE_PRICE_STARTER : process.env.STRIPE_PRICE_TEAM;
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          mode: "subscription",
          "line_items[0][price]": price,
          "line_items[0][quantity]": "1",
          success_url: `${process.env.STRIPE_SUCCESS_URL ?? "http://localhost:3000/usage?upgraded=1"}`,
          cancel_url: `${process.env.STRIPE_CANCEL_URL ?? "http://localhost:3000/usage"}`,
          "metadata[userId]": ctx.user.id,
          "metadata[tier]": tier,
        }),
      });
      const session = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
      if (!res.ok || !session.url) {
        return c.json({ error: session.error?.message ?? "stripe checkout failed" }, 502);
      }
      return c.json({ status: "checkout_created", checkoutUrl: session.url, sessionId: session.id });
    }
    // No Stripe configured: simulated upgrade (local/dev behavior).
    const user = await store.setTier(ctx.user.id, tier);
    return c.json({ status: "upgraded", user: { id: user?.id, email: user?.email, tier: user?.tier } });
  });

  // Stripe webhook: flips the tier when checkout completes. Signature is
  // verified with HMAC-SHA256 over `${timestamp}.${payload}` per Stripe's
  // scheme (no SDK dependency).
  app.post("/v1/billing/stripe-webhook", async (c) => {
    const sig = c.req.header("stripe-signature");
    const raw = await c.req.text();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhook secret not configured" }, 400);
    if (!sig) return c.json({ error: "missing stripe-signature" }, 400);
    const verified = verifyStripeSignature(raw, sig, secret);
    if (!verified.ok) return c.json({ error: verified.reason }, 400);
    const event = JSON.parse(raw) as {
      type: string;
      data: { object: { id: string; metadata?: { userId?: string; tier?: string }; subscription?: string } };
    };
    if (event.type !== "checkout.session.completed") {
      return c.json({ received: true, ignored: event.type });
    }
    const userId = event.data.object.metadata?.userId;
    const tier = event.data.object.metadata?.tier as BillingTier | undefined;
    if (!userId || !tier || !TIER_QUOTAS[tier]) {
      return c.json({ error: "missing metadata" }, 400);
    }
    const user = await store.setTier(userId, tier);
    return c.json({ received: true, tier: user?.tier });
  });

  // Hosted device cloud: register, heartbeat, queue work, claim (FIFO).
  app.post("/v1/devices", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const device = await store.saveDevice({
      id: newId("dev"),
      projectId: project.id,
      name: body.name ?? "device",
      status: "online",
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return c.json({ device });
  });

  app.get("/v1/devices", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ devices: [] });
    return c.json({ devices: await store.listDevices(project.id) });
  });

  app.post("/v1/devices/:id/heartbeat", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const device = await store.getDevice(c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const project = await resolveProject(ctx);
    if (!project || project.id !== device.projectId) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: "online" | "offline" };
    const updated = await store.heartbeatDevice(device.id, body.status === "offline" ? "offline" : "online");
    return c.json({ device: updated });
  });

  app.post("/v1/devices/:id/claim", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const device = await store.getDevice(c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const project = await resolveProject(ctx);
    if (!project || project.id !== device.projectId) return c.json({ error: "not found" }, 404);
    const job = await store.claimDeviceJob(device.id);
    return c.json({ job: job ?? null });
  });

  app.post("/v1/device-jobs", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { objective?: string; envUrl?: string; flowId?: string };
    let objective = body.objective;
    if (!objective && body.flowId) {
      const flow = (await store.listFlows(project.id)).find((f) => f.id === body.flowId);
      objective = flow?.objective;
    }
    if (!objective) return c.json({ error: "objective or flowId required" }, 400);
    const job = await store.queueDeviceJob({
      id: newId("job"),
      projectId: project.id,
      objective,
      envUrl: body.envUrl,
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    return c.json({ job });
  });

  app.get("/v1/device-jobs", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ jobs: [] });
    return c.json({ jobs: await store.listDeviceJobs(project.id) });
  });

  app.post("/v1/device-jobs/:id/complete", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const jobs = await store.listDeviceJobs(project.id);
    const job = jobs.find((j) => j.id === c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { runId?: string };
    const updated = await store.completeDeviceJob(job.id, body.runId ?? "");
    return c.json({ job: updated });
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
    // Deliver to each triggered rule's configured channel (email:/slack:/
    // webhook:) with retry. Awaited so the caller sees real delivery status.
    const deliveryResults = [];
    const channels = new Set<string>(triggeredRules.map((t) => rules.find((r) => r.id === t.ruleId)?.channel ?? ""));
    if (webhook && (alerts.length || triggeredRules.length)) {
      delivery = "webhook";
      channels.add("webhook:");
    }
    for (const channel of channels) {
      if (!channel) continue;
      deliveryResults.push(
        await deliver(channel, { projectId: project?.id, alerts, triggeredRules, at: now }),
      );
    }
    if (deliveryResults.length) delivery = "multi_channel";
    return c.json({ alerts, rules, triggeredRules, delivery, ...deliverResultSummary(deliveryResults) });
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
    // Deliver the magic link to every configured channel on this project's
    // alert rules (email:/slack:/webhook:) — that's where “the team” lives.
    const pausePayload = {
      pause: { id: pause.id, runId: pause.runId, reason: pause.reason, prompt: pause.prompt },
      magicLink: `/human-pauses/${pause.id}`,
      expiresAt: pause.expiresAt,
    };
    const channels = [...new Set((await store.listAlertRules(project.id)).map((r) => r.channel))];
    const deliveryResults = [];
    for (const channel of channels) deliveryResults.push(await deliver(channel, pausePayload));
    const delivery = deliverResultSummary(deliveryResults);
    return c.json({ pause, magicLink: `/human-pauses/${pause.id}`, delivery });
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

  // Fire a synthetic payload through a channel WITHOUT saving a rule — lets
  // the dashboard verify delivery config (SMTP/Slack/webhook) end-to-end.
  app.post("/v1/alerts/test", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json()) as { channel?: string };
    const channel = body.channel ?? "webhook";
    if (!parseChannel(channel)) {
      return c.json({ error: "channel must be email:<address>, slack:<webhook-url>, or webhook:<url>" }, 400);
    }
    const result = await deliver(channel, {
      test: true,
      message: "Veriflow test notification — if you can read this, the channel works.",
      sentBy: ctx.user.email,
      at: new Date().toISOString(),
    });
    return c.json({ result });
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
    const channel = body.channel ?? "webhook";
    if (!parseChannel(channel)) {
      return c.json({ error: "channel must be email:<address>, slack:<webhook-url>, or webhook:<url>" }, 400);
    }
    const rule = await store.saveAlertRule({
      id: newId("rule"),
      projectId: project.id,
      metric: body.metric,
      threshold: body.threshold,
      channel,
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
    const body = (await c.req.json()) as { endpoint?: string; scenarios?: number; mode?: "text" | "voice" };
    if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);
    if (body.scenarios !== undefined && (!Number.isFinite(body.scenarios) || body.scenarios < 1 || body.scenarios > 60)) {
      return c.json({ error: "scenarios must be 1-60" }, 400);
    }
    try {
      const report = await runAgentTest({ endpoint: body.endpoint, scenarios: body.scenarios, mode: body.mode });
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

  // Red-team eval: prompt-injection / jailbreak / PII-leak attack bank.
  // Ingested as a first-class run like agent tests (red verdict = failed).
  app.post("/v1/redteam", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const body = (await c.req.json()) as { endpoint?: string; category?: "injection" | "jailbreak" | "pii" | "phishing" };
    if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);
    try {
      const report = await runRedTeam({ endpoint: body.endpoint, category: body.category });
      const runId = report.runId;
      await store.upsertRun({
        id: runId,
        projectId: project.id,
        objective: `redteam ${body.endpoint}${body.category ? ` (${body.category})` : ""} (${report.turns.length} probes)`,
        status: report.verdict === "red" ? "failed" : report.verdict === "yellow" ? "paused" : "passed",
        startedAt: new Date().toISOString(),
        stepCount: report.turns.length,
        error: report.verdict === "red" ? "redteam verdict red" : undefined,
        events: report.turns.map((t, i) => ({
          ts: new Date().toISOString(),
          type: "decide",
          runId,
          stepIndex: i,
          payload: { action: { type: "finish", success: t.pass, reason: `${t.scenarioId} -> ${t.pass ? "refused" : "leaked"}` }, reply: t.reply.slice(0, 200) },
        })),
      });
      await store.replaceSpans(runId, report.spans);
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
      return c.json({ error: err instanceof Error ? err.message : "redteam failed" }, 502);
    }
  });

  // Per-user UI progress (onboarding + guided tour) — follows the account
  // across devices. GET returns the stored row; PUT upserts a merged one.
  app.get("/v1/progress", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const row = await store.getUserProgress(ctx.user.id);
    return c.json({
      progress: row ?? {
        userId: ctx.user.id,
        onboardingDone: [],
        onboardingDismissed: false,
        updatedAt: new Date().toISOString(),
      },
    });
  });

  app.put("/v1/progress", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const body = (await c.req.json().catch(() => ({}))) as {
      onboardingDone?: unknown;
      onboardingDismissed?: unknown;
      tourStep?: unknown;
      tourMode?: unknown;
    };
    const existing = await store.getUserProgress(ctx.user.id);
    const validActions = new Set(["queue_run", "scrub_trace", "create_flow", "create_alert_rule"]);
    // Onboarding ticks are append-only and unioned server-side so concurrent
    // devices never lose each other's progress; dismissal is sticky.
    const incoming = Array.isArray(body.onboardingDone)
      ? body.onboardingDone.filter((a): a is string => typeof a === "string" && validActions.has(a))
      : [];
    const onboardingDone = [...new Set([...(existing?.onboardingDone ?? []), ...incoming])];
    const row = {
      userId: ctx.user.id,
      onboardingDone,
      onboardingDismissed:
        body.onboardingDismissed === true || (existing?.onboardingDismissed ?? false),
      tourStep:
        body.tourStep === null
          ? undefined // explicit clear (tour finished)
          : typeof body.tourStep === "number" && Number.isInteger(body.tourStep) && body.tourStep >= 0
            ? body.tourStep
            : existing?.tourStep,
      tourMode: body.tourMode === "interactive" || body.tourMode === "guided" ? body.tourMode : existing?.tourMode,
      updatedAt: new Date().toISOString(),
    };
    const saved = await store.saveUserProgress(row);
    return c.json({ progress: saved });
  });

  // Reset onboarding: clears the account's progress entirely (local cache is
  // cleared client-side alongside this call from Settings).
  app.delete("/v1/progress", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const deleted = await store.deleteUserProgress(ctx.user.id);
    return c.json({ status: "cleared", deleted });
  });

  // Activation funnel: how many accounts completed each onboarding action —
  // powers the drop-off view on the usage page. Team tier only: it exposes
  // aggregate sign-up behaviour, not per-user data, so keep it behind the
  // paying tiers (free accounts get a 403 and the UI hides the section).
  app.get("/v1/onboarding/funnel", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    // Team feature, scoped to SHARED projects the caller administers — i.e.
    // projects that actually have invited members. A solo personal project
    // (every signup gets one) doesn't qualify, otherwise the gate is moot.
    // Without ?projectId this means "every shared project I'm admin/owner on".
    const requested = c.req.query("projectId");
    const candidateIds: string[] = [];
    if (requested) {
      const p = await store.getProject(requested);
      if (!p) return c.json({ error: "not found" }, 404);
      const denied = await requireRole(c, p.id, "admin");
      if (denied) return denied;
      candidateIds.push(p.id);
    } else {
      for (const p of await store.listProjects(ctx.user.id)) {
        const role = await store.roleFor(p.id, ctx.user.id);
        if (role && ROLE_RANK[role] >= ROLE_RANK.admin) candidateIds.push(p.id);
      }
      for (const m of await store.listMemberships(ctx.user.id)) {
        if (ROLE_RANK[m.role] >= ROLE_RANK.admin && !candidateIds.includes(m.projectId)) candidateIds.push(m.projectId);
      }
    }
    // Keep only shared projects (≥1 invited member) and union member userIds.
    const targetProjects: string[] = [];
    const userIds = new Set<string>();
    for (const id of candidateIds) {
      const members = await store.listMembers(id);
      if (!members.length) continue;
      targetProjects.push(id);
      const p = await store.getProject(id);
      if (p) userIds.add(p.userId);
      for (const m of members) userIds.add(m.userId);
    }
    if (!targetProjects.length && !requested) {
      return c.json({ error: "requires admin role on a shared project" }, 403);
    }
    const all = await store.listAllUserProgress();
    const scoped = all.filter((row) => userIds.has(row.userId));
    const actions = ["queue_run", "scrub_trace", "create_flow", "create_alert_rule"];
    const total = scoped.length;
    const steps = actions.map((action) => {
      const count = scoped.filter((p) => p.onboardingDone.includes(action)).length;
      return { action, count, pct: total === 0 ? 0 : Math.round((count / total) * 100) };
    });
    const completedAll = scoped.filter((p) => actions.every((a) => p.onboardingDone.includes(a))).length;
    return c.json({ total, steps, completedAll, projects: targetProjects });
  });

  // Demo reset: wipe this project's runs (with steps/spans/blobs), flows,
  // alert rules, and the usage ledger so the dashboard replays from scratch.
  // Onboarding/tour progress is intentionally preserved — reset THAT from
  // Settings. Team tier: destructive across the whole project.
  app.post("/v1/demo-reset", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    // Destructive across the project — members+, same as tier-gate before
    // but now role-based (the owner or any member can replay their demo).
    const project = await resolveProject(ctx, c.req.query("projectId"));
    if (!project) return c.json({ error: "no project" }, 400);
    const denied = await requireRole(c, project.id, "member");
    if (denied) return denied;
    // Evidence blobs are keyed by run id (`<runId>/<path>`) — collect the
    // project's run ids BEFORE the wipe, then drop each run's blobs.
    const runIds = (await store.listRuns(project.id)).map((r) => r.id);
    const cleared = await store.clearProjectData(project.id);
    let blobsRemoved = 0;
    for (const runId of runIds) blobsRemoved += await blobs.deleteByPrefix(`${runId}/`);
    return c.json({ status: "cleared", project: project.id, ...cleared, blobsRemoved });
  });

  // Spec §4: precomputed metric rollups — refresh recomputes per-flow 7/30-day
  // windows from stored run events; queries just read the rollup rows.
  app.post("/v1/metrics/rollups/refresh", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ error: "no project" }, 400);
    const runs = await store.listRuns(project.id);
    const now = Date.now();
    const computedAt = new Date(now).toISOString();
    const rollups: MetricRollupRow[] = [];
    const byFlow = new Map<string, RunRow[]>();
    for (const run of runs) {
      const key = run.flowId ?? "_project";
      byFlow.set(key, [...(byFlow.get(key) ?? []), run]);
    }
    for (const [flowId, flowRuns] of byFlow) {
      for (const windowDays of [7, 30] as const) {
        const cutoff = now - windowDays * 86_400_000;
        const inWindow = flowRuns.filter((r) => new Date(r.startedAt).getTime() >= cutoff);
        if (inWindow.length === 0) continue;
        const passed = inWindow.filter((r) => r.status === "passed").length;
        let steps = 0;
        let retries = 0;
        let healed = 0;
        let human = 0;
        let guardAborts = 0;
        for (const run of inWindow) {
          const events = (run.events as Array<{ type: string; payload: Record<string, unknown> }> | undefined) ?? [];
          steps += events.filter((e) => e.type === "decide" && e.payload.action).length;
          const runRetries = events.filter((e) => e.type === "retry");
          retries += runRetries.length;
          healed += runRetries.filter((e) => e.payload.ok === true).length;
          human += events.filter((e) => e.type === "human").length;
          guardAborts += events.filter((e) => e.type === "guard" && e.payload.ok === false).length;
        }
        rollups.push({
          id: newId("roll"),
          projectId: project.id,
          flowId,
          windowDays,
          computedAt,
          runs: inWindow.length,
          successRate: inWindow.length ? passed / inWindow.length : 0,
          medianSteps: median(inWindow.map((r) => r.stepCount ?? 0)),
          avgCostUsd: inWindow.length ? inWindow.reduce((s, r) => s + (r.costUsd ?? 0), 0) / inWindow.length : 0,
          selfHealRate: retries ? healed / retries : 0,
          humanInterventionRate: inWindow.length ? human / inWindow.length : 0,
          guardAbortRate: inWindow.length ? guardAborts / inWindow.length : 0,
        });
      }
    }
    await store.replaceMetricRollups(project.id, rollups);
    return c.json({ refreshed: rollups.length, computedAt });
  });

  app.get("/v1/metrics/rollups", async (c) => {
    const { ctx, error } = await requireAuth(c);
    if (!ctx) return error;
    const project = await resolveProject(ctx);
    if (!project) return c.json({ rollups: [] });
    return c.json({ rollups: await store.listMetricRollups(project.id, c.req.query("flowId") || undefined) });
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
