import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from './classify.js';

export interface GenerateSqlInput {
  question: string;
  schema: string;
  codeContext?: string;
  history: ChatMessage[];
}

export function buildGenerateSqlMessages(input: GenerateSqlInput): ChatCompletionMessageParam[] {
  let systemPrompt = `You are a PostgreSQL query generator. Given a database schema and a user question, generate a single SELECT query to answer the question.

RULES:
1. ONLY generate SELECT statements — never INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or any data-modifying statement
2. Always add LIMIT 100 unless the user explicitly asks for all results or the query is a COUNT/aggregation
3. Use JOINs to return human-readable names instead of raw IDs where possible
4. Use appropriate WHERE clauses to filter data as requested
5. For date filters, use PostgreSQL date functions (NOW(), INTERVAL, DATE_TRUNC, etc.)
6. Prefer COUNT, SUM, AVG for aggregate questions
7. Use ILIKE for case-insensitive text searches
8. Always qualify column names with table aliases when using JOINs to avoid ambiguity
9. Return useful columns — don't SELECT * unless the user asks to "show everything"
10. Order results meaningfully (most recent first for dates, highest first for counts, alphabetical for names)

Respond with JSON only: {"sql": "<the SQL query>", "explanation": "<brief explanation of what the query does>"}`;

  if (input.codeContext) {
    systemPrompt += `\n\nRELEVANT CODE CONTEXT (use this to understand business logic, calculations, or field meanings):\n${input.codeContext}`;
  }

  let userContent = '';
  if (input.history.length > 0) {
    const recentHistory = input.history.slice(-4);
    const historyText = recentHistory.map((m) => `${m.role}: ${m.content}`).join('\n');
    userContent += `Conversation history:\n${historyText}\n\n`;
  }
  userContent += `Question: ${input.question}\n\nDatabase schema:\n${input.schema}`;

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userContent },
  ];
}
