import { describe, it, expect, vi } from 'vitest';
import { tryGrammarPath } from '../../grammar/try-grammar-path.js';
import { Registry, Entity } from '../../grammar/registry.js';

const userEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 100, primaryKey: 'id',
  timestamps: {},
  fields: { status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1, banned: 2 }, searchable: false } },
  scopes: {}, associations: {}, rankingCandidates: [],
};
const registry: Registry = { version: 1, generatedAt: '', framework: 'rails', aliases: {}, entities: { user: userEntity } };

describe('tryGrammarPath', () => {
  it('returns {ok:true, sql} for a valid matched intent', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user',
      modifiers: [{ kind: 'where', field: 'status', op: 'eq', value: 'active' }],
      confidence: 0.9,
    }));
    const r = await tryGrammarPath({ question: 'how many active users', registry, history: [], callLLM });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain('COUNT(*)');
  });

  it('returns {ok:false, reason:"unmatched"} when intent extractor says unmatched', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unmatched', confidence: 0, reason: 'x' }));
    const r = await tryGrammarPath({ question: 'x', registry, history: [], callLLM });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unmatched/);
  });

  it('returns {ok:false} when compile fails due to unknown entity', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'ghost', modifiers: [], confidence: 0.9,
    }));
    const r = await tryGrammarPath({ question: 'x', registry, history: [], callLLM });
    expect(r.ok).toBe(false);
  });
});
