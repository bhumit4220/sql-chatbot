import { describe, it, expect } from 'vitest';
import { buildPrimitive } from '../../grammar/primitives.js';
import { Entity } from '../../grammar/registry.js';

const userEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
  primaryKey: 'id', timestamps: {},
  fields: {
    id: { column: 'id', type: 'int', nullable: false, searchable: false },
    name: { column: 'name', type: 'text', nullable: false, searchable: true },
    email: { column: 'email', type: 'text', nullable: false, searchable: true },
  },
  scopes: {}, associations: {}, rankingCandidates: [],
};

describe('primitives', () => {
  it('COUNT emits SELECT COUNT(*)', () => {
    expect(buildPrimitive({ primitive: 'COUNT', entity: userEntity }))
      .toBe('SELECT COUNT(*) FROM users');
  });

  it('LIST picks sensible display fields', () => {
    expect(buildPrimitive({ primitive: 'LIST', entity: userEntity }))
      .toBe('SELECT id, name, email FROM users');
  });
});
