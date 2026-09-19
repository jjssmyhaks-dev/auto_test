import { AppPage } from "@/components/app-page";

export const metadata = { title: "MCP setup · Veriflow" };

const TOOLS: [string, string][] = [
  ["run_flow", "Execute a saved flow end-to-end and return the verdict"],
  ["get_run", "Fetch a run's status, steps, and cost"],
  ["get_trace", "Full step-by-step trace with spans and assertions"],
  ["export_playwright", "Turn a flow into a portable Playwright spec"],
  ["list_flows", "Enumerate saved flows for the agent to pick from"],
  ["list_runs", "Recent runs, filterable by status"],
];

const CONFIGS: { label: string; code: string }[] = [
  {
    label: "Claude Code / Cursor (stdio)",
    code: JSON.stringify(
      {
        mcpServers: {
          veriflow: {
            command: "npx",
            args: ["@veriflow/mcp", "--stdio"],
            env: { VERIFLOW_TOKEN: "<your-api-key>" },
          },
        },
      },
      null,
      2,
    ),
  },
  {
    label: "HTTP endpoint (remote agents)",
    code: "npx @veriflow/mcp --http --port 8931",
  },
];

export default function McpDocsPage() {
  return (
    <AppPage
      kicker="Docs"
      title="MCP setup."
      hint={{
        steps: [
          "MCP exposes the same engine to coding agents — no new SDK to learn.",
          "Agents can verify their own work mid-session: run a flow, read the trace, fix, re-run.",
        ],
      }}
    >
      <p className="max-w-2xl text-sm text-foreground/80">
        The Model Context Protocol server lets Claude Code, Cursor, or any MCP client drive Veriflow
        directly from the chat. Point it at your token and the agent gains six tools:
      </p>
      <table className="mt-4">
        <thead>
          <tr>
            <th>Tool</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {TOOLS.map(([name, desc]) => (
            <tr key={name}>
              <td className="font-mono text-[11px]">{name}</td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {CONFIGS.map((cfg) => (
        <div key={cfg.label} className="mt-6">
          <p className="font-mono text-[10px] uppercase text-foreground/60">{cfg.label}</p>
          <pre className="mt-2 overflow-x-auto border border-foreground/15 bg-muted p-3 font-mono text-[12px]">
            {cfg.code}
          </pre>
        </div>
      ))}
    </AppPage>
  );
}
