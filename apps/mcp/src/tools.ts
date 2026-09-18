import { runHarness, CloudClient, exportPlaywrightTest, actionsFromEvents } from "@veriflow/harness";
import { getFlow, listFlows, listRunIds, readEvents, readSpans, veriflowHome } from "@veriflow/store";
import type { Action, RunEvent } from "@veriflow/schema";

export const TOOLS = [
  {
    name: "run_flow",
    description: "Run a Veriflow flow via the local harness",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        envUrl: { type: "string" },
        flowId: { type: "string" },
        headless: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["objective"],
    },
  },
  {
    name: "get_run",
    description: "Fetch a run by id from local store or API",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
  {
    name: "export_playwright",
    description: "Export a run as a Playwright test",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
  {
    name: "list_flows",
    description: "List saved local flows",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_runs",
    description: "List local run ids under VERIFLOW_HOME",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_trace",
    description: "Get a run trace (events + spans)",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; tool: string; data?: unknown; error?: string; progress?: string }> {
  const apiKey = process.env.VERIFLOW_API_KEY;
  try {
    switch (name) {
      case "list_runs": {
        return { ok: true, tool: name, data: { home: veriflowHome(), runIds: listRunIds() } };
      }
      case "list_flows": {
        const local = listFlows();
        const client = CloudClient.fromEnvOrStore();
        let cloud: unknown;
        if (client) {
          try {
            cloud = await client.listFlows();
          } catch {
            cloud = undefined;
          }
        }
        return { ok: true, tool: name, data: { home: veriflowHome(), flows: local, cloud } };
      }
      case "run_flow": {
        const flowId = typeof args.flowId === "string" ? args.flowId : undefined;
        const flow = flowId ? getFlow(flowId) : undefined;
        const objective = String(args.objective ?? flow?.objective ?? "");
        if (!objective) return { ok: false, tool: name, error: "objective required" };
        const result = await runHarness({
          objective,
          envUrl: (args.envUrl as string | undefined) ?? flow?.envUrl,
          headless: args.headless !== false,
          dryRun: Boolean(args.dryRun),
          agent: true,
        });
        return { ok: result.status === "passed", tool: name, progress: "harness_complete", data: result };
      }
      case "get_run": {
        const runId = String(args.runId ?? "");
        try {
          const events = readEvents(runId);
          const spans = readSpans(runId);
          return { ok: true, tool: name, data: { source: "local", runId, events, spans } };
        } catch (localErr) {
          const client = CloudClient.fromEnvOrStore();
          if (!client && !apiKey) {
            return { ok: false, tool: name, error: localErr instanceof Error ? localErr.message : String(localErr) };
          }
          const data = await (client ?? new CloudClient({
            apiUrl: process.env.VERIFLOW_API_URL ?? "http://127.0.0.1:8787",
            token: "",
            apiKey,
          })).getRun(runId);
          return { ok: true, tool: name, data: { source: "api", data } };
        }
      }
      case "get_trace": {
        const runId = String(args.runId ?? "");
        try {
          const events = readEvents(runId);
          const spans = readSpans(runId);
          return { ok: true, tool: name, data: { source: "local", runId, events, spans } };
        } catch (localErr) {
          const client = CloudClient.fromEnvOrStore();
          if (!client && !apiKey) {
            return { ok: false, tool: name, error: localErr instanceof Error ? localErr.message : String(localErr) };
          }
          const data = await (client ??
            new CloudClient({
              apiUrl: process.env.VERIFLOW_API_URL ?? "http://127.0.0.1:8787",
              token: "",
              apiKey,
            })).getTrace(runId);
          return { ok: true, tool: name, data: { source: "api", data } };
        }
      }
      case "export_playwright": {
        const runId = String(args.runId ?? "");
        let events: RunEvent[] = [];
        try {
          events = readEvents(runId);
        } catch {
          const client = CloudClient.fromEnvOrStore();
          if (client || apiKey) {
            const remote = (await (client ??
              new CloudClient({
                apiUrl: process.env.VERIFLOW_API_URL ?? "http://127.0.0.1:8787",
                token: "",
                apiKey,
              })).getRun(runId)) as { run?: { objective?: string; envUrl?: string }; steps?: { action: Action }[] };
            const actions = (remote.steps ?? []).map((s) => s.action).filter(Boolean);
            const source = exportPlaywrightTest({
              name: runId,
              objective: String(remote.run?.objective ?? runId),
              envUrl: remote.run?.envUrl,
              actions,
            });
            return { ok: true, tool: name, data: { source, origin: "api" } };
          }
          throw new Error(`No event log for run ${runId}`);
        }
        const start = events.find((e) => e.type === "run_start");
        const source = exportPlaywrightTest({
          name: runId,
          objective: String(start?.payload.objective ?? runId),
          envUrl: start?.payload.envUrl as string | undefined,
          actions: actionsFromEvents(events),
        });
        return { ok: true, tool: name, data: { source } };
      }
      default:
        return { ok: false, tool: name, error: `unknown tool ${name}` };
    }
  } catch (err) {
    return { ok: false, tool: name, error: err instanceof Error ? err.message : String(err) };
  }
}
