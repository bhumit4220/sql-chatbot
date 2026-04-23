import { describe, it, expect, vi } from 'vitest';
import { extractIntent } from '../../grammar/intent-extractor.js';
import { Registry, Entity } from '../../grammar/registry.js';

const userEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 100, primaryKey: 'id',
  timestamps: {},
  fields: { status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1 }, searchable: false } },
  scopes: {}, associations: {}, rankingCandidates: [],
};
const registry: Registry = { version: 1, generatedAt: '', framework: 'rails', aliases: {}, entities: { user: userEntity } };

describe('extractIntent', () => {
  it('parses matched intent from LLM JSON', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user',
      modifiers: [{ kind: 'where', field: 'status', op: 'eq', value: 'active' }],
      confidence: 0.92,
    }));
    const r = await extractIntent({ question: 'how many active users', registry, history: [], callLLM: fakeLLM });
    expect(r.status).toBe('matched');
    if (r.status === 'matched') expect(r.primitive).toBe('COUNT');
  });

  it('returns unmatched when LLM confidence below threshold', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user', modifiers: [], confidence: 0.3,
    }));
    const r = await extractIntent({ question: 'x', registry, history: [], callLLM: fakeLLM, confidenceThreshold: 0.7 });
    expect(r.status).toBe('unmatched');
  });

  it('returns unmatched when LLM returns malformed JSON', async () => {
    const fakeLLM = vi.fn().mockResolvedValue('not json at all');
    const r = await extractIntent({ question: 'x', registry, history: [], callLLM: fakeLLM });
    expect(r.status).toBe('unmatched');
  });

  it('passes entity candidates into prompt', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unmatched', confidence: 0, reason: 'x' }));
    await extractIntent({ question: 'users', registry, history: [], callLLM: fakeLLM });
    const prompt = fakeLLM.mock.calls[0][0];
    const serialized = JSON.stringify(prompt);
    expect(serialized).toContain('user');
    expect(serialized).toContain('COUNT');
  });
});
