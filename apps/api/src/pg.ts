import pg from "pg";
import type { BillingTier } from "@veriflow/schema";
import { newId, effectiveRole, type AlertRuleRow, type ApiKeyRow, type AuditRow, type DeviceJobRow, type DeviceRow, type FlowRow, type FlowVersionRow, type HumanPauseRow, type InviteRow, type MemberRow, type MetricRollupRow, type ProjectRole, type ProjectRow, type RunRow, type SpanRow, type StepRow, type UsageRow, type UserProgressRow, type UserRow, type WebhookRow, type WorkspaceInviteRow, type WorkspaceMemberRow, type WorkspaceRow } from "./auth.js";
import { SESSION_TTL_MS, type CloudStore } from "./store.js";

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flow_id TEXT,
  objective TEXT NOT NULL,
  env_url TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  step_count INT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION,
  error TEXT,
  events JSONB
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  index INT NOT NULL,
  action JSONB NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT,
  kind TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ok BOOLEAN,
  error TEXT,
  attributes JSONB
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  env_url TEXT,
  schedule TEXT,
  last_scheduled_at TEXT
);
ALTER TABLE flows ADD COLUMN IF NOT EXISTS schedule TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS last_scheduled_at TEXT;
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  threshold DOUBLE PRECISION NOT NULL,
  channel TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS human_pauses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_rollups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  window_days INT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  runs INT NOT NULL,
  success_rate DOUBLE PRECISION NOT NULL,
  median_steps DOUBLE PRECISION NOT NULL,
  avg_cost_usd DOUBLE PRECISION NOT NULL,
  self_heal_rate DOUBLE PRECISION NOT NULL,
  human_intervention_rate DOUBLE PRECISION NOT NULL,
  guard_abort_rate DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_versions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  env_url TEXT,
  schedule TEXT,
  routes JSONB,
  change_hash TEXT NOT NULL,
  last_green_run_id TEXT,
  created_by TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]',
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_delivery_at TIMESTAMPTZ,
  last_delivery_ok BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cost_cap_usd DOUBLE PRECISION;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS flow_version INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS attempt INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS browser TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS healed_steps INTEGER;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS retry_policy JSONB;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS routes JSONB;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  last_heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  env_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_by TEXT,
  claimed_at TEXT,
  result_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_progress (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  onboarding_done JSONB NOT NULL DEFAULT '[]'::jsonb,
  onboarding_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  tour_step INT,
  tour_mode TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function mapDevice(r: pg.QueryResultRow): DeviceRow {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    status: r.status,
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
  };
}
function mapDeviceJob(r: pg.QueryResultRow): DeviceJobRow {
  return {
    id: r.id,
    projectId: r.project_id,
    objective: r.objective,
    envUrl: r.env_url ?? undefined,
    status: r.status,
    claimedBy: r.claimed_by ?? undefined,
    claimedAt: r.claimed_at ?? undefined,
    resultRunId: r.result_run_id ?? undefined,
    createdAt: r.created_at,
  };
}
function mapRollup(r: pg.QueryResultRow): MetricRollupRow {
  return {
    id: r.id,
    projectId: r.project_id,
    flowId: r.flow_id,
    windowDays: r.window_days,
    computedAt: new Date(r.computed_at).toISOString(),
    runs: r.runs,
    successRate: Number(r.success_rate),
    medianSteps: Number(r.median_steps),
    avgCostUsd: Number(r.avg_cost_usd),
    selfHealRate: Number(r.self_heal_rate),
    humanInterventionRate: Number(r.human_intervention_rate),
    guardAbortRate: Number(r.guard_abort_rate),
  };
}

function mapHumanPause(r: pg.QueryResultRow): HumanPauseRow {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    reason: r.reason,
    prompt: r.prompt ?? undefined,
    status: r.status,
    response: r.response ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

function mapAlertRule(r: pg.QueryResultRow): AlertRuleRow {
  return {
    id: r.id,
    projectId: r.project_id,
    metric: r.metric,
    threshold: Number(r.threshold),
    channel: r.channel,
    createdAt: new Date(r.created_at).toISOString(),
    lastTriggeredAt: r.last_triggered_at ? new Date(r.last_triggered_at).toISOString() : undefined,
  };
}

function mapUser(r: pg.QueryResultRow): UserRow {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    tier: r.tier,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export class PgStore implements CloudStore {
  /** Release the pool (tests and CI smokes). */
  async close() {
    await this.pool.end();
  }

  constructor(private readonly pool: pg.Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(DDL);
    return new PgStore(pool);
  }

  async createUser(email: string, passwordHash: string): Promise<UserRow> {
    const id = newId("usr");
    const res = await this.pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)
       RETURNING *`,
      [id, email.toLowerCase(), passwordHash],
    );
    return mapUser(res.rows[0]);
  }
  async getUserByEmail(email: string) {
    const res = await this.pool.query(`SELECT * FROM users WHERE email=$1`, [email.toLowerCase()]);
    return res.rows[0] ? mapUser(res.rows[0]) : undefined;
  }
  async getUser(id: string) {
    const res = await this.pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    return res.rows[0] ? mapUser(res.rows[0]) : undefined;
  }
  async setTier(userId: string, tier: BillingTier) {
    const res = await this.pool.query(`UPDATE users SET tier=$2 WHERE id=$1 RETURNING *`, [userId, tier]);
    return res.rows[0] ? mapUser(res.rows[0]) : undefined;
  }
  async createSession(userId: string, tokenHash: string) {
    await this.pool.query(`INSERT INTO sessions (token_hash, user_id) VALUES ($1,$2)`, [tokenHash, userId]);
  }
  async getSession(tokenHash: string) {
    const res = await this.pool.query(`SELECT * FROM sessions WHERE token_hash=$1`, [tokenHash]);
    const r = res.rows[0];
    if (!r) return undefined;
    const createdAt = new Date(r.created_at).toISOString();
    if (Date.now() - Date.parse(createdAt) > SESSION_TTL_MS) {
      await this.pool.query(`DELETE FROM sessions WHERE token_hash=$1`, [tokenHash]);
      return undefined;
    }
    return { tokenHash: r.token_hash, userId: r.user_id, createdAt };
  }
  async purgeExpiredSessions() {
    const res = await this.pool.query(`DELETE FROM sessions WHERE created_at < now() - interval '30 days' RETURNING token_hash`);
    return res.rowCount ?? 0;
  }
  async createProject(userId: string, name: string): Promise<ProjectRow> {
    const id = newId("prj");
    const res = await this.pool.query(
      `INSERT INTO projects (id, user_id, name) VALUES ($1,$2,$3) RETURNING *`,
      [id, userId, name],
    );
    const r = res.rows[0];
    return { id: r.id, userId: r.user_id, name: r.name, workspaceId: r.workspace_id ?? undefined, createdAt: new Date(r.created_at).toISOString() };
  }
  async listProjects(userId: string) {
    const res = await this.pool.query(`SELECT * FROM projects WHERE user_id=$1`, [userId]);
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      workspaceId: r.workspace_id ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async getProject(id: string) {
    const res = await this.pool.query(`SELECT * FROM projects WHERE id=$1`, [id]);
    const r = res.rows[0];
    if (!r) return undefined;
    return { id: r.id, userId: r.user_id, name: r.name, workspaceId: r.workspace_id ?? undefined, createdAt: new Date(r.created_at).toISOString() };
  }
  async addMember(row: MemberRow) {
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
      [row.projectId, row.userId, row.role, row.addedBy],
    );
    return row;
  }
  async listMembers(projectId: string) {
    const res = await this.pool.query(
      `SELECT m.*, u.email FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id=$1 ORDER BY m.created_at`,
      [projectId],
    );
    return res.rows.map((r) => ({
      projectId: r.project_id,
      userId: r.user_id,
      role: r.role as ProjectRole,
      addedBy: r.added_by,
      createdAt: new Date(r.created_at).toISOString(),
      email: r.email,
    }));
  }
  async listMemberships(userId: string) {
    const res = await this.pool.query(`SELECT * FROM project_members WHERE user_id=$1`, [userId]);
    return res.rows.map((r) => ({
      projectId: r.project_id,
      userId: r.user_id,
      role: r.role as ProjectRole,
      addedBy: r.added_by,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async removeMember(projectId: string, userId: string) {
    const res = await this.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [projectId, userId]);
    return (res.rowCount ?? 0) > 0;
  }
  async setMemberRole(projectId: string, userId: string, role: ProjectRole) {
    const res = await this.pool.query(
      `UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2 RETURNING *`,
      [projectId, userId, role],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    return { projectId: r.project_id, userId: r.user_id, role: r.role as ProjectRole, addedBy: r.added_by, createdAt: new Date(r.created_at).toISOString() };
  }
  async roleFor(projectId: string, userId: string) {
    const res = await this.pool.query(
      `SELECT CASE WHEN p.user_id = $2 THEN 'owner' ELSE m.role END AS role
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
       WHERE p.id = $1`,
      [projectId, userId],
    );
    return res.rows[0]?.role as ProjectRole | undefined;
  }
  async effectiveRoleFor(projectId: string, userId: string) {
    const projectRole = await this.roleFor(projectId, userId);
    const res = await this.pool.query(
      `SELECT CASE WHEN w.user_id = $2 THEN 'owner' ELSE wm.role END AS role
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $2
       WHERE p.id = $1`,
      [projectId, userId],
    );
    const wsRole = res.rows[0]?.role as ProjectRole | undefined;
    return effectiveRole(wsRole, projectRole);
  }
  async createWorkspace(userId: string, name: string) {
    const id = newId("ws");
    const res = await this.pool.query(
      `INSERT INTO workspaces (id, user_id, name) VALUES ($1,$2,$3) RETURNING *`,
      [id, userId, name],
    );
    const r = res.rows[0];
    return { id: r.id, userId: r.user_id, name: r.name, createdAt: new Date(r.created_at).toISOString() };
  }
  async listWorkspaces(userId: string) {
    const res = await this.pool.query(
      `SELECT DISTINCT w.* FROM workspaces w
       LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
       WHERE w.user_id = $1 OR wm.user_id = $1
       ORDER BY w.created_at`,
      [userId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async getWorkspace(id: string) {
    const res = await this.pool.query(`SELECT * FROM workspaces WHERE id=$1`, [id]);
    const r = res.rows[0];
    if (!r) return undefined;
    return { id: r.id, userId: r.user_id, name: r.name, createdAt: new Date(r.created_at).toISOString() };
  }
  async addWorkspaceMember(row: WorkspaceMemberRow) {
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [row.workspaceId, row.userId, row.role, row.addedBy],
    );
    return row;
  }
  async listWorkspaceMembers(workspaceId: string) {
    const res = await this.pool.query(
      `SELECT wm.*, u.email FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 ORDER BY wm.created_at`,
      [workspaceId],
    );
    return res.rows.map((r) => ({
      workspaceId: r.workspace_id,
      userId: r.user_id,
      role: r.role,
      addedBy: r.added_by,
      email: r.email,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async removeWorkspaceMember(workspaceId: string, userId: string) {
    const res = await this.pool.query(
      `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,
      [workspaceId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }
  async setWorkspaceMemberRole(workspaceId: string, userId: string, role: ProjectRole) {
    const res = await this.pool.query(
      `UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2 RETURNING *`,
      [workspaceId, userId, role],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      workspaceId: r.workspace_id,
      userId: r.user_id,
      role: r.role,
      addedBy: r.added_by,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  async createWorkspaceInvite(row: WorkspaceInviteRow) {
    await this.pool.query(
      `INSERT INTO workspace_invites (id, workspace_id, email, role, token, status, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.workspaceId, row.email, row.role, row.token, row.status, row.invitedBy],
    );
    return row;
  }
  async getWorkspaceInviteByToken(token: string) {
    const res = await this.pool.query(`SELECT * FROM workspace_invites WHERE token=$1 AND status='pending'`, [token]);
    return res.rows[0] ? this.mapWorkspaceInvite(res.rows[0]) : undefined;
  }
  async acceptWorkspaceInvite(token: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `SELECT * FROM workspace_invites WHERE token=$1 AND status='pending' FOR UPDATE`,
        [token],
      );
      const r = res.rows[0];
      if (!r) {
        await client.query("COMMIT");
        return undefined;
      }
      await client.query(`UPDATE workspace_invites SET status='accepted' WHERE id=$1`, [r.id]);
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [r.workspace_id, userId, r.role, r.invited_by],
      );
      await client.query("COMMIT");
      return this.mapWorkspaceInvite({ ...r, status: "accepted" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  private mapWorkspaceInvite(r: Record<string, unknown>): WorkspaceInviteRow {
    return {
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      email: r.email as string,
      role: r.role as WorkspaceInviteRow["role"],
      token: r.token as string,
      status: r.status as WorkspaceInviteRow["status"],
      invitedBy: r.invited_by as string,
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async createInvite(row: InviteRow) {
    await this.pool.query(
      `INSERT INTO project_invites (id, project_id, email, role, token, status, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.projectId, row.email, row.role, row.token, row.status, row.invitedBy],
    );
    return row;
  }
  async listInvites(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM project_invites WHERE project_id=$1 ORDER BY created_at DESC`, [projectId]);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      email: r.email,
      role: r.role as ProjectRole,
      token: r.token,
      status: r.status as InviteRow["status"],
      invitedBy: r.invited_by,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async getInviteByToken(token: string) {
    const res = await this.pool.query(`SELECT * FROM project_invites WHERE token=$1 AND status='pending'`, [token]);
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      projectId: r.project_id,
      email: r.email,
      role: r.role as ProjectRole,
      token: r.token,
      status: r.status as InviteRow["status"],
      invitedBy: r.invited_by,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  async acceptInvite(token: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inv = await client.query(`SELECT * FROM project_invites WHERE token=$1 AND status='pending' FOR UPDATE`, [token]);
      const r = inv.rows[0];
      if (!r) {
        await client.query("COMMIT");
        return undefined;
      }
      await client.query(`UPDATE project_invites SET status='accepted' WHERE id=$1`, [r.id]);
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [r.project_id, userId, r.role, r.invited_by],
      );
      await client.query("COMMIT");
      const invite: InviteRow = {
        id: r.id,
        projectId: r.project_id,
        email: r.email,
        role: r.role as ProjectRole,
        token: r.token,
        status: "accepted",
        invitedBy: r.invited_by,
        createdAt: new Date(r.created_at).toISOString(),
      };
      const member: MemberRow = { projectId: r.project_id, userId, role: r.role as ProjectRole, addedBy: r.invited_by, createdAt: new Date().toISOString() };
      return { invite, member };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async revokeInvite(projectId: string, inviteId: string) {
    const res = await this.pool.query(`UPDATE project_invites SET status='revoked' WHERE id=$1 AND project_id=$2`, [inviteId, projectId]);
    return (res.rowCount ?? 0) > 0;
  }
  async findUserByEmail(email: string) {
    const res = await this.pool.query(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email.trim()]);
    const r = res.rows[0];
 if (!r) return undefined;
    return { id: r.id, email: r.email, passwordHash: r.password_hash, tier: r.tier as BillingTier, createdAt: new Date(r.created_at).toISOString() };
  }
  async createApiKey(row: ApiKeyRow) {
    await this.pool.query(
      `INSERT INTO api_keys (id, project_id, name, key_hash, prefix) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.projectId, row.name, row.keyHash, row.prefix],
    );
    return row;
  }
  async listApiKeys(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM api_keys WHERE project_id=$1`, [projectId]);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      keyHash: r.key_hash,
      prefix: r.prefix,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async findApiKey(keyHash: string) {
    const res = await this.pool.query(`SELECT * FROM api_keys WHERE key_hash=$1`, [keyHash]);
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      keyHash: r.key_hash,
      prefix: r.prefix,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  async upsertRun(row: RunRow) {
    await this.pool.query(
      `INSERT INTO runs (id, project_id, flow_id, objective, env_url, status, started_at, ended_at, step_count, cost_usd, error, events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, ended_at=EXCLUDED.ended_at, step_count=EXCLUDED.step_count,
         cost_usd=EXCLUDED.cost_usd, error=EXCLUDED.error, events=EXCLUDED.events`,
      [
        row.id,
        row.projectId,
        row.flowId ?? null,
        row.objective,
        row.envUrl ?? null,
        row.status,
        row.startedAt,
        row.endedAt ?? null,
        row.stepCount,
        row.costUsd ?? null,
        row.error ?? null,
        row.events ? JSON.stringify(row.events) : null,
      ],
    );
    return row;
  }
  async getRun(id: string) {
    const res = await this.pool.query(`SELECT * FROM runs WHERE id=$1`, [id]);
    return res.rows[0] ? this.mapRun(res.rows[0]) : undefined;
  }
  async listRuns(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM runs WHERE project_id=$1 ORDER BY started_at DESC`, [projectId]);
    return res.rows.map((r) => this.mapRun(r));
  }
  async replaceSteps(runId: string, steps: StepRow[]) {
    await this.pool.query(`DELETE FROM steps WHERE run_id=$1`, [runId]);
    for (const s of steps) {
      await this.pool.query(
        `INSERT INTO steps (id, run_id, index, action, status, started_at, ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [s.id, s.runId, s.index, JSON.stringify(s.action), s.status, s.startedAt, s.endedAt ?? null],
      );
    }
  }
  async listSteps(runId: string) {
    const res = await this.pool.query(`SELECT * FROM steps WHERE run_id=$1 ORDER BY index`, [runId]);
    return res.rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      index: r.index,
      action: r.action,
      status: r.status,
      startedAt: new Date(r.started_at).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : undefined,
    }));
  }
  async replaceSpans(runId: string, spans: SpanRow[]) {
    await this.pool.query(`DELETE FROM spans WHERE run_id=$1`, [runId]);
    for (const s of spans) {
      await this.pool.query(
        `INSERT INTO spans (id, run_id, step_id, kind, started_at, ended_at, ok, error, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          s.id,
          s.runId,
          s.stepId ?? null,
          s.kind,
          s.startedAt,
          s.endedAt ?? null,
          s.ok ?? null,
          s.error ?? null,
          s.attributes ? JSON.stringify(s.attributes) : null,
        ],
      );
    }
  }
  async listSpans(runId: string) {
    const res = await this.pool.query(`SELECT * FROM spans WHERE run_id=$1`, [runId]);
    return res.rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stepId: r.step_id ?? undefined,
      kind: r.kind,
      startedAt: new Date(r.started_at).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : undefined,
      ok: r.ok ?? undefined,
      error: r.error ?? undefined,
      attributes: r.attributes ?? undefined,
    }));
  }
  async addUsage(row: UsageRow) {
    await this.pool.query(
      `INSERT INTO usage_ledger (id, project_id, run_id, kind, amount, unit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.projectId, row.runId ?? null, row.kind, row.amount, row.unit, row.createdAt],
    );
  }
  async listUsage(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM usage_ledger WHERE project_id=$1 ORDER BY created_at DESC`, [
      projectId,
    ]);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      runId: r.run_id ?? undefined,
      kind: r.kind,
      amount: Number(r.amount),
      unit: r.unit,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async setProjectWorkspace(projectId: string, workspaceId: string | undefined) {
    const res = await this.pool.query(
      `UPDATE projects SET workspace_id=$2 WHERE id=$1 RETURNING *`,
      [projectId, workspaceId ?? null],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    return { id: r.id, userId: r.user_id, name: r.name, workspaceId: r.workspace_id ?? undefined, createdAt: new Date(r.created_at).toISOString() };
  }
  async listUsageByWorkspace(workspaceId: string) {
    const res = await this.pool.query(
      `SELECT u.* FROM usage_ledger u
       JOIN projects p ON p.id = u.project_id
       WHERE p.workspace_id = $1
       ORDER BY u.created_at DESC`,
      [workspaceId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      runId: r.run_id ?? undefined,
      kind: r.kind,
      amount: Number(r.amount),
      unit: r.unit,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async monthlyRunCount(projectId: string, monthStartIso: string) {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger WHERE project_id=$1 AND kind='run' AND created_at >= $2`,
      [projectId, monthStartIso],
    );
    return res.rows[0]?.n ?? 0;
  }
  async saveFlow(row: FlowRow) {
    await this.pool.query(
      `INSERT INTO flows (id, project_id, name, objective, env_url, schedule, last_scheduled_at, retry_policy, quarantined, version, routes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, objective=EXCLUDED.objective, env_url=EXCLUDED.env_url,
         schedule=EXCLUDED.schedule, last_scheduled_at=EXCLUDED.last_scheduled_at, retry_policy=EXCLUDED.retry_policy,
         quarantined=EXCLUDED.quarantined, version=EXCLUDED.version, routes=EXCLUDED.routes`,
      [row.id, row.projectId, row.name, row.objective, row.envUrl ?? null, row.schedule ?? null, row.lastScheduledAt ?? null,
        row.retryPolicy ? JSON.stringify(row.retryPolicy) : null, row.quarantined ?? false, row.version ?? 1,
        row.routes ? JSON.stringify(row.routes) : null],
    );
    return row;
  }
  async listFlows(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM flows WHERE project_id=$1`, [projectId]);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      objective: r.objective,
      envUrl: r.env_url ?? undefined,
      schedule: r.schedule ?? undefined,
      lastScheduledAt: r.last_scheduled_at ?? undefined,
      retryPolicy: r.retry_policy ?? undefined,
      quarantined: r.quarantined ?? false,
      version: r.version ?? 1,
      routes: r.routes ?? undefined,
    }));
  }
  async listAllRuns() {
    const res = await this.pool.query(`SELECT * FROM runs ORDER BY started_at DESC`);
    return res.rows.map((r) => this.mapRun(r));
  }

  async saveAlertRule(rule: AlertRuleRow) {
    await this.pool.query(
      `INSERT INTO alert_rules (id, project_id, metric, threshold, channel, created_at, last_triggered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET metric=EXCLUDED.metric, threshold=EXCLUDED.threshold,
         channel=EXCLUDED.channel, last_triggered_at=EXCLUDED.last_triggered_at`,
      [rule.id, rule.projectId, rule.metric, rule.threshold, rule.channel, rule.createdAt, rule.lastTriggeredAt ?? null],
    );
    return rule;
  }
  async listAlertRules(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM alert_rules WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return res.rows.map(mapAlertRule);
  }
  async deleteAlertRule(projectId: string, ruleId: string) {
    const res = await this.pool.query(`DELETE FROM alert_rules WHERE id=$1 AND project_id=$2`, [ruleId, projectId]);
    return (res.rowCount ?? 0) > 0;
  }
  async markAlertTriggered(ruleId: string, at: string) {
    await this.pool.query(`UPDATE alert_rules SET last_triggered_at=$2 WHERE id=$1`, [ruleId, at]);
  }

  async createHumanPause(pause: HumanPauseRow) {
    await this.pool.query(
      `INSERT INTO human_pauses (id, run_id, project_id, reason, prompt, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pause.id, pause.runId, pause.projectId, pause.reason, pause.prompt ?? null, pause.status, pause.createdAt, pause.expiresAt],
    );
    return pause;
  }
  async listHumanPauses(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM human_pauses WHERE project_id=$1 ORDER BY created_at DESC`, [
      projectId,
    ]);
    return res.rows.map(mapHumanPause);
  }
  async getHumanPause(id: string) {
    const res = await this.pool.query(`SELECT * FROM human_pauses WHERE id=$1`, [id]);
    const r = res.rows[0];
    if (!r) return undefined;
    const pause = mapHumanPause(r);
    if (pause.status === "pending" && pause.expiresAt < new Date().toISOString()) {
      await this.pool.query(`UPDATE human_pauses SET status='expired' WHERE id=$1`, [id]);
      return { ...pause, status: "expired" as const };
    }
    return pause;
  }
  async resolveHumanPause(id: string, response: string) {
    const res = await this.pool.query(
      `UPDATE human_pauses SET status='resolved', response=$2, resolved_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, response],
    );
    return res.rows[0] ? mapHumanPause(res.rows[0]) : undefined;
  }

  async replaceMetricRollups(projectId: string, rollups: MetricRollupRow[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM metric_rollups WHERE project_id=$1`, [projectId]);
      for (const r of rollups) {
        await client.query(
          `INSERT INTO metric_rollups
           (id, project_id, flow_id, window_days, computed_at, runs, success_rate, median_steps,
            avg_cost_usd, self_heal_rate, human_intervention_rate, guard_abort_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [r.id, r.projectId, r.flowId, r.windowDays, r.computedAt, r.runs, r.successRate, r.medianSteps,
           r.avgCostUsd, r.selfHealRate, r.humanInterventionRate, r.guardAbortRate],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async listMetricRollups(projectId: string, flowId?: string) {
    const res = flowId
      ? await this.pool.query(`SELECT * FROM metric_rollups WHERE project_id=$1 AND flow_id=$2`, [projectId, flowId])
      : await this.pool.query(`SELECT * FROM metric_rollups WHERE project_id=$1`, [projectId]);
    return res.rows.map(mapRollup);
  }

  async getUserProgress(userId: string): Promise<UserProgressRow | undefined> {
    const res = await this.pool.query(`SELECT * FROM user_progress WHERE user_id=$1`, [userId]);
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      userId: r.user_id,
      onboardingDone: r.onboarding_done ?? [],
      onboardingDismissed: r.onboarding_dismissed,
      tourStep: r.tour_step ?? undefined,
      tourMode: r.tour_mode ?? undefined,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
  async claimDueFlows(projectId: string, now: Date) {
    const res = await this.pool.query(
      `UPDATE flows SET last_scheduled_at = $2
       WHERE project_id = $1 AND schedule IS NOT NULL AND schedule <> '' AND quarantined = FALSE
         AND (last_scheduled_at IS NULL OR last_scheduled_at <> $2)
       RETURNING id, name, objective, env_url, schedule, retry_policy`,
      [projectId, now.toISOString()],
    );
    // Cron filtering happens in-process: the claim is per-minute idempotent,
    // which is what an external scheduler polling every minute needs.
    const { cronMatches, parseCron } = await import("@veriflow/harness");
    return res.rows
      .filter((r) => {
        try {
          return cronMatches(parseCron(r.schedule as string), now);
        } catch {
          return false;
        }
      })
      .map((r) => ({
        flowId: r.id as string,
        name: r.name as string,
        objective: r.objective as string,
        envUrl: (r.env_url ?? undefined) as string | undefined,
        schedule: r.schedule as string,
        retryPolicy: (r.retry_policy ?? undefined) as { maxAttempts: number; backoffSeconds: number } | undefined,
      }));
  }
  async saveUserProgress(row: UserProgressRow): Promise<UserProgressRow> {
    await this.pool.query(
      `INSERT INTO user_progress (user_id, onboarding_done, onboarding_dismissed, tour_step, tour_mode, updated_at)
       VALUES ($1,$2::jsonb,$3,$4,$5,now())
       ON CONFLICT (user_id) DO UPDATE SET
         onboarding_done = EXCLUDED.onboarding_done,
         onboarding_dismissed = EXCLUDED.onboarding_dismissed,
         tour_step = EXCLUDED.tour_step,
         tour_mode = EXCLUDED.tour_mode,
         updated_at = now()`,
      [row.userId, JSON.stringify(row.onboardingDone), row.onboardingDismissed, row.tourStep ?? null, row.tourMode ?? null],
    );
    return row;
  }
  async deleteUserProgress(userId: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM user_progress WHERE user_id=$1`, [userId]);
    return (res.rowCount ?? 0) > 0;
  }

  // Hosted device cloud.
  async saveDevice(row: DeviceRow): Promise<DeviceRow> {
    await this.pool.query(
      `INSERT INTO devices (id, project_id, name, status, last_heartbeat_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, last_heartbeat_at=EXCLUDED.last_heartbeat_at`,
      [row.id, row.projectId, row.name, row.status, row.lastHeartbeatAt, row.createdAt],
    );
    return row;
  }
  async listDevices(projectId: string): Promise<DeviceRow[]> {
    const res = await this.pool.query(`SELECT * FROM devices WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return res.rows.map(mapDevice);
  }
  async getDevice(id: string): Promise<DeviceRow | undefined> {
    const res = await this.pool.query(`SELECT * FROM devices WHERE id=$1`, [id]);
    return res.rows[0] ? mapDevice(res.rows[0]) : undefined;
  }
  async heartbeatDevice(id: string, status: "online" | "offline"): Promise<DeviceRow | undefined> {
    const res = await this.pool.query(
      `UPDATE devices SET status=$2, last_heartbeat_at=$3 WHERE id=$1 RETURNING *`,
      [id, status, new Date().toISOString()],
    );
    return res.rows[0] ? mapDevice(res.rows[0]) : undefined;
  }
  async queueDeviceJob(row: DeviceJobRow): Promise<DeviceJobRow> {
    await this.pool.query(
      `INSERT INTO device_jobs (id, project_id, objective, env_url, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.projectId, row.objective, row.envUrl ?? null, row.status, row.createdAt],
    );
    return row;
  }
  async listDeviceJobs(projectId: string): Promise<DeviceJobRow[]> {
    const res = await this.pool.query(`SELECT * FROM device_jobs WHERE project_id=$1 ORDER BY created_at`, [projectId]);
    return res.rows.map(mapDeviceJob);
  }
  async claimDeviceJob(deviceId: string): Promise<DeviceJobRow | undefined> {
    const device = await this.getDevice(deviceId);
    if (!device) return undefined;
    await this.heartbeatDevice(deviceId, "online");
    const res = await this.pool.query(
      `UPDATE device_jobs SET status='claimed', claimed_by=$2, claimed_at=$3
       WHERE id = (SELECT id FROM device_jobs WHERE project_id=$1 AND status='queued' ORDER BY created_at LIMIT 1)
       RETURNING *`,
      [device.projectId, deviceId, new Date().toISOString()],
    );
    return res.rows[0] ? mapDeviceJob(res.rows[0]) : undefined;
  }
  async completeDeviceJob(id: string, resultRunId: string): Promise<DeviceJobRow | undefined> {
    const res = await this.pool.query(
      `UPDATE device_jobs SET status='done', result_run_id=$2 WHERE id=$1 RETURNING *`,
      [id, resultRunId],
    );
    return res.rows[0] ? mapDeviceJob(res.rows[0]) : undefined;
  }
  async clearProjectData(projectId: string) {
    // Collect the run ids first so steps/spans (keyed by run, not project) go too.
    const runIdsRes = await this.pool.query(`SELECT id FROM runs WHERE project_id=$1`, [projectId]);
    const runIds = runIdsRes.rows.map((r) => r.id as string);
    const result = { runs: runIds.length, flows: 0, alertRules: 0, usage: 0 };
    if (runIds.length > 0) {
      await this.pool.query(`DELETE FROM steps WHERE run_id = ANY($1)`, [runIds]);
      await this.pool.query(`DELETE FROM spans WHERE run_id = ANY($1)`, [runIds]);
    }
    const tables: [string, "runs" | "flows" | "alertRules" | "usage" | null][] = [
      ["runs", "runs"],
      ["flows", "flows"],
      ["alert_rules", "alertRules"],
      ["usage", "usage"],
      ["human_pauses", null],
      ["metric_rollups", null],
    ];
    for (const [table, countKey] of tables) {
      const res = await this.pool.query(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
      if (countKey) result[countKey] = res.rowCount ?? 0;
    }
    return result;
  }
  async listAllUserProgress(): Promise<UserProgressRow[]> {
    const res = await this.pool.query(`SELECT * FROM user_progress`);
    return res.rows.map((r) => ({
      userId: r.user_id,
      onboardingDone: r.onboarding_done ?? [],
      onboardingDismissed: r.onboarding_dismissed,
      tourStep: r.tour_step ?? undefined,
      tourMode: r.tour_mode ?? undefined,
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  private mapRun(r: pg.QueryResultRow): RunRow {
    return {
      id: r.id,
      projectId: r.project_id,
      flowId: r.flow_id ?? undefined,
      objective: r.objective,
      envUrl: r.env_url ?? undefined,
      status: r.status,
      startedAt: new Date(r.started_at).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : undefined,
      stepCount: r.step_count,
      costUsd: r.cost_usd ?? undefined,
      error: r.error ?? undefined,
      events: r.events ?? undefined,
      flowVersion: r.flow_version ?? undefined,
      attempt: r.attempt ?? undefined,
      browser: r.browser ?? undefined,
      healedSteps: r.healed_steps ?? undefined,
    };
  }

  // ---- Flow versioning ----
  async saveFlowVersion(row: FlowVersionRow) {
    await this.pool.query(
      `INSERT INTO flow_versions (id, flow_id, project_id, version, name, objective, env_url, schedule, routes, change_hash, last_green_run_id, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (flow_id, version) DO NOTHING`,
      [row.id, row.flowId, row.projectId, row.version, row.name, row.objective, row.envUrl ?? null, row.schedule ?? null,
        row.routes ? JSON.stringify(row.routes) : null, row.changeHash, row.lastGreenRunId ?? null, row.createdBy, row.note ?? null],
    );
    return row;
  }
  async listFlowVersions(flowId: string) {
    const res = await this.pool.query(`SELECT * FROM flow_versions WHERE flow_id=$1 ORDER BY version DESC`, [flowId]);
    return res.rows.map((r) => this.mapFlowVersion(r));
  }
  async getFlowVersion(flowId: string, version: number) {
    const res = await this.pool.query(`SELECT * FROM flow_versions WHERE flow_id=$1 AND version=$2`, [flowId, version]);
    return res.rows[0] ? this.mapFlowVersion(res.rows[0]) : undefined;
  }
  async markVersionGreen(flowId: string, version: number, runId: string) {
    await this.pool.query(`UPDATE flow_versions SET last_green_run_id=$3 WHERE flow_id=$1 AND version=$2`, [flowId, version, runId]);
  }
  private mapFlowVersion(r: pg.QueryResultRow): FlowVersionRow {
    return {
      id: r.id,
      flowId: r.flow_id,
      projectId: r.project_id,
      version: r.version,
      name: r.name,
      objective: r.objective,
      envUrl: r.env_url ?? undefined,
      schedule: r.schedule ?? undefined,
      routes: r.routes ?? undefined,
      changeHash: r.change_hash,
      lastGreenRunId: r.last_green_run_id ?? undefined,
      createdBy: r.created_by,
      note: r.note ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  // ---- Outbound webhooks ----
  async saveWebhook(row: WebhookRow) {
    await this.pool.query(
      `INSERT INTO webhooks (id, project_id, url, secret, events, disabled) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, events=EXCLUDED.events, disabled=EXCLUDED.disabled`,
      [row.id, row.projectId, row.url, row.secret, JSON.stringify(row.events), row.disabled ?? false],
    );
    return row;
  }
  async listWebhooks(projectId: string) {
    const res = await this.pool.query(`SELECT * FROM webhooks WHERE project_id=$1`, [projectId]);
    return res.rows.map((r) => this.mapWebhook(r));
  }
  async deleteWebhook(projectId: string, id: string) {
    const res = await this.pool.query(`DELETE FROM webhooks WHERE project_id=$1 AND id=$2`, [projectId, id]);
    return (res.rowCount ?? 0) > 0;
  }
  async listAllWebhooks() {
    const res = await this.pool.query(`SELECT * FROM webhooks`);
    return res.rows.map((r) => this.mapWebhook(r));
  }
  async markWebhookDelivery(id: string, ok: boolean, at: string) {
    await this.pool.query(`UPDATE webhooks SET last_delivery_at=$2, last_delivery_ok=$3 WHERE id=$1`, [id, at, ok]);
  }
  private mapWebhook(r: pg.QueryResultRow): WebhookRow {
    return {
      id: r.id,
      projectId: r.project_id,
      url: r.url,
      secret: r.secret,
      events: r.events ?? [],
      disabled: r.disabled ?? false,
      lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).toISOString() : undefined,
      lastDeliveryOk: r.last_delivery_ok ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  // ---- Audit log ----
  async addAudit(row: AuditRow) {
    await this.pool.query(
      `INSERT INTO audit_log (id, project_id, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.projectId ?? null, row.actor, row.action, row.target ?? null, row.detail ? JSON.stringify(row.detail) : null],
    );
  }
  async listAudit(projectId: string, limit = 100) {
    const res = await this.pool.query(`SELECT * FROM audit_log WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`, [projectId, limit]);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id ?? undefined,
      actor: r.actor,
      action: r.action,
      target: r.target ?? undefined,
      detail: r.detail ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  // ---- Flake detection ----
  async listRecentRunsForFlow(flowId: string, limit: number) {
    const res = await this.pool.query(
      `SELECT * FROM runs WHERE flow_id=$1 ORDER BY started_at DESC LIMIT $2`,
      [flowId, limit],
    );
    return res.rows.map((r) => this.mapRun(r));
  }

  // ---- Retention purge ----
  async purgeRunsBefore(projectId: string, cutoffIso: string) {
    const ids = await this.pool.query(`SELECT id FROM runs WHERE project_id=$1 AND started_at < $2`, [projectId, cutoffIso]);
    for (const row of ids.rows) {
      await this.pool.query(`DELETE FROM steps WHERE run_id=$1`, [row.id]);
      await this.pool.query(`DELETE FROM spans WHERE run_id=$1`, [row.id]);
    }
    const res = await this.pool.query(`DELETE FROM runs WHERE project_id=$1 AND started_at < $2`, [projectId, cutoffIso]);
    return { runs: res.rowCount ?? 0 };
  }

  // ---- Cost cap ----
  async monthlyCostUsd(projectId: string, monthStartIso: string) {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM usage_ledger WHERE project_id=$1 AND unit='usd' AND created_at >= $2`,
      [projectId, monthStartIso],
    );
    return Number(res.rows[0]?.total ?? 0);
  }
  async setUserCostCap(userId: string, costCapUsd: number | undefined) {
    const res = await this.pool.query(
      `UPDATE users SET cost_cap_usd=$2 WHERE id=$1 RETURNING *`,
      [userId, costCapUsd ?? null],
    );
    return res.rows[0] ? mapUser(res.rows[0]) : undefined;
  }
}

export async function tryPgStore(url?: string): Promise<PgStore | undefined> {
  if (!url) return undefined;
  try {
    return await PgStore.connect(url);
  } catch (err) {
    console.warn("Postgres unavailable, falling back to filesystem store:", err instanceof Error ? err.message : err);
    return undefined;
  }
}
