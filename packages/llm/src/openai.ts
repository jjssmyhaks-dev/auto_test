import OpenAI from "openai";
import { SYSTEM_PROMPT, actionToolJsonSchema, estimateCostUsd } from "./prompt.js";
import type { DecideInput, DecideResult, LlmProvider } from "./types.js";

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey = process.env.OPENAI_API_KEY, model = "gpt-4o") {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    this.client = new OpenAI({ apiKey });
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

    const response = await this.client.chat.completions.create({
      model: input.model ?? this.model,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "browser_action",
            description: "Take exactly one constrained browser action",
            parameters: schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "browser_action" } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${input.screenshotPng.toString("base64")}`,
              },
            },
          ],
        },
      ],
    });

    const choice = response.choices[0];
    const tool = choice?.message?.tool_calls?.[0];
    let raw: unknown = {};
    if (tool?.function?.arguments) {
      try {
        raw = JSON.parse(tool.function.arguments) as unknown;
      } catch {
        raw = { parseError: tool.function.arguments };
      }
    }
    const inputTok = response.usage?.prompt_tokens ?? 0;
    const outputTok = response.usage?.completion_tokens ?? 0;
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
