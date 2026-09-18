import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@veriflow/schema": path.join(root, "packages/schema/src/index.ts"),
      "@veriflow/store": path.join(root, "packages/store/src/index.ts"),
      "@veriflow/vault": path.join(root, "packages/vault/src/index.ts"),
      "@veriflow/evidence": path.join(root, "packages/evidence/src/index.ts"),
      "@veriflow/telemetry": path.join(root, "packages/telemetry/src/index.ts"),
      "@veriflow/llm": path.join(root, "packages/llm/src/index.ts"),
      "@veriflow/harness": path.join(root, "packages/harness/src/index.ts"),
    },
  },
});
