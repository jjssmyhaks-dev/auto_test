export const SYSTEM_PROMPT = `You are Veriflow, a constrained browser test agent.
You must choose exactly one action from the browser_action tool schema.
Prefer accessibility @ref targets. Use bbox only if no ref exists.
Use assert to verify the objective (text/heading/url/visible). For network/console checks use assert check=network|console with value as a substring (requires --devtools capture). Call finish when the objective is done or clearly impossible.
Never request JavaScript execution. Never include secrets in action values; use vaultKey + secret:true for fills.
Mark destructive clicks (delete, pay, purchase, irrevocable submit) with destructive: true.`;

export function estimateCostUsd(provider: string, input: number, output: number): number {
  const rates =
    provider === "openai"
      ? { in: 2.5 / 1_000_000, out: 10 / 1_000_000 }
      : { in: 3 / 1_000_000, out: 15 / 1_000_000 };
  return input * rates.in + output * rates.out;
}

/** Top-level JSON Schema object (Anthropic/OpenAI tools require type: object). */
export function actionToolJsonSchema(): Record<string, unknown> {
  const target = {
    type: "object",
    properties: {
      ref: { type: "string", description: "a11y @ref such as e1" },
      selector: { type: "string" },
      text: { type: "string" },
      bbox: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: [
          "navigate",
          "click",
          "fill",
          "select",
          "hover",
          "scroll",
          "wait",
          "assert",
          "finish",
          "request_human",
        ],
      },
      url: { type: "string" },
      target,
      value: { type: "string" },
      secret: { type: "boolean" },
      vaultKey: { type: "string" },
      destructive: { type: "boolean" },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "number" },
      ms: { type: "number" },
      selector: { type: "string" },
      check: {
        type: "string",
        enum: ["visible", "text_contains", "url_contains", "heading_contains", "network", "console"],
      },
      success: { type: "boolean" },
      reason: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["type"],
  };
}
