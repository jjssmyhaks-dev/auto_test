import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRecipe } from "./recipe.js";
import { readEvents } from "@veriflow/store";

let server: ReturnType<typeof createServer>;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1 id="title">Recipe page</h1><button id="go" onclick="document.getElementById('title').textContent='clicked'">go</button></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

describe("runRecipe (deterministic, no LLM)", () => {
  it("executes open → click → assert against a live page and passes", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-recipe-"));
    const res = await runRecipe({
      actions: [
        { type: "navigate", url: base },
        { type: "click", target: { selector: "#go" } },
        { type: "assert", check: "text_contains", target: { selector: "#title" }, value: "clicked" },
        { type: "finish", success: true, reason: "recipe ok" },
      ] as never[],
      home,
    });
    expect(res.status).toBe("passed");
    expect(res.failed).toBe(0);
    expect(res.passed).toBeGreaterThanOrEqual(2);
    // Same event log shape as the agent harness, so cloud sync just works.
    const events = readEvents(res.runId, home);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types).toContain("decide");
    expect(types.at(-1)).toBe("run_end");
    expect(events.at(-1)?.payload.mode).toBe("recipe");
  });

  it("fails honestly when an assertion cannot pass", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-recipe-fail-"));
    const res = await runRecipe({
      actions: [
        { type: "navigate", url: base },
        { type: "assert", check: "text_contains", target: { selector: "#title" }, value: "this text does not exist" },
      ] as never[],
      home,
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("assert failed");
    const events = readEvents(res.runId, home);
    const verify = events.find((e) => e.type === "verify");
    expect(verify?.payload.ok).toBe(false);
  });

  it("skips request_human steps instead of hanging", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-recipe-human-"));
    const res = await runRecipe({
      actions: [
        { type: "navigate", url: base },
        { type: "request_human", reason: "enter the OTP" },
        { type: "finish", success: true, reason: "done" },
      ] as never[],
      home,
    });
    expect(res.status).toBe("passed");
    expect(res.skipped).toBe(1);
  });
});
