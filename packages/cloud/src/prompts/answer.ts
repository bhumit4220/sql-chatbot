import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

type QuestionType = 'data' | 'data_with_code' | 'code' | 'navigation' | 'guidance';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnswerInput {
  question: string;
  questionType: QuestionType;
  sqlResult?: string;
  codeSnippets?: string;
  pageContext?: string;
  history: ChatMessage[];
}

export function buildAnswerMessages(input: AnswerInput): ChatCompletionMessageParam[] {
  let systemPrompt: string;

  switch (input.questionType) {
    case 'data':
    case 'data_with_code':
      systemPrompt = `You are a helpful admin panel assistant. The user asked a data question and a SQL query was executed. Summarize the results in a clear, natural language answer.

RULES:
- Trust the query results completely — do not second-guess them.
- Be concise — one to three sentences for simple queries.
- Format numbers with commas (e.g., 40,238 not 40238).
- If the result is a list, format it as a readable list.
- Do NOT show the SQL query unless the user asked for it.`;
      break;

    case 'code':
      systemPrompt = `You are a helpful admin panel assistant explaining code. The user asked about how something works in the codebase. Explain based on the code snippets provided.

RULES:
- Reference specific files and line numbers when explaining.
- Be concise but thorough — developers need accurate explanations.
- If the code is unclear, say so rather than guessing.`;
      break;

    case 'navigation':
    case 'guidance':
      systemPrompt = `You are a helpful admin panel assistant. The user needs help navigating or using the admin panel. Use the current page context to guide them.

RULES:
- Reference specific menu items, buttons, or links visible on the page.
- For navigation: tell them exactly where to click.
- For guidance: give step-by-step instructions.
- Be concise and actionable.`;
      break;

    default:
      systemPrompt = 'You are a helpful admin panel assistant.';
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add history
  for (const msg of input.history.slice(-10)) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Build context message
  let context = `Question: ${input.question}`;
  if (input.sqlResult) context += `\n\nQuery results:\n${input.sqlResult}`;
  if (input.codeSnippets) context += `\n\nCode snippets:\n${input.codeSnippets}`;
  if (input.pageContext) context += `\n\nPage context:\n${input.pageContext}`;

  messages.push({ role: 'user', content: context });
  return messages;
}
