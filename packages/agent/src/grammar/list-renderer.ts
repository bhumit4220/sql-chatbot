// Programmatic renderer for the grammar's LIST primitive when the result is
// small. Bypasses the answer-stream LLM entirely so truncation / dropped-item
// bugs (e.g., Chatwoot "5 labels listed as 4") cannot occur on small lists.
//
// Architectural design:
//   - One pure function. No side effects, no LLM calls.
//   - Returns `{ ok: true, text }` when conditions match, else `{ ok: false }`.
//   - Caller (Orchestrator) yields the text as `token` events when ok.

const PROGRAMMATIC_THRESHOLD = 10;

export interface ListRenderResult {
  ok: boolean;
  text?: string;
}

// Picks the best human-readable column for an item in a result row.
// Preference: title → name → label → email → first non-id text-like value.
function pickLabel(row: Record<string, unknown>): string | null {
  const preferred = ['title', 'name', 'label', 'subject', 'email', 'username'];
  for (const k of preferred) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Fallback: first non-id string value
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function tryRenderListProgrammatically(
  primitive: string | undefined,
  entityDisplayLabel: string | undefined,
  rows: unknown[],
): ListRenderResult {
  if (primitive !== 'LIST') return { ok: false };
  if (!Array.isArray(rows)) return { ok: false };
  if (rows.length === 0) {
    return { ok: true, text: 'No matching records found.' };
  }
  if (rows.length > PROGRAMMATIC_THRESHOLD) return { ok: false };

  const labels: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { ok: false };
    const lbl = pickLabel(row as Record<string, unknown>);
    if (!lbl) return { ok: false };
    labels.push(lbl);
  }

  const noun = entityDisplayLabel
    ? entityDisplayLabel + (rows.length === 1 ? '' : 's')
    : 'item' + (rows.length === 1 ? '' : 's');
  const intro =
    rows.length === 1
      ? `Here is the ${noun}:`
      : `Here are the ${rows.length} ${noun}:`;

  const lines = labels.map(l => `- ${l}`).join('\n');
  return { ok: true, text: `${intro}\n${lines}` };
}
