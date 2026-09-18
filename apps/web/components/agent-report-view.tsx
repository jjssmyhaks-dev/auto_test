"use client";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Test,
  TestResults,
  TestResultsContent,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
  TestSuite,
  TestSuiteContent,
  TestSuiteName,
} from "@/components/ai-elements/test-results";
import { spanStepStatus, userPromptForTurn, type AgentTestReportView } from "@/lib/ai-trace";

export function AgentReportView({ report }: { report: AgentTestReportView }) {
  const passed = report.turns.filter((t) => t.pass).length;
  const failed = report.turns.length - passed;

  return (
    <div className="elements-block space-y-6">
      <TestResults
        summary={{
          passed,
          failed,
          skipped: 0,
          total: report.turns.length,
          duration: report.metrics.latencyMs,
        }}
      >
        <TestResultsHeader>
          <TestResultsSummary />
        </TestResultsHeader>
        <TestResultsProgress />
        <TestResultsContent>
          <TestSuite defaultOpen name={`Verdict ${report.verdict}`} status={failed ? "failed" : "passed"}>
            <TestSuiteName />
            <TestSuiteContent>
              {report.turns.map((t, i) => (
                <Test
                  key={`${t.scenarioId}-${t.turn}-${i}`}
                  name={`${t.scenarioId} · turn ${t.turn}`}
                  status={t.pass ? "passed" : "failed"}
                  duration={t.latencyMs}
                />
              ))}
            </TestSuiteContent>
          </TestSuite>
        </TestResultsContent>
      </TestResults>

      <Conversation className="h-[28rem] rounded-xl border bg-card">
        <ConversationContent>
          {report.turns.length === 0 ? (
            <ConversationEmptyState
              title="No eval turns"
              description="Paste JSON from `veriflow agent-test --endpoint …`."
            />
          ) : (
            report.turns.flatMap((t, i) => [
              <Message from="user" key={`u-${i}`}>
                <MessageContent>
                  <MessageResponse>{userPromptForTurn(t)}</MessageResponse>
                </MessageContent>
              </Message>,
              <Message from="assistant" key={`a-${i}`}>
                <MessageContent>
                  <Reasoning defaultOpen={false} isStreaming={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      {`Scenario ${t.scenarioId}. Hallucination ${t.hallucination}, task ${t.taskCompletion}, context ${t.contextRetention}, tone ${t.toneCompliance}.`}
                    </ReasoningContent>
                  </Reasoning>
                  <MessageResponse>{t.reply}</MessageResponse>
                </MessageContent>
              </Message>,
            ])
          )}
        </ConversationContent>
      </Conversation>

      {report.spans?.length ? (
        <ChainOfThought defaultOpen={false}>
          <ChainOfThoughtHeader>Eval spans (OBSERVE → VERIFY)</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {report.spans.map((s, i) => (
              <ChainOfThoughtStep
                key={`${s.kind}-${i}`}
                label={s.kind}
                description={s.error ?? (s.attributes?.scenario ? String(s.attributes.scenario) : undefined)}
                status={spanStepStatus(s)}
              />
            ))}
          </ChainOfThoughtContent>
        </ChainOfThought>
      ) : null}
    </div>
  );
}
