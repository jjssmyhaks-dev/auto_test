import { describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import { saveFlow } from "@veriflow/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MCP tools", () => {
  it("lists flows from the local store", async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-mcp-"));
    process.env.VERIFLOW_HOME = home;
    saveFlow({ id: "flow_a", name: "A", objective: "assert heading", envUrl: "https://example.com" }, home);
    const res = await callTool("list_flows", {});
    expect(res.ok).toBe(true);
    const flows = (res.data as { flows: { id: string }[] }).flows;
    expect(flows.some((f) => f.id === "flow_a")).toBe(true);
  });

  it("lists local run directories", async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-mcp-runs-"));
    process.env.VERIFLOW_HOME = home;
    const res = await callTool("list_runs", {});
    expect(res.ok).toBe(true);
    expect((res.data as { runIds: string[] }).runIds).toEqual([]);
  });

  it("returns structured errors for unknown tools", async () => {
    const res = await callTool("not_a_tool", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown/);
  });

  it("fails get_trace without a local run or API key", async () => {
    const home = mkdtempSync(join(tmpdir(), "vf-mcp-miss-"));
    process.env.VERIFLOW_HOME = home;
    delete process.env.VERIFLOW_API_KEY;
    const res = await callTool("get_trace", { runId: "run_missing" });
    expect(res.ok).toBe(false);
  });
});
