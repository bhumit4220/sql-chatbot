import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

interface ClassifyInput {
  question: string;
  schemaSummary: string;
  pageContext?: string;
}

export function buildClassifyMessages(input: ClassifyInput): ChatCompletionMessageParam[] {
  const systemPrompt = `You are a question classifier for an admin panel chatbot. Classify the user's question into exactly one type.

TYPES:
- "data": Questions answerable by querying the database (counts, lists, aggregations, lookups)
- "data_with_code": Questions requiring BOTH database query AND understanding of business logic in the codebase (e.g., "show jobs where net sales > $500" needs the net_sales formula from code)
- "code": Questions about how the codebase works, business logic, calculations (no database query needed)
- "navigation": Questions about WHERE something is in the admin panel UI ("where is X?", "how do I find X?")
- "guidance": Questions about HOW to perform an action in the admin panel ("how do I ban a user?", "how do I create a coupon?")

For "code" and "data_with_code" types, also return searchTerms — an array of 2-5 keywords to search the codebase for relevant code.

Respond with JSON only: {"type": "<type>", "confidence": <0.0-1.0>, "searchTerms": ["term1", "term2"]}
searchTerms should only be included for "code" and "data_with_code" types.`;

  let userContent = `Question: ${input.question}\n\nDatabase schema:\n${input.schemaSummary}`;
  if (input.pageContext) {
    userContent += `\n\nCurrent page context:\n${input.pageContext}`;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}
