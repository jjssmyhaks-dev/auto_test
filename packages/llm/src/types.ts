export interface TokenUsage {
  input: number;
  output: number;
  costUsd: number;
}

export interface DecideInput {
  objective: string;
  url: string;
  a11yTree: string;
  screenshotPng: Buffer;
  redactedHistory: string;
  model?: string;
}

export interface DecideResult {
  raw: unknown;
  usage: TokenUsage;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  decide(input: DecideInput): Promise<DecideResult>;
}
