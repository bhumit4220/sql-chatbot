import { Registry } from './registry.js';
import { extractIntent } from './intent-extractor.js';
import { compileTemplate, CompileResult } from './template-compiler.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from '../prompts/classify.js';

export interface TryGrammarInput {
  question: string;
  registry: Registry;
  history: ChatMessage[];
  callLLM: (messages: ChatCompletionMessageParam[]) => Promise<string>;
  confidenceThreshold?: number;
}

export type TryGrammarResult = CompileResult & { intent?: unknown };

export async function tryGrammarPath(input: TryGrammarInput): Promise<TryGrammarResult> {
  const intent = await extractIntent({
    question: input.question,
    registry: input.registry,
    history: input.history,
    callLLM: input.callLLM,
    confidenceThreshold: input.confidenceThreshold,
  });
  const result = compileTemplate(intent, input.registry);
  return { ...result, intent };
}
