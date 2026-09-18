import { describe, expect, it } from "vitest";
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
