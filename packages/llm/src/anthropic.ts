import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, actionToolJsonSchema, estimateCostUsd } from "./prompt.js";
import type { DecideInput, DecideResult, LlmProvider } from "./types.js";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-sonnet-4-5") {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const schema = actionToolJsonSchema();
    const userText = [
      `Objective: ${input.objective}`,
      `Current URL: ${input.url}`,
      `Redacted step history:\n${input.redactedHistory || "(none)"}`,
      `Compact a11y tree with refs:\n${input.a11yTree}`,
    ].join("\n\n");

    const response = await this.client.messages.create({
      model: input.model ?? this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "browser_action",
          description: "Take exactly one constrained browser action",
          input_schema: schema as unknown as Anthropic.Messages.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: "browser_action" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: input.screenshotPng.toString("base64"),
              },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    });

    const block = response.content.find((c) => c.type === "tool_use");
    const raw = block && block.type === "tool_use" ? block.input : {};
    const inputTok = response.usage?.input_tokens ?? 0;
    const outputTok = response.usage?.output_tokens ?? 0;
    return {
      raw,
      provider: this.name,
      model: input.model ?? this.model,
      usage: {
        input: inputTok,
        output: outputTok,
        costUsd: estimateCostUsd(this.name, inputTok, outputTok),
      },
    };
  }
}
