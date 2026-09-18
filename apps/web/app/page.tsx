import Link from "next/link";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { ApiHealth } from "@/components/api-health";
import { PixelField } from "@/components/pixel-field";
import { VeriflowMark } from "@/components/veriflow-mark";

const products = [
  ["Vision CLI", "Natural-language objectives drive Chromium with a vision LLM and constrained actions — locally, without an account.", "feat-cli", "/runs"],
  ["Evidence packs", "Screenshots, traces, network, and console land in a redacted pack you can inspect or sync.", "feat-evidence", "/evidence"],
  ["MCP", "Expose runs and evidence to agents through the Veriflow MCP server and project API keys.", "feat-mcp", "/projects"],
  ["Agent testing", "Score chat agents with transcripts, pass rate, and the same dashboard conversation UI.", "feat-agent", "/agent-test"],
  ["Guardrails", "Secrets stay redacted. Cost and success-rate alerts fire when cloud runs drift.", "feat-guard", "/alerts"],
  ["Cloud sync", "Push evidence when you choose. Free, Starter, and Team quotas apply only to ingest.", "feat-sync", "/usage"],
] as const;

const steps = [
  ["01", "Write", "State the objective in English. The CLI, not the dashboard, still owns Chromium."],
  ["02", "Run", "A vision model proposes the next constrained action. Playwright executes it locally."],
  ["03", "Pack", "Every step writes screenshots, spans, and a redacted evidence pack you can replay."],
  ["04", "Sync", "Login and --sync when you want cloud history, quotas, and agent-test transcripts."],
];

const plans = [
  ["Free", "50", "Local CLI unlimited. Cloud ingest for trying sync, traces, and the dashboard."],
  ["Starter", "500", "Enough cloud runs for a product squad shipping weekly vision checks."],
  ["Team", "5,000", "Shared projects, API keys, alerts, and headroom for agent-eval traffic."],
] as const;

const levels = [
  ["L1", "Scripts.", "Selectors hand-written by hand. Pass locally, break the moment the page shifts."],
  ["L3", "Flows.", "An objective runs the same good way every time, with a human reading the evidence pack."],
  ["L5", "Agents.", "Whole suites run end to end, while people stay on the runs that actually need judgment."],
] as const;

const experiments = [
  ["Queue a run", "Natural-language objective in, constrained Playwright actions out — with vision in the loop.", "CLI · vision loop", "exp-runs", "/runs"],
  ["Inspect a pack", "Screenshots, spans, network, and console, redacted before anything leaves the machine.", "CLI · evidence packs", "exp-evidence", "/evidence"],
  ["Score an agent", "Transcripts, pass rate, and verdicts for chat agents, in the same conversation UI.", "CLI · scenario bank", "exp-agent", "/agent-test"],
  ["Hand out tools", "run_flow, get_run, export_playwright — the MCP surface agents need to do real work.", "MCP · project keys", "exp-mcp", "/projects"],
] as const;

function EditorialSection({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <section className="grid border-b border-foreground/25 lg:grid-cols-2">
      <div className="border-b border-foreground/25 p-5 lg:border-b-0 lg:border-r lg:p-10">
        <p className="font-mono text-xs uppercase">{label}</p>
      </div>
      <div className="p-5 lg:p-10">
        <h2 className="max-w-2xl text-4xl leading-[0.98] md:text-6xl">{title}</h2>
        <div className="mt-20 max-w-xl space-y-6 text-lg leading-snug">{children}</div>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="bg-background text-foreground">
      <header className="grid min-h-[148px] border-b border-foreground/25 lg:grid-cols-[58%_42%]">
        <div className="flex items-end border-b border-foreground/25 px-5 py-6 lg:border-b-0 lg:border-r lg:px-[19.4vw] lg:py-5">
          <h1 className="text-[clamp(3rem,5.2vw,5.4rem)] font-normal uppercase leading-[.82]">
            Vision,
            <br />
            verified.
          </h1>
        </div>
        <div className="grid grid-cols-2 gap-6 p-5 lg:p-7">
          <div className="text-sm uppercase leading-tight">
            Local-first
            <br />
            tests for
          </div>
          <div className="text-sm uppercase leading-tight">
            Agents,
            <br />
            browsers,
            <br />
            evidence
          </div>
          <div className="self-end">
            <VeriflowMark />
          </div>
          <div className="self-end space-y-2">
            <p className="text-[10px] leading-tight">
              Vision CLI, evidence packs, MCP, and agent testing —
              <br />
              craft in the loop, not a black box.
            </p>
            <ApiHealth />
          </div>
        </div>
      </header>

      <div className="h-[60vh] min-h-[450px] border-b border-foreground/25">
        <PixelField />
      </div>

      <section id="product" className="grid min-h-[360px] border-b border-foreground/25 lg:grid-cols-[19.4%_1fr]">
        <div className="hidden border-r border-foreground/25 lg:block" />
        <p className="self-center p-5 text-3xl leading-[1.05] md:p-10 md:text-5xl lg:max-w-5xl">
          Veriflow runs vision browser tests on your machine, writes an evidence pack you can audit, and only talks to
          the cloud when you sync. The parts that matter — judgment, redaction, replay — stay in the loop.
        </p>
      </section>

      <section className="grid border-b border-foreground/25 md:grid-cols-2 xl:grid-cols-3">
        {products.map((product) => (
          <Link
            key={product[0]}
            href={product[3]}
            className="group block border-r border-b border-foreground/25 last:border-r-0 no-underline"
          >
            <div className={`relative aspect-[4/3] overflow-hidden bg-muted ${product[2]}`}>
              <div className="absolute inset-0 transition-transform duration-700 group-hover:scale-105" />
              <span className="absolute left-5 top-5 border border-foreground/40 bg-background/80 px-2 py-1 font-mono text-[10px] uppercase">
                Open in dashboard
              </span>
            </div>
            <div className="grid min-h-36 grid-cols-[1fr_auto] gap-5 p-5">
              <div>
                <h3 className="text-2xl font-medium">{product[0]}</h3>
                <p className="mt-3 max-w-md text-sm leading-snug text-foreground/65">{product[1]}</p>
              </div>
              <ArrowUpRight className="h-5 w-5 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" />
            </div>
          </Link>
        ))}
      </section>

      <EditorialSection label="Where we start" title="Local-first, because the browser is yours.">
        <p>
          The CLI drives Playwright with a vision model, enforces guardrails, and writes evidence next to the run. No
          account is required to pass or fail a heading on example.com.
        </p>
        <p>
          Cloud is optional ingest: queue an objective, sync packs, mint API keys, and review agent-test transcripts
          when a team needs a shared record.
        </p>
        <p>One standard from CLI to dashboard: constrained actions, redacted secrets, replayable traces.</p>
      </EditorialSection>

      <EditorialSection label="What changed" title="Agents can click. They still cannot prove it.">
        <p>
          Volume stopped being the hard part. A model can wander a page; the last 10 percent is evidence you would
          show a reviewer.
        </p>
        <p>
          Veriflow is that last 10 percent: a vision loop with a paper trail, MCP for agents that need tools, and
          evals for the agents themselves.
        </p>
        <div className="grid grid-cols-2 border-t border-foreground/25 pt-6 text-sm">
          <div>
            <strong className="block font-mono text-xs uppercase">Brilliant at</strong>
            <p className="mt-4">Driving a browser and dumping a lot of screenshots.</p>
          </div>
          <div>
            <strong className="block font-mono text-xs uppercase">Hopeless at</strong>
            <p className="mt-4">Knowing which run is actually any good — unless you pack the evidence.</p>
          </div>
        </div>
      </EditorialSection>

      <section id="loop" className="border-b border-foreground/25 bg-primary text-primary-foreground">
        <div className="overflow-hidden border-b border-primary-foreground/30 py-6">
          <div className="animate-marquee flex w-max whitespace-nowrap text-6xl uppercase md:text-8xl">
            <span>Write. Run. Pack. Sync.&nbsp;</span>
            <span>Write. Run. Pack. Sync.&nbsp;</span>
          </div>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-4">
          {steps.map((step) => (
            <div key={step[0]} className="min-h-72 border-r border-b border-primary-foreground/30 p-6 xl:border-b-0">
              <span className="font-mono text-xs">{step[0]}</span>
              <h3 className="mt-16 text-4xl">{step[1]}</h3>
              <p className="mt-5 text-sm leading-snug opacity-75">{step[2]}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid border-b border-foreground/25 lg:grid-cols-2">
        <div className="flex min-h-[620px] flex-col justify-between border-b border-foreground/25 bg-secondary p-6 lg:border-b-0 lg:border-r lg:p-10">
          <p className="font-mono text-xs uppercase">The evidence protocol</p>
          <div>
            <h2 className="text-6xl leading-[.88] md:text-8xl">
              Pack.
              <br />
              Redact.
              <br />
              Replay.
            </h2>
            <Link href="/evidence" className="mt-10 inline-flex items-center gap-2 border-b border-foreground pb-1 text-sm no-underline">
              Open evidence <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="grid grid-rows-4">
          {[
            ["01", "Objective", "A natural-language goal the harness must satisfy, not a brittle selector script."],
            ["02", "Actions", "Constrained browser steps with vision in the loop and guardrails on the output."],
            ["03", "Pack", "Screenshots, spans, network, console — redacted before they leave the machine."],
            ["04", "Replay", "Dashboard traces and agent-test transcripts so a human can still say yes."],
          ].map((item) => (
            <div key={item[0]} className="grid grid-cols-[3rem_1fr] border-b border-foreground/25 p-6 last:border-b-0">
              <span className="font-mono text-xs">{item[0]}</span>
              <div>
                <h3 className="text-2xl">{item[1]}</h3>
                <p className="mt-3 max-w-md text-sm text-foreground/65">{item[2]}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <EditorialSection label="Where we go next" title="Move your team up the levels of agentic testing.">
        <p>
          Veriflow is a testing platform built with the loop it tests, and most of what we learned shipping it is
          teachable. So we pass it on: guardrails, evidence discipline, and the replay habit that makes agents stick.
        </p>
        <div className="border-t border-foreground/25">
          {levels.map((level) => (
            <div key={level[0]} className="grid grid-cols-[3rem_1fr] border-b border-foreground/25 py-4 text-sm">
              <span className="font-mono text-xs">{level[0]}</span>
              <p>
                <strong>{level[1]}</strong> {level[2]}
              </p>
            </div>
          ))}
        </div>
      </EditorialSection>

      <section className="border-b border-foreground/25 p-5 md:p-10">
        <h2 className="max-w-4xl text-5xl leading-[.95] md:text-7xl">The browser is automated. The evidence isn&apos;t.</h2>
      </section>

      <section className="grid border-b border-foreground/25 md:grid-cols-2">
        {experiments.map((item) => (
          <Link key={item[0]} href={item[4]} className="group border-r border-b border-foreground/25 no-underline">
            <div className={`relative aspect-[16/10] overflow-hidden ${item[3]}`}>
              <span className="absolute left-5 top-5 border border-foreground/40 bg-background/80 px-2 py-1 font-mono text-[10px] uppercase">
                Open in dashboard
              </span>
            </div>
            <div className="grid min-h-44 grid-cols-[1fr_auto] p-5">
              <div>
                <h3 className="text-3xl">{item[0]}</h3>
                <p className="mt-3 max-w-md text-sm text-foreground/65">{item[1]}</p>
                <p className="mt-6 font-mono text-[10px] uppercase">{item[2]}</p>
              </div>
              <ArrowUpRight className="h-5 w-5 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" />
            </div>
          </Link>
        ))}
      </section>

      <section id="pricing" className="border-b border-foreground/25">
        <div className="grid border-b border-foreground/25 lg:grid-cols-[19.4%_1fr]">
          <div className="border-b border-foreground/25 p-5 lg:border-b-0 lg:border-r lg:p-10">
            <p className="font-mono text-xs uppercase">Pricing</p>
          </div>
          <div className="p-5 lg:p-10">
            <h2 className="max-w-3xl text-4xl leading-[0.95] md:text-6xl">Cloud quotas. Local runs stay free.</h2>
          </div>
        </div>
        <div className="grid md:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan[0]} className="flex min-h-80 flex-col justify-between border-r border-foreground/25 p-6 last:border-r-0">
              <div>
                <p className="font-mono text-xs uppercase">{plan[0]}</p>
                <p className="mt-10 text-6xl leading-none">{plan[1]}</p>
                <p className="mt-2 font-mono text-[10px] uppercase">cloud runs / month</p>
                <p className="mt-6 max-w-xs text-sm text-foreground/65">{plan[2]}</p>
              </div>
              <Link href="/login" className="mt-10 inline-flex items-center gap-2 text-sm no-underline">
                Start on {plan[0]} <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          ))}
        </div>
      </section>

      <footer className="bg-foreground text-background">
        <Link
          href="/login"
          className="group flex items-center justify-between border-b border-background/25 px-5 py-10 text-[clamp(3.5rem,10vw,10rem)] leading-none no-underline"
        >
          <span>Open the dashboard</span>
          <ArrowDownRight className="h-[.75em] w-[.75em] transition-transform group-hover:translate-x-2 group-hover:translate-y-2" />
        </Link>
        <div className="grid lg:grid-cols-2">
          <div className="border-b border-background/25 p-6 text-2xl leading-tight lg:border-b-0 lg:border-r lg:p-10">
            Sign in, queue an objective, inspect evidence, review agent-test transcripts, and track Free / Starter /
            Team quota.
          </div>
          <div className="flex flex-col justify-between gap-24 p-6 lg:p-10">
            <p className="text-sm text-background/60">
              Start the API on :8787, then this app on :3000. The harness still runs on the CLI.
            </p>
            <p className="font-mono text-xs uppercase">
              <Link href="/runs" className="underline">
                Runs
              </Link>
              {" · "}
              <Link href="/evidence" className="underline">
                Evidence
              </Link>
              {" · "}
              <Link href="/agent-test" className="underline">
                Agent tests
              </Link>
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
