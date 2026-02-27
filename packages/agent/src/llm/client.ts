import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

let client: OpenAI;
let defaultModel: string;

export function initLLM(baseUrl: string, apiKey: string, model: string): void {
  client = new OpenAI({ apiKey, baseURL: baseUrl });
  defaultModel = model;
}

interface CallOptions {
  jsonMode?: boolean;
  temperature?: number;
  model?: string;
}

export async function callLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): Promise<string> {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLLM() first.');
  }

  const response = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
  });

  const msg = response.choices[0]?.message as any;
  // Some models (e.g. reasoning/thinking models) return content in the
  // `reasoning` field instead of `content`. Fall back to that if content is empty.
  return msg?.content || msg?.reasoning || '';
}

export async function* streamLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): AsyncGenerator<string> {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLLM() first.');
  }

  const stream = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: true,
  });

  let hasContent = false;
  let reasoningBuffer = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as any;
    const content = delta?.content;
    const reasoning = delta?.reasoning;

    if (content) {
      hasContent = true;
      yield content;
    } else if (reasoning) {
      // Buffer reasoning in case model never sends content
      reasoningBuffer += reasoning;
    }
  }

  // If model only used reasoning tokens (no content at all), yield the reasoning
  if (!hasContent && reasoningBuffer) {
    yield reasoningBuffer;
  }
}

/** @internal Reset client state — for testing only */
export function _resetForTesting(): void {
  client = undefined as any;
  defaultModel = undefined as any;
}

export type { ChatCompletionMessageParam };
