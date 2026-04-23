import { Registry, Entity } from './registry.js';

export function selectEntityCandidates(question: string, registry: Registry, topN: number): Entity[] {
  const q = question.toLowerCase();
  const scores: Array<{ entity: Entity; score: number }> = [];

  for (const entity of Object.values(registry.entities)) {
    let score = 0;
    const singular = entity.name.toLowerCase();
    const plural = entity.table.toLowerCase();
    if (q.includes(` ${singular} `) || q.startsWith(`${singular} `) || q.endsWith(` ${singular}`)) score += 10;
    if (q.includes(plural)) score += 10;
    if (q.includes(singular)) score += 5;
    for (const [alias, target] of Object.entries(registry.aliases)) {
      if (target !== entity.name) continue;
      if (q.includes(alias.toLowerCase())) score += 8;
    }
    scores.push({ entity, score });
  }

  const sorted = scores.sort((a, b) => b.score - a.score);
  if (sorted[0]?.score === 0) {
    return Object.values(registry.entities)
      .sort((a, b) => b.rowCount - a.rowCount)
      .slice(0, topN);
  }
  return sorted.slice(0, topN).map(s => s.entity);
}
