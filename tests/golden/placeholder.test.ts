import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));

describe("golden flow placeholders", () => {
  it("ships 1–2 smoke flow stubs (full suite is later)", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const flow = JSON.parse(readFileSync(join(dir, "example-com-heading.json"), "utf8")) as {
      objective: string;
      env: string;
      status: string;
    };
    expect(flow.env).toBe("https://example.com");
    expect(flow.objective.toLowerCase()).toContain("heading");
    expect(flow.status).toBe("placeholder");
  });
});
