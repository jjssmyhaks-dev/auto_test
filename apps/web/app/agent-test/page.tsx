"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { AgentReportView } from "@/components/agent-report-view";
import { parseAgentReport, SAMPLE_AGENT_REPORT, type AgentTestReportView } from "@/lib/ai-trace";
import { AppPage } from "@/components/app-page";

export default function AgentTestPage() {
  const [report, setReport] = useState<AgentTestReportView>(SAMPLE_AGENT_REPORT);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [scenarios, setScenarios] = useState("12");
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function runEval() {
    if (!endpoint.trim()) {
      setNote("endpoint required (POST { messages })");
      return;
    }
    setRunning(true);
    setNote(null);
    try {
      const res = await api<{ report: AgentTestReportView }>("/v1/agent-tests", {
        method: "POST",
        body: JSON.stringify({ endpoint: endpoint.trim(), scenarios: Number(scenarios) || 12 }),
      });
      setReport(res.report);
      setNote(`run ${res.report.runId} — verdict ${res.report.verdict}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function load(message: PromptInputMessage) {
    const text = message.text.trim();
    if (!text || text.toLowerCase() === "sample") {
      setReport(SAMPLE_AGENT_REPORT);
      setError(null);
      setDraft("");
      return;
    }
    try {
      setReport(parseAgentReport(text));
      setError(null);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid report JSON");
    }
  }

  return (
    <AppPage kicker="Agent tests" title="Score a transcript.">
      <p className="empty">
        Paste JSON from <code>veriflow agent-test --endpoint …</code>, or submit <code>sample</code> to preview the
        conversation UI without a live model.
      </p>
      <div className="grid gap-2 md:grid-cols-[1fr_8rem_auto] md:items-end">
        <label>
          Chat endpoint
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://127.0.0.1:8788/chat"
          />
        </label>
        <label>
          Scenarios
          <input
            value={scenarios}
            onChange={(e) => setScenarios(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <button type="button" onClick={runEval} disabled={running}>
          {running ? "Running…" : "Run agent test"}
        </button>
      </div>
      {note ? <p className="empty">{note}</p> : null}
      <PromptInput className="mt-4" onSubmit={load}>
        <PromptInputTextarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="Paste agent-test JSON or type sample"
        />
        <PromptInputFooter>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
      {error ? <p className="error">{error}</p> : null}
      <p className="empty">
        Endpoint {report.endpoint} · pass rate {(report.metrics.passRate * 100).toFixed(0)}% · {report.runId}
      </p>
      <AgentReportView report={report} />
    </AppPage>
  );
}
