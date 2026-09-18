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
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  actionTypeOf,
  decideReasoning,
  spanStepStatus,
  toolStateForStatus,
  type TraceSpan,
  type TraceStep,
} from "@/lib/ai-trace";
import type { ToolUIPart } from "ai";

export function RunTraceView({
  objective,
  steps,
  spans,
}: {
  objective: string;
  steps: TraceStep[];
  spans: TraceSpan[];
}) {
  const decide = spans.find((s) => s.kind === "DECIDE");
  const reasoning = decide ? decideReasoning(decide) : null;

  return (
    <div className="elements-block space-y-6">
      <Conversation className="h-[22rem] rounded-xl border bg-card">
        <ConversationContent>
          {objective ? (
            <>
              <Message from="user">
                <MessageContent>
                  <MessageResponse>{objective}</MessageResponse>
                </MessageContent>
              </Message>
              {reasoning ? (
                <Message from="assistant">
                  <MessageContent>
                    <Reasoning defaultOpen={false} isStreaming={false}>
                      <ReasoningTrigger />
                      <ReasoningContent>{reasoning}</ReasoningContent>
                    </Reasoning>
                    <MessageResponse>
                      {steps.length
                        ? `Planned ${steps.length} harness action${steps.length === 1 ? "" : "s"} (${steps.map((s) => actionTypeOf(s.action)).join(", ")}).`
                        : "No harness actions were recorded for this run."}
                    </MessageResponse>
                  </MessageContent>
                </Message>
              ) : (
                <ConversationEmptyState
                  title="No model reasoning on this run"
                  description="DECIDE spans will show here when the agent records action choice."
                />
              )}
            </>
          ) : (
            <ConversationEmptyState title="No objective" description="This run did not store an objective prompt." />
          )}
        </ConversationContent>
      </Conversation>

      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Trace timeline</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {spans.length === 0 ? (
            <p className="empty">No spans uploaded with this run.</p>
          ) : (
            spans.map((s, i) => (
              <ChainOfThoughtStep
                key={`${s.kind}-${i}`}
                label={`${s.kind}${s.ok === false ? " · fail" : s.ok === true ? " · ok" : ""}`}
                description={[
                  s.attributes?.actionType ? `action ${String(s.attributes.actionType)}` : null,
                  s.error,
                  s.startedAt,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                status={spanStepStatus(s)}
              />
            ))
          )}
        </ChainOfThoughtContent>
      </ChainOfThought>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Steps / actions</h2>
        {steps.length === 0 ? (
          <p className="empty">No step events on this run.</p>
        ) : (
          steps.map((st) => {
            const type = actionTypeOf(st.action);
            const state = toolStateForStatus(st.status);
            return (
              <Tool key={st.index} defaultOpen={st.status === "failed"}>
                <ToolHeader
                  title={`${type} · step ${st.index}`}
                  type={`tool-${type}` as ToolUIPart["type"]}
                  state={state}
                />
                <ToolContent>
                  <ToolInput input={st.action} />
                  <ToolOutput
                    output={{ status: st.status }}
                    errorText={st.status === "failed" ? "Harness action failed" : undefined}
                  />
                </ToolContent>
              </Tool>
            );
          })
        )}
      </div>
    </div>
  );
}
