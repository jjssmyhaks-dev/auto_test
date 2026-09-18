import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, tamperHash } from "./index.js";

describe("evidence tamper hash", () => {
  it("is a SHA-256 of canonical JSON without the hash field", () => {
    const unsigned = {
      version: 1 as const,
      runId: "run_a",
      createdAt: "2026-01-01T00:00:00.000Z",
      objective: "assert heading",
      status: "passed" as const,
      stepCount: 1,
      files: [{ path: "events.jsonl", sha256: "abc" }],
    };
    const hash = tamperHash(unsigned);
    expect(hash).toBe(sha256(canonicalJson(unsigned)));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const shuffled = {
      files: unsigned.files,
      status: unsigned.status,
      objective: unsigned.objective,
      createdAt: unsigned.createdAt,
      runId: unsigned.runId,
      version: unsigned.version,
      stepCount: unsigned.stepCount,
    };
    expect(tamperHash(shuffled)).toBe(hash);
  });
});
