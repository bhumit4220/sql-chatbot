import { describe, it, expect } from 'vitest';
import { checkCountSanity } from '../../grammar/sanity-check.js';
import { Entity } from '../../grammar/registry.js';

const baseEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 9,
  primaryKey: 'id', timestamps: {}, fields: {}, scopes: {}, associations: {},
  rankingCandidates: [],
};

describe('checkCountSanity', () => {
  it('passes when COUNT result matches registry rowCount', () => {
    const r = checkCountSanity('COUNT', baseEntity, [{ count: '9' }]);
    expect(r.ok).toBe(true);
  });

  it('passes within 3x tolerance', () => {
    const r = checkCountSanity('COUNT', baseEntity, [{ count: '5' }]);
    expect(r.ok).toBe(true);
  });

  it('FLAGS Gitea-style silent corruption (got 1, registry has 9)', () => {
    const r = checkCountSanity('COUNT', baseEntity, [{ count: '1' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/count_mismatch/);
    expect(r.reason).toContain('1');
    expect(r.reason).toContain('9');
  });

  it('FLAGS implausibly large result (got 1000, registry has 9)', () => {
    const r = checkCountSanity('COUNT', baseEntity, [{ count: '1000' }]);
    expect(r.ok).toBe(false);
  });

  it('skips check on tiny tables (registry rowCount <= 5)', () => {
    const tiny = { ...baseEntity, rowCount: 3 };
    const r = checkCountSanity('COUNT', tiny, [{ count: '1' }]);
    expect(r.ok).toBe(true);
  });

  it('skips non-COUNT primitives', () => {
    const r = checkCountSanity('LIST', baseEntity, [{ count: '1' }]);
    expect(r.ok).toBe(true);
  });

  it('skips when result is not a single-row scalar', () => {
    const r = checkCountSanity('COUNT', baseEntity, [{ a: 1 }, { a: 2 }]);
    expect(r.ok).toBe(true);
  });
});
