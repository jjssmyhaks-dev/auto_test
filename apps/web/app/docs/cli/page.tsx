import { AppPage } from "@/components/app-page";

export const metadata = { title: "CLI quickstart · Veriflow" };

const STEPS: { title: string; body: string; code: string }[] = [
  {
    title: "Install",
    body: "The CLI bundles the harness, agent tester, and MCP server.",
    code: "npm i -g @veriflow/cli",
  },
  {
    title: "Sign in (optional — syncs your progress and runs)",
    body: "Without a token everything still works locally and unlimited.",
    code: "veriflow login --token <your-api-key>",
  },
  {
    title: "Run an objective",
    body: "Plain English in, a verified trace out. The browser stays on your machine.",
    code: 'veriflow run "log in, add an item to the cart, assert the total"',
  },
  {
    title: "Export evidence",
    body: "Share a packed run — screenshots, traces, network, console — or pipe it to your observability stack.",
    code: "veriflow trace <run-id>",
  },
];

export default function CliDocsPage() {
  return (
    <AppPage
      kicker="Docs"
      title="CLI quickstart."
      hint={{
        steps: [
          "The CLI is the engine: runs the browser locally and syncs evidence to the cloud when you ask.",
          "Every dashboard page pairs with a command — see the ? hints on each page.",
        ],
      }}
    >
      <ol className="space-y-6">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <p className="font-mono text-[10px] uppercase text-foreground/60">
              {String(i + 1).padStart(2, "0")} · {s.title}
            </p>
            <p className="mt-1 max-w-2xl text-sm text-foreground/80">{s.body}</p>
            <pre className="mt-2 overflow-x-auto border border-foreground/15 bg-muted p-3 font-mono text-[12px]">
              {s.code}
            </pre>
          </li>
        ))}
      </ol>
    </AppPage>
  );
}
