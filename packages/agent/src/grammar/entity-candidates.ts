import { Registry, Entity } from './registry.js';

// Score how well an entity matches the question.
//
// Beyond the previous full-name matching, we now also tokenize the entity
// name on '_' and score each token against the question. This handles cases
// like Django's `projects_project` vs `projects_projecttemplate`:
//   Q: "how many projects"
//   - `projects_project` token "project" matches "projects" → token score
//   - `projects_projecttemplate` token "projecttemplate" → no match
//
// Tie-breakers (in order):
//   1. Higher score wins
//   2. Fewer name segments wins (`project` over `projects_project`,
//      `projects_project` over `projects_projecttemplate`)
//   3. Higher row count (data table over lookup/template table)
function scoreEntity(question: string, entity: Entity, registry: Registry): number {
  const q = question.toLowerCase();
  const singular = entity.name.toLowerCase();
  const plural = entity.table.toLowerCase();
  let score = 0;

  // Whole-name word boundary match (highest signal)
  if (q.includes(` ${singular} `) || q.startsWith(`${singular} `) || q.endsWith(` ${singular}`)) score += 12;
  if (q.includes(plural)) score += 10;
  if (q.includes(singular)) score += 5;

  // Alias match
  for (const [alias, target] of Object.entries(registry.aliases)) {
    if (target !== entity.name) continue;
    if (q.includes(alias.toLowerCase())) score += 8;
  }

  // Token-level matching: split entity name on '_' and score each token.
  // This catches `projects_project` → "project" matches "projects".
  const tokens = singular.split('_').filter(t => t.length >= 3);
  for (const tok of tokens) {
    const tokPlural = pluralizeSimple(tok);
    // Whole-word match against the question
    const re = new RegExp(`\\b(${escapeRegex(tok)}|${escapeRegex(tokPlural)})\\b`);
    if (re.test(q)) score += 4;
  }

  // Whitespace-collapsed match: "user stories" → "userstories" → matches
  // "userstories_userstory" token. Score is length-weighted so longer
  // matches win (avoids "user" in "userstories" giving spurious credit
  // to a `users_user` table when the real intent is `userstories_userstory`).
  const qCompact = q.replace(/\s+/g, '');
  let bestCompactLen = 0;
  for (const tok of tokens) {
    if (tok.length < 5) continue;
    const candidates = [tok, pluralizeSimple(tok)];
    for (const c of candidates) {
      if (qCompact.includes(c) && c.length > bestCompactLen) bestCompactLen = c.length;
    }
  }
  if (bestCompactLen > 0) score += bestCompactLen; // 5..15+

  return score;
}

function pluralizeSimple(word: string): string {
  if (/(s|x|ch|sh)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Number of segments in entity name. Simpler names get tie-break preference.
function nameSegments(entity: Entity): number {
  return entity.name.split('_').length;
}

export function selectEntityCandidates(question: string, registry: Registry, topN: number): Entity[] {
  const scored = Object.values(registry.entities).map(entity => ({
    entity,
    score: scoreEntity(question, entity, registry),
    segments: nameSegments(entity),
    rowCount: entity.rowCount,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;            // higher score first
    if (a.segments !== b.segments) return a.segments - b.segments; // simpler name first
    return b.rowCount - a.rowCount;                                // more rows last (real data > lookup)
  });

  if (scored[0]?.score === 0) {
    // No term matched anywhere. Fall back to high-row-count entities.
    return Object.values(registry.entities)
      .sort((a, b) => b.rowCount - a.rowCount)
      .slice(0, topN);
  }
  return scored.slice(0, topN).map(s => s.entity);
}
