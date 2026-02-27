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

  return response.choices[0]?.message?.content || '';
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

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

export type { ChatCompletionMessageParam };
