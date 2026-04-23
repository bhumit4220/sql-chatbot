import { describe, it, expect } from 'vitest';
import { createRegistry, findEntity, resolveAlias, Registry } from '../../grammar/registry.js';

describe('Registry', () => {
  it('creates an empty registry with expected shape', () => {
    const r = createRegistry({ framework: 'generic' });
    expect(r.entities).toEqual({});
    expect(r.aliases).toEqual({});
    expect(r.version).toBe(1);
    expect(r.framework).toBe('generic');
    expect(typeof r.generatedAt).toBe('string');
  });

  it('findEntity returns entity by canonical name', () => {
    const r: Registry = {
      entities: {
        user: {
          name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
          primaryKey: 'id', timestamps: {}, fields: {}, scopes: {},
          associations: {}, rankingCandidates: [],
        },
      },
      aliases: {}, version: 1, generatedAt: '', framework: 'generic',
    };
    expect(findEntity(r, 'user')?.table).toBe('users');
    expect(findEntity(r, 'nonexistent')).toBeNull();
  });

  it('resolveAlias falls through to entity name when no alias exists', () => {
    const r: Registry = {
      entities: { user: {} as any },
      aliases: { customers: 'user' },
      version: 1, generatedAt: '', framework: 'generic',
    };
    expect(resolveAlias(r, 'customers')).toBe('user');
    expect(resolveAlias(r, 'user')).toBe('user');
    expect(resolveAlias(r, 'unknown')).toBeNull();
  });
});
