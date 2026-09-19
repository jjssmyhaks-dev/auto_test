import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CloudCredentials } from "@veriflow/schema";
import { loadCredentials } from "@veriflow/vault";
import { readEvents, readSpans, runPaths, veriflowHome } from "@veriflow/store";

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class CloudClient {
  constructor(private readonly creds: CloudCredentials) {}

  static fromEnvOrStore(home = veriflowHome()): CloudClient | undefined {
    const stored = loadCredentials(home);
    const apiUrl = process.env.VERIFLOW_API_URL || stored?.apiUrl || "http://127.0.0.1:8787";
    const apiKey = process.env.VERIFLOW_API_KEY || stored?.apiKey;
    const token = stored?.token;
    if (!token && !apiKey) return undefined;
    return new CloudClient({
      apiUrl,
      token: token ?? "",
      apiKey,
      email: stored?.email,
      projectId: stored?.projectId,
    });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.creds.apiKey) h["x-api-key"] = this.creds.apiKey;
    else if (this.creds.token) h.authorization = `Bearer ${this.creds.token}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.creds.apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new CloudApiError(`API ${method} ${path} failed (${res.status})`, res.status, parsed);
    }
    return parsed as T;
  }

  signup(email: string, password: string) {
    return this.request<{ token: string; user: { id: string; email: string; tier: string } }>(
      "POST",
      "/v1/auth/signup",
      { email, password },
    );
  }

  login(email: string, password: string) {
    return this.request<{ token: string; user: { id: string; email: string; tier: string } }>(
      "POST",
      "/v1/auth/login",
      { email, password },
    );
  }

  getRun(runId: string) {
    return this.request<unknown>("GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }

  getTrace(runId: string) {
    return this.request<unknown>("GET", `/v1/runs/${encodeURIComponent(runId)}/trace`);
  }

  metrics(flowId: string) {
    return this.request<unknown>("GET", `/v1/metrics/${encodeURIComponent(flowId)}`);
  }

  listFlows() {
    return this.request<{ flows: unknown[] }>("GET", "/v1/flows");
  }

  createHumanPause(runId: string, reason: string, prompt?: string, ttlSeconds = 900) {
    return this.request<{
      pause: { id: string; status: string; expiresAt: string };
      magicLink: string;
    }>("POST", "/v1/human-pauses", { runId, reason, prompt, ttlSeconds });
  }

  getHumanPause(id: string) {
    return this.request<{
      pause: { id: string; status: "pending" | "resolved" | "expired"; response?: string; expiresAt: string };
    }>("GET", `/v1/human-pauses/${encodeURIComponent(id)}`);
  }

  /** Polls a human pause until resolved or expired. Spec 1.4 magic-link flow. */
  async awaitHumanPause(
    id: string,
    opts: { pollMs?: number; timeoutMs?: number; onPoll?: (attempt: number) => void } = {},
  ): Promise<{ response?: string; timedOut: boolean }> {
    const pollMs = opts.pollMs ?? 3_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      const { pause } = await this.getHumanPause(id);
      if (pause.status === "resolved") return { response: pause.response, timedOut: false };
      if (pause.status === "expired") return { timedOut: true };
      opts.onPoll?.(attempt);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { timedOut: true };
  }

  async syncRun(runId: string, home = veriflowHome()) {
    const events = readEvents(runId, home);
    const spans = readSpans(runId, home);
    const start = events.find((e) => e.type === "run_start");
    const end = events.find((e) => e.type === "run_end");
    return this.request("POST", "/v1/runs", {
      id: runId,
      projectId: this.creds.projectId,
      objective: String(start?.payload.objective ?? ""),
      envUrl: start?.payload.envUrl,
      status: end?.payload.status ?? "running",
      startedAt: start?.ts ?? new Date().toISOString(),
      endedAt: end?.ts,
      stepCount: Number(end?.payload.steps ?? 0),
      costUsd: typeof end?.payload.costUsd === "number" ? end.payload.costUsd : undefined,
      error: end?.payload.error,
      events,
      spans,
      files: collectRunFiles(runId, home),
    });
  }
}

function collectRunFiles(runId: string, home: string): { path: string; contentBase64: string }[] {
  const rp = runPaths(runId, home);
  const out: { path: string; contentBase64: string }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.size <= 4_000_000 && !name.endsWith("evidence.testevidence")) {
        out.push({
          path: relative(rp.dir, abs).replaceAll("\\", "/"),
          contentBase64: readFileSync(abs).toString("base64"),
        });
      }
    }
  };
  walk(rp.dir);
  return out;
}

export async function syncRunIfConfigured(runId: string, home = veriflowHome()) {
  const client = CloudClient.fromEnvOrStore(home);
  if (!client) return { synced: false as const, detail: "no credentials (login or VERIFLOW_API_KEY)" };
  try {
    await client.syncRun(runId, home);
    return { synced: true as const, detail: runId };
  } catch (err) {
    return { synced: false as const, detail: err instanceof Error ? err.message : String(err) };
  }
}
