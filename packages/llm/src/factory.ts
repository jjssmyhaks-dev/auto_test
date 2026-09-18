import type { VeriflowConfig } from "@veriflow/schema";
import { AnthropicProvider } from "./anthropic.js";
import type { LlmProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";

export function createProvider(config: Pick<VeriflowConfig, "provider" | "model">): LlmProvider {
  if (config.provider === "openai") {
    return new OpenAIProvider(process.env.OPENAI_API_KEY, config.model);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, config.model);
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(process.env.OPENAI_API_KEY, config.model);
  }
  throw new Error(
    "No LLM key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY. Veriflow does not ship a managed cloud key.",
  );
}
