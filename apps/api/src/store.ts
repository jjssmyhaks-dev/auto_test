import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIER_QUOTAS, type BillingTier } from "@veriflow/schema";
import {
  hashToken,
  newId,
  type AlertRuleRow,
  type ApiKeyRow,
  type FlowRow,
  type HumanPauseRow,
  type MetricRollupRow,
  type ProjectRow,
  type RunRow,
  type SessionRow,
  type SpanRow,
  type StepRow,
  type UsageRow,
  type UserRow,
} from "./auth.js";

export interface CloudStore {
  createUser(email: string, passwordHash: string): Promise<UserRow>;
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  getUser(id: string): Promise<UserRow | undefined>;
  setTier(userId: string, tier: BillingTier): Promise<UserRow | undefined>;
  createSession(userId: string, tokenHash: string): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | undefined>;
  createProject(userId: string, name: string): Promise<ProjectRow>;
  listProjects(userId: string): Promise<ProjectRow[]>;
  getProject(id: string): Promise<ProjectRow | undefined>;
  createApiKey(row: ApiKeyRow): Promise<ApiKeyRow>;
  listApiKeys(projectId: string): Promise<ApiKeyRow[]>;
  findApiKey(keyHash: string): Promise<ApiKeyRow | undefined>;
  upsertRun(row: RunRow): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | undefined>;
  listRuns(projectId: string): Promise<RunRow[]>;
  replaceSteps(runId: string, steps: StepRow[]): Promise<void>;
  listSteps(runId: string): Promise<StepRow[]>;
  replaceSpans(runId: string, spans: SpanRow[]): Promise<void>;
  listSpans(runId: string): Promise<SpanRow[]>;
  addUsage(row: UsageRow): Promise<void>;
  listUsage(projectId: string): Promise<UsageRow[]>;
  monthlyRunCount(projectId: string, monthStartIso: string): Promise<number>;
  saveFlow(row: FlowRow): Promise<FlowRow>;
  listFlows(projectId: string): Promise<FlowRow[]>;
  listAllRuns(): Promise<RunRow[]>;
  saveAlertRule(rule: AlertRuleRow): Promise<AlertRuleRow>;
  listAlertRules(projectId: string): Promise<AlertRuleRow[]>;
  deleteAlertRule(projectId: string, ruleId: string): Promise<boolean>;
  markAlertTriggered(ruleId: string, at: string): Promise<void>;
  createHumanPause(pause: HumanPauseRow): Promise<HumanPauseRow>;
  listHumanPauses(projectId: string): Promise<HumanPauseRow[]>;
  getHumanPause(id: string): Promise<HumanPauseRow | undefined>;
  resolveHumanPause(id: string, response: string): Promise<HumanPauseRow | undefined>;
  replaceMetricRollups(projectId: string, rollups: MetricRollupRow[]): Promise<void>;
  listMetricRollups(projectId: string, flowId?: string): Promise<MetricRollupRow[]>;
}

interface FileDb {
  users: UserRow[];
  sessions: SessionRow[];
  projects: ProjectRow[];
  keys: ApiKeyRow[];
  runs: RunRow[];
  steps: StepRow[];
  spans: SpanRow[];
  usage: UsageRow[];
  flows: FlowRow[];
  alertRules: AlertRuleRow[];
  humanPauses: HumanPauseRow[];
  metricRollups: MetricRollupRow[];
}

function emptyDb(): FileDb {
  return {
    users: [],
    sessions: [],
    projects: [],
    keys: [],
    runs: [],
    steps: [],
    spans: [],
    usage: [],
    flows: [],
    alertRules: [],
    humanPauses: [],
    metricRollups: [],
  };
}

export class MemoryStore implements CloudStore {
  constructor(private db: FileDb = emptyDb(), private persist?: () => void) {}

  static fromFile(dir: string): MemoryStore {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cloud.json");
    let db = emptyDb();
    if (existsSync(file)) {
      try {
        db = { ...emptyDb(), ...(JSON.parse(readFileSync(file, "utf8")) as FileDb) };
      } catch {
        db = emptyDb();
      }
    }
    const store = new MemoryStore(db, () => {
      writeFileSync(file, JSON.stringify(store.db, null, 2), "utf8");
    });
    return store;
  }

  private touch() {
    this.persist?.();
  }

  async createUser(email: string, passwordHash: string): Promise<UserRow> {
    const existing = this.db.users.find((u) => u.email === email.toLowerCase());
    if (existing) throw Object.assign(new Error("email already registered"), { status: 409 });
    const row: UserRow = {
      id: newId("usr"),
      email: email.toLowerCase(),
      passwordHash,
      tier: "free",
      createdAt: new Date().toISOString(),
    };
    this.db.users.push(row);
    this.touch();
    return row;
  }
  async getUserByEmail(email: string) {
    return this.db.users.find((u) => u.email === email.toLowerCase());
  }
  async getUser(id: string) {
    return this.db.users.find((u) => u.id === id);
  }
  async setTier(userId: string, tier: BillingTier) {
    const u = this.db.users.find((x) => x.id === userId);
    if (!u) return undefined;
    u.tier = tier;
    this.touch();
    return u;
  }
  async createSession(userId: string, tokenHash: string) {
    this.db.sessions.push({ tokenHash, userId, createdAt: new Date().toISOString() });
    this.touch();
  }
  async getSession(tokenHash: string) {
    return this.db.sessions.find((s) => s.tokenHash === tokenHash);
  }
  async createProject(userId: string, name: string) {
    const row: ProjectRow = { id: newId("prj"), userId, name, createdAt: new Date().toISOString() };
    this.db.projects.push(row);
    this.touch();
    return row;
  }
  async listProjects(userId: string) {
    return this.db.projects.filter((p) => p.userId === userId);
  }
  async getProject(id: string) {
    return this.db.projects.find((p) => p.id === id);
  }
  async createApiKey(row: ApiKeyRow) {
    this.db.keys.push(row);
    this.touch();
    return row;
  }
  async listApiKeys(projectId: string) {
    return this.db.keys.filter((k) => k.projectId === projectId);
  }
  async findApiKey(keyHash: string) {
    return this.db.keys.find((k) => k.keyHash === keyHash);
  }
  async upsertRun(row: RunRow) {
    const i = this.db.runs.findIndex((r) => r.id === row.id);
    if (i >= 0) this.db.runs[i] = row;
    else this.db.runs.push(row);
    this.touch();
    return row;
  }
  async getRun(id: string) {
    return this.db.runs.find((r) => r.id === id);
  }
  async listRuns(projectId: string) {
    return this.db.runs.filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async replaceSteps(runId: string, steps: StepRow[]) {
    this.db.steps = this.db.steps.filter((s) => s.runId !== runId).concat(steps);
    this.touch();
  }
  async listSteps(runId: string) {
    return this.db.steps.filter((s) => s.runId === runId).sort((a, b) => a.index - b.index);
  }
  async replaceSpans(runId: string, spans: SpanRow[]) {
    this.db.spans = this.db.spans.filter((s) => s.runId !== runId).concat(spans);
    this.touch();
  }
  async listSpans(runId: string) {
    return this.db.spans.filter((s) => s.runId === runId);
  }
  async addUsage(row: UsageRow) {
    this.db.usage.push(row);
    this.touch();
  }
  async listUsage(projectId: string) {
    return this.db.usage.filter((u) => u.projectId === projectId);
  }
  async monthlyRunCount(projectId: string, monthStartIso: string) {
    return this.db.usage.filter(
      (u) => u.projectId === projectId && u.kind === "run" && u.createdAt >= monthStartIso,
    ).length;
  }
  async saveFlow(row: FlowRow) {
    const i = this.db.flows.findIndex((f) => f.id === row.id);
    if (i >= 0) this.db.flows[i] = row;
    else this.db.flows.push(row);
    this.touch();
    return row;
  }
  async listFlows(projectId: string) {
    return this.db.flows.filter((f) => f.projectId === projectId);
  }
  async listAllRuns() {
    return this.db.runs;
  }
  async saveAlertRule(rule: AlertRuleRow) {
    const i = this.db.alertRules.findIndex((r) => r.id === rule.id);
    if (i >= 0) this.db.alertRules[i] = rule;
    else this.db.alertRules.push(rule);
    this.persist?.();
    return rule;
  }
  async listAlertRules(projectId: string) {
    return this.db.alertRules.filter((r) => r.projectId === projectId);
  }
  async deleteAlertRule(projectId: string, ruleId: string) {
    const i = this.db.alertRules.findIndex((r) => r.id === ruleId && r.projectId === projectId);
    if (i < 0) return false;
    this.db.alertRules.splice(i, 1);
    this.persist?.();
    return true;
  }
  async markAlertTriggered(ruleId: string, at: string) {
    const rule = this.db.alertRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.lastTriggeredAt = at;
      this.persist?.();
    }
  }
  async createHumanPause(pause: HumanPauseRow) {
    this.db.humanPauses.push(pause);
    this.persist?.();
    return pause;
  }
  async listHumanPauses(projectId: string) {
    return this.db.humanPauses
      .filter((p) => p.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async getHumanPause(id: string) {
    const pause = this.db.humanPauses.find((p) => p.id === id);
    if (pause && pause.status === "pending" && pause.expiresAt < new Date().toISOString()) {
      pause.status = "expired";
      this.persist?.();
    }
    return pause;
  }
  async resolveHumanPause(id: string, response: string) {
    const pause = this.db.humanPauses.find((p) => p.id === id);
    if (!pause || pause.status !== "pending") return undefined;
    pause.status = "resolved";
    pause.response = response;
    pause.resolvedAt = new Date().toISOString();
    this.persist?.();
    return pause;
  }
  async replaceMetricRollups(projectId: string, rollups: MetricRollupRow[]) {
    this.db.metricRollups = this.db.metricRollups.filter((r) => r.projectId !== projectId).concat(rollups);
    this.persist?.();
  }
  async listMetricRollups(projectId: string, flowId?: string) {
    return this.db.metricRollups
      .filter((r) => r.projectId === projectId && (!flowId || r.flowId === flowId))
      .sort((a, b) => (a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : a.windowDays - b.windowDays));
  }
}

export const QUOTAS = TIER_QUOTAS;

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function computeAlerts(runs: RunRow[]): { kind: "cost_spike" | "success_rate"; severity: string; message: string; value: number }[] {
  const alerts: { kind: "cost_spike" | "success_rate"; severity: string; message: string; value: number }[] = [];
  const recent = runs.slice(0, 20);
  if (recent.length >= 5) {
    const pass = recent.filter((r) => r.status === "passed").length / recent.length;
    if (pass < 0.6) {
      alerts.push({
        kind: "success_rate",
        severity: pass < 0.3 ? "critical" : "warning",
        message: `Success rate ${Math.round(pass * 100)}% over last ${recent.length} runs`,
        value: pass,
      });
    }
  }
  const costs = runs.map((r) => r.costUsd ?? 0).filter((c) => c > 0);
  if (costs.length >= 3) {
    const median = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)];
    const last = costs[0] ?? runs[0]?.costUsd ?? 0;
    if (median > 0 && last > median * 3) {
      alerts.push({
        kind: "cost_spike",
        severity: "warning",
        message: `Latest LLM cost $${last.toFixed(4)} is >3x median $${median.toFixed(4)}`,
        value: last,
      });
    }
  }
  return alerts;
}

export { hashToken };
