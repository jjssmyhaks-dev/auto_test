import pg from "pg";
import type { BillingTier } from "@veriflow/schema";
import { newId, type ApiKeyRow, type FlowRow, type ProjectRow, type RunRow, type SpanRow, type StepRow, type UsageRow, type UserRow } from "./auth.js";
import type { CloudStore } from "./store.js";

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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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
  env_url TEXT
);
`;

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
    return { tokenHash: r.token_hash, userId: r.user_id, createdAt: new Date(r.created_at).toISOString() };
  }
  async createProject(userId: string, name: string): Promise<ProjectRow> {
    const id = newId("prj");
    const res = await this.pool.query(
      `INSERT INTO projects (id, user_id, name) VALUES ($1,$2,$3) RETURNING *`,
      [id, userId, name],
    );
    const r = res.rows[0];
    return { id: r.id, userId: r.user_id, name: r.name, createdAt: new Date(r.created_at).toISOString() };
  }
  async listProjects(userId: string) {
    const res = await this.pool.query(`SELECT * FROM projects WHERE user_id=$1`, [userId]);
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async getProject(id: string) {
    const res = await this.pool.query(`SELECT * FROM projects WHERE id=$1`, [id]);
    const r = res.rows[0];
    if (!r) return undefined;
    return { id: r.id, userId: r.user_id, name: r.name, createdAt: new Date(r.created_at).toISOString() };
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
  async monthlyRunCount(projectId: string, monthStartIso: string) {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger WHERE project_id=$1 AND kind='run' AND created_at >= $2`,
      [projectId, monthStartIso],
    );
    return res.rows[0]?.n ?? 0;
  }
  async saveFlow(row: FlowRow) {
    await this.pool.query(
      `INSERT INTO flows (id, project_id, name, objective, env_url) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, objective=EXCLUDED.objective, env_url=EXCLUDED.env_url`,
      [row.id, row.projectId, row.name, row.objective, row.envUrl ?? null],
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
    }));
  }
  async listAllRuns() {
    const res = await this.pool.query(`SELECT * FROM runs ORDER BY started_at DESC`);
    return res.rows.map((r) => this.mapRun(r));
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
    };
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
