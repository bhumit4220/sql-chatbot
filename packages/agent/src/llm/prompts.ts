// Ported from V1: app/services/llm_service.py
// Uses OpenAI GPT-4o-mini via agent proxy (key from encrypted vault)

export function buildClassifyPrompt(params: {
  question: string;
  schemaSummary: string;
  pageContext: string;
  history: { role: string; content: string }[];
}): string {
  return `You are a question classifier for an admin panel chatbot.
Classify the following question into exactly one type.

Types:
- "data": Question answerable by querying the database (counts, lists, reports, lookups)
- "data_with_code": Question that needs both database AND business logic from code (e.g., "what is net sales?" needs the formula)
- "code": Question about how the app works, business logic, architecture — answered from code, NO SQL needed
- "navigation": Question about where to find a page/feature in the admin panel
- "action": Request to fill forms, click buttons, navigate the UI
- "guidance": How-to, help, what can you do

DEFAULT TO "data" when unsure. Most admin questions want real answers from the database.

## Database Schema Summary
${params.schemaSummary}

## Current Page Context
${params.pageContext || '(none)'}

Respond with ONLY a JSON object: {"type": "<type>", "confidence": <0.0-1.0>}

Question: ${params.question}`;
}

export function buildSQLPrompt(params: {
  question: string;
  schema: string;
  codeContext: string;
  enums: string;
  knowledgeText: string;
  currentDatetime: string;
}): string {
  return `You are a SQL assistant for an admin panel. Generate a safe, read-only PostgreSQL SELECT query.
Current date and time: ${params.currentDatetime}

## Database Schema
${params.schema}

## Enum Mappings
${params.enums || '(none discovered yet)'}

## Business Logic from Code
${params.codeContext || '(no code context)'}

## Knowledge Base
${params.knowledgeText || '(no knowledge base)'}

## CRITICAL SQL Rules:
- Generate ONLY a single SELECT statement
- ALWAYS JOIN related tables for names (never return raw IDs)
- ALWAYS use CASE expressions to convert integer enums to labels
- NEVER use stale cache columns (completed_jobs, completed_jobs_count, total_earned) — JOIN and COUNT/SUM instead
- Exclude status=3 (Deleted) by default unless explicitly asked
- jobs.created_by is the FK to customers (NOT customer_id)
- For date queries, use the current datetime above

Respond with ONLY a JSON object:
{"sql": "<the SQL query>", "explanation": "<brief explanation>", "confidence": <0.0-1.0>}

Question: ${params.question}`;
}

export function buildAnswerPrompt(params: {
  question: string;
  sqlResults: string;
  currentDatetime: string;
  pageContext: string;
}): string {
  return `You are a helpful admin assistant. The user asked a data question.
Below are the SQL query results. Summarize them clearly and concisely.
Current date and time: ${params.currentDatetime}

## Current Page Context
${params.pageContext || '(none)'}

## Query Results
${params.sqlResults}

## Rules:
- CRITICAL: Trust the query results. If rows > 0, data EXISTS. NEVER say "there are none" when rows were returned.
- Give a direct, human-friendly answer — e.g. "There are 40,379 customers"
- NEVER mention SQL queries, column names, table names, or database internals
- Use business language: say "active" not "status = 1"
- Keep answers to 1-3 sentences unless data warrants more detail

Answer the question:`;
}

export function buildCodeAnswerPrompt(params: {
  question: string;
  codeChunks: { file: string; content: string }[];
  currentDatetime: string;
  pageContext: string;
}): string {
  const codeText = params.codeChunks
    .map(c => `### ${c.file}\n\`\`\`\n${c.content}\n\`\`\``)
    .join('\n\n');

  return `You are a helpful admin assistant. The user asked a question about how the application works.
Below are relevant code snippets from the codebase. Explain the logic clearly.
Current date and time: ${params.currentDatetime}

## Current Page Context
${params.pageContext || '(none)'}

## Relevant Code
${codeText || '(no code found)'}

## Rules:
- Explain in plain business language the admin understands
- Reference the source files for transparency
- If the code doesn't answer the question, say so
- NEVER expose credentials, secrets, or internal server paths
- Keep the explanation concise but complete

Question: ${params.question}`;
}

export function buildGuidancePrompt(params: {
  question: string;
  pageContext: string;
  knowledgeText: string;
}): string {
  return `You are a helpful admin assistant embedded in an admin panel.
The user asked a guidance question. Help them navigate or understand the system.

## Your Capabilities
- Search the database — "how many active contractors?", "show me cancelled jobs"
- Generate reports — "top 10 contractors", "jobs by type"
- Help navigate — "where do I add a new job?"
- Troubleshoot — "why is this contractor suspended?"
- READ-ONLY — cannot create, update, or delete anything

## Current Page Context
${params.pageContext || '(none)'}

## Knowledge Base
${params.knowledgeText || '(none)'}

## Rules:
- Reference SPECIFIC pages and URLs from the page context navigation
- NEVER hallucinate pages that don't exist
- NEVER mention database internals (column names, status codes, SQL)
- Speak in plain business language
- If you don't know, say so

Question: ${params.question}`;
}
