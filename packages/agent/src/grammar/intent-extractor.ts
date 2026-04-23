import { Registry } from './registry.js';
import { Intent } from './template-compiler.js';
import { selectEntityCandidates } from './entity-candidates.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from '../prompts/classify.js';

export interface ExtractIntentInput {
  question: string;
  registry: Registry;
  history: ChatMessage[];
  callLLM: (messages: ChatCompletionMessageParam[]) => Promise<string>;
  confidenceThreshold?: number;
}

const PRIMITIVE_DESCRIPTIONS = `
COUNT — how many rows of X
LIST — show/list rows of X
SUM — total of numeric field on X
AVG — average of numeric field on X
MIN_MAX — lowest/highest value of field on X
TOP_N — top N rows of X ordered by a ranking field
RANK — window-ranked rows of X within groups
`.trim();

const MODIFIER_DESCRIPTIONS = `
where     — filter by a field value (op: eq/neq/lt/lte/gt/gte/like/in)
time      — filter by time window on a timestamp field (today/yesterday/last_7_days/last_30_days/this_month/this_year)
join      — include a related entity via association
group_by  — group results by field
having    — filter grouped results by aggregate op+value
order_by  — order results by field (asc/desc)
limit     — cap result count
distinct  — deduplicate rows
`.trim();

export async function extractIntent(input: ExtractIntentInput): Promise<Intent> {
  const threshold = input.confidenceThreshold ?? 0.7;
  const candidates = selectEntityCandidates(input.question, input.registry, 5);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input.question, candidates, input.history);
  let raw: string;
  try {
    raw = await input.callLLM([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (e) {
    return { status: 'unmatched', confidence: 0, reason: `llm_error: ${(e as Error).message}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unmatched', confidence: 0, reason: 'malformed_json' };
  }

  if (parsed.status === 'unmatched') {
    return { status: 'unmatched', confidence: parsed.confidence ?? 0, reason: parsed.reason ?? 'unmatched' };
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < threshold) {
    return { status: 'unmatched', confidence: parsed.confidence ?? 0, reason: `low_confidence:${parsed.confidence}` };
  }
  return parsed as Intent;
}

function buildSystemPrompt(): string {
  return `You are an intent classifier for a SQL chatbot. Given a user question and a list of available entities, extract a structured intent.

Primitives:
${PRIMITIVE_DESCRIPTIONS}

Modifiers:
${MODIFIER_DESCRIPTIONS}

You MUST output JSON. If the question doesn't fit any primitive cleanly, set status=unmatched.

Output shape:
{"status":"matched","primitive":"COUNT","entity":"user","modifiers":[{"kind":"where","field":"status","op":"eq","value":"active"}],"confidence":0.92}
or
{"status":"unmatched","confidence":0.3,"reason":"question requires compare-to-average, no primitive covers this"}

Rules:
- Only reference entities from the provided candidates. Never invent.
- Only use fields listed under the chosen entity.
- For enum filters, pass the enum key (e.g. "active"), NOT the underlying integer.
- Set confidence honestly: 0.9+ only when every slot has a clear mapping.
- When in doubt, return unmatched.`;
}

function buildUserPrompt(question: string, candidates: ReturnType<typeof selectEntityCandidates>, history: ChatMessage[]): string {
  const historyText = history.slice(-2).map(m => `${m.role}: ${m.content}`).join('\n');
  const entityBlocks = candidates.map(e => formatEntityBrief(e)).join('\n\n');
  return `History:\n${historyText}\n\nEntity candidates:\n${entityBlocks}\n\nQuestion: ${question}`;
}

function formatEntityBrief(e: any): string {
  const fields = Object.entries(e.fields).slice(0, 15).map(([n, f]: any) => {
    const enumPart = f.enumValues ? ` enum=${JSON.stringify(f.enumValues)}` : '';
    return `  ${n}: ${f.type}${enumPart}`;
  }).join('\n');
  const assocs = Object.keys(e.associations).slice(0, 8).join(', ') || '(none)';
  const scopes = Object.keys(e.scopes).slice(0, 8).join(', ') || '(none)';
  return `Entity: ${e.name} (table=${e.table}, rows=${e.rowCount})\nFields:\n${fields}\nAssociations: ${assocs}\nScopes: ${scopes}`;
}
