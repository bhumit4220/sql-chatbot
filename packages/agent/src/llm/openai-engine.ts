import OpenAI from 'openai';
import { DEFAULT_OPENAI_MODEL } from '@chatbot/shared';
import type {
  ClassifyResult,
  SQLResult,
  QuestionType,
  LLMEngine,
  ClassifyContext,
  SQLContext,
  AnswerContext,
  CodeAnswerContext,
} from '@chatbot/shared';
import {
  buildClassifyPrompt,
  buildSQLPrompt,
  buildAnswerPrompt,
  buildCodeAnswerPrompt,
  buildGuidancePrompt,
} from './prompts.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Converts conversation history into OpenAI message format.
 * Keeps the last N exchanges to stay within token limits.
 */
function historyToMessages(history: ChatMessage[], maxPairs = 5): OpenAI.ChatCompletionMessageParam[] {
  if (!history || history.length === 0) return [];
  // Take last N*2 messages (N user+assistant pairs)
  const recent = history.slice(-(maxPairs * 2));
  return recent.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
}

export class OpenAIEngine implements LLMEngine {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = DEFAULT_OPENAI_MODEL) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.models.retrieve(this.model);
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    // No-op for OpenAI — client is ready on construction
  }

  async shutdown(): Promise<void> {
    // No-op for OpenAI
  }

  async classify(question: string, context: ClassifyContext): Promise<ClassifyResult> {
    const prompt = buildClassifyPrompt({
      question,
      schemaSummary: context.schemaSummary,
      pageContext: context.pageContext || '',
      history: context.history,
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    try {
      const json = JSON.parse(response.choices[0].message.content || '{}');
      return {
        type: json.type as QuestionType,
        confidence: json.confidence || 0.8,
      };
    } catch {
      return { type: 'data', confidence: 0.5 };
    }
  }

  async generateSQL(question: string, context: SQLContext): Promise<SQLResult> {
    const prompt = buildSQLPrompt({
      question,
      schema: context.schema,
      codeContext: context.codeContext || '',
      enums: context.enums || '',
      knowledgeText: '',
      currentDatetime: new Date().toISOString(),
    });

    // Build messages: system prompt + conversation history + current question
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: prompt },
      ...historyToMessages(context.history as ChatMessage[]),
      { role: 'user', content: question },
    ];

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    try {
      const json = JSON.parse(response.choices[0].message.content || '{}');
      return {
        sql: json.sql,
        explanation: json.explanation || '',
        confidence: json.confidence || 0.8,
        needsExploration: false,
      };
    } catch {
      return {
        sql: '',
        explanation: 'Failed to parse response',
        confidence: 0.3,
        needsExploration: false,
      };
    }
  }

  async *streamAnswer(question: string, context: AnswerContext): AsyncIterable<string> {
    let prompt: string;

    if (context.questionType === 'guidance' || context.questionType === 'navigation') {
      prompt = buildGuidancePrompt({
        question,
        pageContext: context.pageContext || '',
        knowledgeText: '',
      });
    } else {
      prompt = buildAnswerPrompt({
        question,
        sqlResults: context.sqlResults || '(no results)',
        currentDatetime: new Date().toISOString(),
        pageContext: context.pageContext || '',
      });
    }

    // Build messages: system prompt + conversation history + current question
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: prompt },
      ...historyToMessages(context.history as ChatMessage[]),
      { role: 'user', content: question },
    ];

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  async *streamAnswerFromCode(question: string, context: CodeAnswerContext): AsyncIterable<string> {
    const prompt = buildCodeAnswerPrompt({
      question,
      codeChunks: context.codeChunks,
      currentDatetime: new Date().toISOString(),
      pageContext: context.pageContext || '',
    });

    // Build messages: system prompt + conversation history + current question
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: prompt },
      ...historyToMessages(context.history as ChatMessage[]),
      { role: 'user', content: question },
    ];

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}
