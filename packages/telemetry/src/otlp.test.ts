import { describe, expect, it } from "vitest";
import { spansToOtlp } from "./index.js";
import type { Span } from "@veriflow/schema";

describe("OTLP JSON export", () => {
  it("serializes OTel-shaped resourceSpans", () => {
    const spans: Span[] = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        runId: "run_abc",
        kind: "ACT",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        ok: true,
        attributes: { actionType: "click" },
      },
    ];
    const otlp = spansToOtlp(spans);
    const rs = otlp.resourceSpans as unknown[];
    expect(rs.length).toBe(1);
    expect(JSON.stringify(otlp)).toContain("service.name");
    expect(JSON.stringify(otlp)).toContain("ACT");
  });
});
