/**
 * Model provider abstraction for LLM reasoning in the Aegis Agent Runtime.
 * Decouples model inference from specific external SDKs (OpenAI, Anthropic, Gemini, Groq).
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

export interface ModelPrompt {
  readonly systemPrompt?: string | undefined;
  readonly userPrompt: string;
  readonly context?: Record<string, unknown> | undefined;
}

export interface ModelResponse {
  readonly content: string;
  readonly raw?: unknown;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | undefined;
}

export interface ModelError {
  readonly code: "PROVIDER_ERROR" | "TIMEOUT" | "INVALID_RESPONSE";
  readonly message: string;
}

export interface IModelProvider {
  readonly name: string;
  generate(prompt: ModelPrompt): Promise<Result<ModelResponse, ModelError>>;
}

/**
 * Deterministic test double for model provider.
 * Allows scriptable or templated responses without requiring external network/API keys.
 */
export class DeterministicModelProvider implements IModelProvider {
  readonly name: string;
  private readonly responses: string[];
  private callIndex = 0;

  constructor(responses: string | string[] = [], name = "deterministic-provider") {
    this.name = name;
    this.responses = Array.isArray(responses) ? [...responses] : [responses];
  }

  async generate(prompt: ModelPrompt): Promise<Result<ModelResponse, ModelError>> {
    await Promise.resolve();

    if (this.responses.length === 0) {
      return err({
        code: "INVALID_RESPONSE",
        message: `No scripted responses configured for prompt: '${prompt.userPrompt.slice(0, 50)}'`,
      });
    }

    const content = this.responses[this.callIndex % this.responses.length] ?? "";
    this.callIndex += 1;

    return ok({
      content,
      usage: {
        inputTokens: prompt.userPrompt.length,
        outputTokens: content.length,
      },
    });
  }

  getCallCount(): number {
    return this.callIndex;
  }

  reset(): void {
    this.callIndex = 0;
  }
}
