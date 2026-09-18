import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, RunEventType, Span, SpanKind } from "@veriflow/schema";
import { appendEvent } from "@veriflow/store";

export interface NdjsonSink {
  write(event: Record<string, unknown>): void;
}

export class StdoutNdjsonSink implements NdjsonSink {
  write(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

export class NullSink implements NdjsonSink {
  write(_event: Record<string, unknown>): void {}
}

/** In-process OTel-shaped span. OTLP export is out of scope for M1. */
export class SpanRecorder {
  readonly spans: Span[] = [];

  start(input: {
    runId: string;
    kind: SpanKind;
    stepId?: string;
    attributes?: Record<string, unknown>;
  }): { span: Span; end: (ok?: boolean, error?: string, extra?: Record<string, unknown>) => Span } {
    const span: Span = {
      id: randomUUID(),
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      startedAt: new Date().toISOString(),
      attributes: input.attributes,
    };
    this.spans.push(span);
    return {
      span,
      end: (ok = true, error?: string, extra?: Record<string, unknown>) => {
        span.endedAt = new Date().toISOString();
        span.ok = ok;
        span.error = error;
        span.attributes = { ...span.attributes, ...extra };
        return span;
      },
    };
  }
}

export class RunLogger {
  constructor(
    private readonly runId: string,
    private readonly agentSink: NdjsonSink | undefined,
    private readonly persist = true,
  ) {}

  emit(type: RunEventType, payload: Record<string, unknown> = {}, stepIndex?: number, spanId?: string): RunEvent {
    const event: RunEvent = {
      ts: new Date().toISOString(),
      type,
      runId: this.runId,
      stepIndex,
      spanId,
      payload,
    };
    if (this.persist) {
      appendEvent(this.runId, event);
    }
    this.agentSink?.write({ ...event });
    return event;
  }
}

export function createAgentSink(agent: boolean): NdjsonSink | undefined {
  return agent ? new StdoutNdjsonSink() : undefined;
}

export function spansToOtlp(spans: Span[], resource: Record<string, string> = {}): Record<string, unknown> {
  const isoToNano = (iso?: string) => {
    const ms = iso ? Date.parse(iso) : Date.now();
    return String(BigInt(ms) * 1_000_000n);
  };
  const hex = (id: string) =>
    Buffer.from(id.replace(/-/g, "").slice(0, 16).padEnd(16, "0")).toString("hex");
  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries({
            "service.name": "veriflow",
            ...resource,
          }).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeSpans: [
          {
            scope: { name: "veriflow.harness", version: "0.1.0" },
            spans: spans.map((span) => ({
              traceId: hex(span.runId).padEnd(32, "0"),
              spanId: hex(span.id),
              name: span.kind,
              kind: 1,
              startTimeUnixNano: isoToNano(span.startedAt),
              endTimeUnixNano: isoToNano(span.endedAt),
              status: {
                code: span.ok === false ? 2 : 1,
                message: span.error ?? "",
              },
              attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({
                key,
                value:
                  typeof value === "number"
                    ? { doubleValue: value }
                    : { stringValue: String(value) },
              })),
            })),
          },
        ],
      },
    ],
  };
}

export function writeOtlpFile(filePath: string, spans: Span[], resource?: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(spansToOtlp(spans, resource), null, 2), "utf8");
}
