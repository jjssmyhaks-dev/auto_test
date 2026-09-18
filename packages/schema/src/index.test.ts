import { describe, expect, it } from "vitest";
import {
  EvidenceManifestSchema,
  RunSchema,
  parseAction,
  safeParseAction,
} from "./index.js";

describe("ActionSchema", () => {
  it("accepts constrained action types", () => {
    expect(parseAction({ type: "navigate", url: "https://example.com" }).type).toBe(
      "navigate",
    );
    expect(
      parseAction({
        type: "click",
        target: { ref: "e1" },
      }).type,
    ).toBe("click");
    expect(
      parseAction({
        type: "fill",
        target: { selector: "input" },
        value: "hi",
        secret: true,
        vaultKey: "user.password",
      }),
    ).toMatchObject({ secret: true });
    expect(
      parseAction({
        type: "assert",
        check: "network",
        value: "/api/users",
      }).check,
    ).toBe("network");
    expect(
      parseAction({
        type: "assert",
        check: "console",
        value: "error",
      }).check,
    ).toBe("console");
    expect(parseAction({ type: "finish", success: true, reason: "done" }).type).toBe(
      "finish",
    );
    expect(
      parseAction({ type: "request_human", reason: "OTP" }).type,
    ).toBe("request_human");
  });

  it("rejects unconstrained / malformed actions", () => {
    expect(safeParseAction({ type: "execute_js", code: "alert(1)" }).success).toBe(
      false,
    );
    expect(safeParseAction({ type: "click" }).success).toBe(false);
    expect(safeParseAction({ type: "navigate", url: "" }).success).toBe(false);
  });
});

describe("Run and evidence schemas", () => {
  it("parses a run record", () => {
    const run = RunSchema.parse({
      id: "run_1",
      objective: "assert heading",
      status: "passed",
      startedAt: new Date().toISOString(),
      stepCount: 2,
    });
    expect(run.status).toBe("passed");
  });

  it("parses an evidence manifest", () => {
    const m = EvidenceManifestSchema.parse({
      version: 1,
      runId: "run_1",
      createdAt: new Date().toISOString(),
      objective: "x",
      status: "passed",
      stepCount: 1,
      files: [{ path: "events.jsonl", sha256: "abc" }],
    });
    expect(m.version).toBe(1);
  });
});
