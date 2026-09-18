import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHarness } from "@veriflow/harness";
import { readEvents, runPaths } from "@veriflow/store";
import { startTestSite } from "./test-site.js";
import { refFor, scriptedProvider, type ScriptStep } from "./scripted-llm.js";

const site = await startTestSite();

afterAll(async () => {
  await site.close();
});

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "vf-golden-"));
}

/** Canonical flow 1: login → dashboard heading assert. */
function loginFlow(): ScriptStep[] {
  return [
    (input) => ({ type: "fill", target: { ref: refFor(input, "Email") }, value: "demo@acme.test" }),
    (input) => ({ type: "fill", target: { ref: refFor(input, "Password") }, value: "hunter2", secret: true }),
    (input) => ({ type: "click", target: { ref: refFor(input, "Sign in") } }),
    (input) => ({ type: "assert", check: "heading_contains", value: "Dashboard" }),
    { type: "finish", success: true, reason: "logged in and asserted dashboard" },
  ] as ScriptStep[];
}

/** Canonical flow 2: add a cart item and assert the total updates. */
function cartFlow(): ScriptStep[] {
  return [
    (input) => ({ type: "fill", target: { ref: refFor(input, "Email") }, value: "demo@acme.test" }),
    (input) => ({ type: "fill", target: { ref: refFor(input, "Password") }, value: "hunter2", secret: true }),
    (input) => ({ type: "click", target: { ref: refFor(input, "Sign in") } }),
    (input) => ({ type: "click", target: { ref: refFor(input, "Open cart") } }),
    (input) => ({ type: "fill", target: { ref: refFor(input, "Item name") }, value: "Widget" }),
    (input) => ({ type: "click", target: { ref: refFor(input, "Add item") } }),
    (input) => ({ type: "assert", check: "text_contains", value: "Total: $9.99" }),
    { type: "finish", success: true, reason: "cart total asserted" },
  ] as ScriptStep[];
}

describe("golden flows (local, no network, no LLM)", () => {
  it("logs in and asserts the dashboard heading", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in with demo@acme.test and assert the dashboard heading",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider(loginFlow()),
      record: true,
    });
    expect(result.status).toBe("passed");
    expect(result.evidencePath ? existsSync(result.evidencePath) : false).toBe(true);
    expect(result.reportPath ? existsSync(result.reportPath) : false).toBe(true);
    const events = readEvents(result.runId, home);
    const guards = events.filter((e) => e.type === "guard");
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((e) => (e.payload as { ok?: boolean }).ok !== false)).toBe(true);
  }, 60_000);

  it("adds a cart item and asserts the total (multi-step, self-consistent)", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "add Widget to the cart and assert the total",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider(cartFlow()),
      record: true,
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const acts = events.filter((e) => e.type === "act" && (e.payload as { ok?: boolean }).ok === true);
    expect(acts.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("fills marked secrets but keeps them out of stored events", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in and assert dashboard",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider(loginFlow()),
      record: true,
    });
    expect(result.status).toBe("passed");
    const raw = JSON.stringify(readEvents(result.runId, home));
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("[REDACTED]");
  }, 60_000);

  it("writes screenshots per step into the run dir", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider(loginFlow()),
      record: true,
    });
    const rp = runPaths(result.runId, home);
    expect(existsSync(join(rp.screenshots, "step-0.png"))).toBe(true);
  }, 60_000);
});
