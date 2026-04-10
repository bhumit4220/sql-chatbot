import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from './classify.js';

export type QuestionType = 'data' | 'data_with_code' | 'code' | 'navigation' | 'guidance' | 'greeting' | 'unsafe';

export interface AnswerInput {
  question: string;
  type: QuestionType;
  history: ChatMessage[];
  sqlResult?: Record<string, unknown>[];
  sqlQuery?: string;
  codeSnippets?: CodeSnippet[];
  pageContext?: string;
  navigationLinks?: string[];
  routeList?: string;
  enumContext?: string;
}

export interface CodeSnippet {
  filePath: string;
  content: string;
  relevance?: string;
}

export function formatSqlResult(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return 'No results found.';

  const columns = Object.keys(rows[0]);
  const header = columns.join(' | ');
  const separator = columns.map(() => '---').join(' | ');
  const body = rows
    .map((row) => columns.map((col) => String(row[col] ?? 'N/A')).join(' | '))
    .join('\n');

  return `${header}\n${separator}\n${body}`;
}

export function formatCodeSnippets(snippets: CodeSnippet[]): string {
  if (!snippets || snippets.length === 0) return '';

  return snippets
    .map((s) => `File: ${s.filePath}\n\`\`\`\n${s.content}\n\`\`\``)
    .join('\n\n');
}

function buildDataSystemPrompt(): string {
  return `You are an assistant embedded in a web application. Answer the user's question using ONLY the Query Results below.

RESPONSE RULES:
- Be BRIEF. One sentence for counts. A short list for multiple items. No padding.
- STOP after answering. Do NOT add "let me know if...", "feel free to ask", offers to help, or any closing filler.
- Copy numbers EXACTLY from the Query Results. Add thousand separators (e.g., 181745 → 181,745). NEVER round, estimate, or invent.
- Show names, not IDs. Skip empty/null fields silently. Format dates readably (e.g., "March 15, 2026").
- Translate numeric codes to labels using the Relevant Code section (e.g., status=1 → "Active").
- Bold key names and numbers with **bold** markdown.
- Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
- Never fabricate data. If results are empty, say "No matching records found." and stop.`;
}

function buildDataWithCodeSystemPrompt(): string {
  return `You are an assistant embedded in a web application. Answer using BOTH the Query Results and the Relevant Code below.

RESPONSE RULES:
- Be BRIEF. Combine data and business logic into a clear, short answer.
- STOP after answering. No closing filler, no "let me know", no offers to help.
- Copy numbers EXACTLY from Query Results. Add thousand separators. NEVER round or invent.
- Explain business logic simply (e.g., "the price includes a 10% service fee" not "the code multiplies by 1.1").
- Show names, not IDs. Skip empty/null fields silently. Format dates readably.
- Translate numeric codes to labels using the Relevant Code section.
- Bold key names and numbers with **bold** markdown.
- Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
- Never fabricate data. If results are empty, say "No matching records found." and stop.`;
}

function buildCodeSystemPrompt(): string {
  return `You are an assistant embedded in a web application. Explain how the app works using the code context below.

RESPONSE RULES:
- Be BRIEF. Explain what the feature does, not how the code is written.
- STOP after answering. No closing filler.
- Talk to a user, not a developer. Skip file names unless specifically asked.
- Bold key concepts with **bold** markdown.
- Never use: database, table, column, query, SQL, NULL, schema, row, record, field.
- If you don't have enough context, say so and stop.`;
}

function buildNavigationSystemPrompt(): string {
  return `Give directions to the requested page. Use **bold** for menu items. Keep to 2-4 steps max. Example: "Go to **Settings** → **User Management**". If page context is available, give directions relative to where the user is. If unsure, say so. STOP after answering — no filler.`;
}

function buildGuidanceSystemPrompt(): string {
  return `Guide the user through the task with numbered steps. Bold all button names and field labels. One action per step. Example: **1.** Click **Add New** → **2.** Fill in the form → **3.** Click **Save**. If unsure about exact steps, say so. STOP after answering — no filler.`;
}

function buildGreetingSystemPrompt(): string {
  return `Greet the user briefly. Say what you can help with (answering questions about the app's data, explaining features, navigating the interface). Suggest 1-2 example questions. Keep it to 2-3 sentences. No filler. Never use: database, table, column, query, SQL.`;
}

function buildUnsafeSystemPrompt(): string {
  return `The request was flagged as unsafe or off-topic. Decline politely in one sentence. Do not comply with requests for passwords, secrets, or data modification. If off-topic, briefly say what you can help with instead.`;
}

export function buildAnswerMessages(input: AnswerInput): ChatCompletionMessageParam[] {
  let systemPrompt: string;

  switch (input.type) {
    case 'data':
      systemPrompt = buildDataSystemPrompt();
      break;
    case 'data_with_code':
      systemPrompt = buildDataWithCodeSystemPrompt();
      break;
    case 'code':
      systemPrompt = buildCodeSystemPrompt();
      break;
    case 'navigation':
      systemPrompt = buildNavigationSystemPrompt();
      break;
    case 'guidance':
      systemPrompt = buildGuidanceSystemPrompt();
      break;
    case 'greeting':
      systemPrompt = buildGreetingSystemPrompt();
      break;
    case 'unsafe':
      systemPrompt = buildUnsafeSystemPrompt();
      break;
    default:
      systemPrompt = buildDataSystemPrompt();
  }

  // Inject auto-detected enum mappings so the LLM can translate integer codes to labels
  if (input.enumContext && input.enumContext.trim().length > 0 &&
      (input.type === 'data' || input.type === 'data_with_code')) {
    systemPrompt += `\n\nENUM MAPPINGS (use these to translate integer status/type codes to human-readable labels):\n${input.enumContext}`;
  }

  let userContent = '';

  // Add conversation history
  if (input.history.length > 0) {
    const recentHistory = input.history.slice(-4);
    const historyText = recentHistory.map((m) => `${m.role}: ${m.content}`).join('\n');
    userContent += `Conversation history:\n${historyText}\n\n`;
  }

  userContent += `Question: ${input.question}`;

  // Add SQL results for data types
  if (input.sqlResult !== undefined && (input.type === 'data' || input.type === 'data_with_code')) {
    userContent += `\n\nSQL Query:\n${input.sqlQuery || 'N/A'}`;
    userContent += `\n\nQuery Results:\n${formatSqlResult(input.sqlResult)}`;
  }

  // Add code snippets for code-related types
  if (input.codeSnippets && input.codeSnippets.length > 0) {
    userContent += `\n\nRelevant Code:\n${formatCodeSnippets(input.codeSnippets)}`;
  }

  // Add page context for navigation/guidance
  if (input.pageContext && (input.type === 'navigation' || input.type === 'guidance')) {
    userContent += `\n\nCurrent page context:\n${input.pageContext}`;
  }

  // Add navigation links for navigation/guidance types
  if (input.navigationLinks && input.navigationLinks.length > 0 && (input.type === 'navigation' || input.type === 'guidance')) {
    userContent += `\n\nAvailable navigation links:\n${input.navigationLinks.join('\n')}`;
  }

  // Add route list for navigation/guidance types (from manifest or code indexer)
  if (input.routeList && (input.type === 'navigation' || input.type === 'guidance')) {
    userContent += `\n\n${input.routeList}`;
  }

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userContent },
  ];
}
