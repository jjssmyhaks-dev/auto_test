"use client";

import { useState } from "react";
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
