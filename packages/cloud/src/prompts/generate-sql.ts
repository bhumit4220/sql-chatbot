import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GenerateSqlInput {
  question: string;
  schema: string;
  enums: string;
  discoveredContext: string;
  codeContext?: string;
  history: ChatMessage[];
  retryWithContext?: { originalSql: string; rejectionReason: string };
}

export function buildGenerateSqlMessages(input: GenerateSqlInput): ChatCompletionMessageParam[] {
  const systemPrompt = `You are a PostgreSQL SQL generator for an admin panel chatbot. Generate a single SELECT query to answer the user's question.

RULES:
- Generate ONLY SELECT statements. Never INSERT, UPDATE, DELETE, DROP, or any DDL.
- The query will run inside a READ ONLY transaction.
- Always include a LIMIT clause (max 500 rows) unless the query is an aggregate (COUNT, SUM, AVG, etc.).
- Use the provided schema, enum mappings, and discovered context to write accurate SQL.
- If enum values have labels (e.g., status: 1=Active), use the integer value in WHERE clauses, not the label text.
- Trust the discovered context — it contains auto-detected rules about this specific database.
- IMPORTANT: Only use column names that actually exist in the provided schema. Check the schema carefully before writing the query. Never guess column names.
- When querying about specific entities (people, places, items), always include human-readable columns alongside IDs. Check the schema for columns like first_name, last_name, email, title, description, address — use whatever descriptive columns actually exist. An admin needs to see WHO or WHAT, not just an ID.
- CRITICAL: When grouping by or selecting a foreign key ID (like job_type_id, contractor_id, customer_id, property_id), ALWAYS JOIN to the referenced table and SELECT a human-readable column (e.g., title, first_name, email) instead of returning raw IDs. Never return a bare ID column as a result — always resolve it to a name/title via JOIN.
- Unless the user specifically asks for all records including deleted, ALWAYS exclude deleted records (status != 3) in WHERE clauses. This applies to ALL tables that have a status column.

Respond with JSON only: {"sql": "SELECT ..."}`;

  let contextBlock = `DATABASE SCHEMA:\n${input.schema}`;
  if (input.enums) contextBlock += `\n\nENUM MAPPINGS:\n${input.enums}`;
  if (input.discoveredContext) contextBlock += `\n\nDISCOVERED CONTEXT:\n${input.discoveredContext}`;
  if (input.codeContext) contextBlock += `\n\nRELEVANT CODE:\n${input.codeContext}`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: contextBlock },
  ];

  // Add conversation history
  for (const msg of input.history.slice(-10)) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add current question
  let questionContent = `Question: ${input.question}`;
  if (input.retryWithContext) {
    questionContent += `\n\nPREVIOUS ATTEMPT FAILED:\nSQL: ${input.retryWithContext.originalSql}\nRejection reason: ${input.retryWithContext.rejectionReason}\nPlease generate a corrected query that avoids this issue.`;
  }
  messages.push({ role: 'user', content: questionContent });

  return messages;
}
