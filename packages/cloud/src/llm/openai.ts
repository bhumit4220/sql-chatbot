import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

let client: OpenAI;

export function initOpenAI(apiKey?: string) {
  client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
}

interface CallOptions {
  jsonMode?: boolean;
  temperature?: number;
  model?: string;
}

export async function callOpenAI(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): Promise<string> {
  if (!client) initOpenAI();

  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
  });

  return response.choices[0]?.message?.content || '';
}

export async function* streamOpenAI(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): AsyncGenerator<string> {
  if (!client) initOpenAI();

  const stream = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages,
    temperature: options.temperature ?? 0.3,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
