/**
 * @veriflow/sdk — official TypeScript client for the Veriflow cloud API.
 * Zero dependencies; works in Node 18+ and browsers. Point it at your API
 * with `new Veriflow({ apiUrl, token })` or `Veriflow.fromEnv()`.
 */

export interface VeriflowOptions {
  /** API base, e.g. https://api.veriflow.dev (no trailing slash needed). */
  apiUrl: string;
  /** Session token (signup/login) or project API key. */
  token?: string;
  /** Per-request timeout ms (default 30s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RunInput {
  projectId?: string;
  flowId?: string;
  objective: string;
  envUrl?: string;
  status?: "queued" | "running" | "passed" | "failed" | "paused" | "aborted";
  stepCount?: number;
  costUsd?: number;
  error?: string;
  attempt?: number;
  browser?: "chromium" | "firefox" | "webkit";
  healedSteps?: number;
}

export interface Run {
  id: string;
  projectId: string;
  flowId?: string;
  objective: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  stepCount: number;
  flowVersion?: number;
  attempt?: number;
  browser?: string;
  healedSteps?: number;
  error?: string;
}

export interface Flow {
  id: string;
  name: string;
  objective: string;
  envUrl?: string;
  schedule?: string;
  version?: number;
  quarantined?: boolean;
  retryPolicy?: { maxAttempts: number; backoffSeconds: number };
}

export interface Trace {
  run: Run;
  steps: unknown[];
  spans: unknown[];
  screenshots: string[];
}

export interface FlakeReport {
  flowId: string;
  flakeScore: number;
  runsConsidered: number;
  flips: number;
  quarantined: boolean;
}

export class VeriflowError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "VeriflowError";
  }
}

export class Veriflow {
  private readonly base: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;

  constructor(opts: VeriflowOptions) {
    this.base = opts.apiUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.f = opts.fetchImpl ?? fetch;
  }

  /** Build from VERIFLOW_API_URL + VERIFLOW_API_KEY (or VERIFLOW_TOKEN). */
  static fromEnv(): Veriflow {
    const apiUrl = process.env.VERIFLOW_API_URL ?? "http://127.0.0.1:8787";
    const token = process.env.VERIFLOW_API_KEY ?? process.env.VERIFLOW_TOKEN;
    return new Veriflow({ apiUrl, token });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new VeriflowError(res.status, data.error ?? res.statusText, data.error ?? `API ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Health ----
  health() {
    return this.request<{ ok: boolean; version: string; store: string }>("GET", "/health");
  }

  // ---- Flows ----
  listFlows() {
    return this.request<{ flows: Flow[] }>("GET", "/v1/flows");
  }
  saveFlow(flow: Partial<Flow> & { name: string; objective: string }) {
    return this.request<{ flow: Flow }>("POST", "/v1/flows", flow);
  }
  listFlowVersions(flowId: string) {
    return this.request<{ versions: Array<{ version: number; changeHash: string; lastGreenRunId?: string; createdAt: string; note?: string }> }>(
      "GET",
      `/v1/flows/${flowId}/versions`,
    );
  }
  rollbackFlow(flowId: string, version: number, note?: string) {
    return this.request<{ flow: Flow }>("POST", `/v1/flows/${flowId}/rollback`, { version, note });
  }
  flakeReport(flowId: string, window = 20) {
    return this.request<FlakeReport>("GET", `/v1/flows/${flowId}/flake?window=${window}`);
  }

  // ---- Runs ----
  createRun(run: RunInput) {
    return this.request<{ id: string }>("POST", "/v1/runs", run);
  }
  getRun(id: string) {
    return this.request<{ run: Run }>("GET", `/v1/runs/${id}`);
  }
  listRuns() {
    return this.request<{ runs: Run[] }>("GET", "/v1/runs");
  }
  trace(id: string) {
    return this.request<Trace>("GET", `/v1/runs/${id}/trace`);
  }
  /** Push a live frame (the harness/agents do this automatically). */
  pushFrame(runId: string, frame: { stepIndex: number; url: string; pngBase64: string }) {
    return this.request<{ ok: boolean }>("POST", `/v1/runs/${runId}/frames`, frame);
  }

  // ---- Webhooks ----
  listWebhooks() {
    return this.request<{ webhooks: Array<{ id: string; url: string; events: string[]; secretHint?: string; lastDeliveryOk?: boolean }> }>(
      "GET",
      "/v1/webhooks",
    );
  }
  createWebhook(url: string, events: string[] = ["*"]) {
    return this.request<{ webhook: { id: string; url: string; secret: string } }>("POST", "/v1/webhooks", { url, events });
  }
  deleteWebhook(id: string) {
    return this.request<{ deleted: boolean }>("DELETE", `/v1/webhooks/${id}`);
  }

  // ---- Audit & retention ----
  audit(limit = 100) {
    return this.request<{ entries: Array<{ id: string; actor: string; action: string; target?: string; createdAt: string }> }>(
      "GET",
      `/v1/audit?limit=${limit}`,
    );
  }
  purgeRetention() {
    return this.request<{ retentionDays: number; runsPurged: number }>("POST", "/v1/retention/purge", {});
  }

  // ---- Cost cap ----
  setCostCap(usd: number | undefined) {
    return this.request<{ user: { costCapUsd?: number } }>("POST", "/v1/settings/cost-cap", { costCapUsd: usd });
  }
}
