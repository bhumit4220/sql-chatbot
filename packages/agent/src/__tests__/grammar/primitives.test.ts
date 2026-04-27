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
  it('COUNT emits SELECT COUNT(*) with quoted table', () => {
    expect(buildPrimitive({ primitive: 'COUNT', entity: userEntity }))
      .toBe('SELECT COUNT(*) FROM "users"');
  });

  it('LIST picks sensible display fields, all quoted', () => {
    expect(buildPrimitive({ primitive: 'LIST', entity: userEntity }))
      .toBe('SELECT "id", "name", "email" FROM "users"');
  });

  it('SUM with field — qualified + quoted', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, balance: { column: 'balance', type: 'decimal' as const, nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'SUM', entity: e, field: 'balance' }))
      .toBe('SELECT SUM("users"."balance") FROM "users"');
  });

  it('AVG rounds to 2 places — qualified + quoted', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, score: { column: 'score', type: 'decimal' as const, nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'AVG', entity: e, field: 'score' }))
      .toBe('SELECT ROUND(AVG("users"."score"), 2) FROM "users"');
  });

  it('MIN_MAX requires which', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, score: { column: 'score', type: 'decimal' as const, nullable: false, searchable: false } } };
    expect(() => buildPrimitive({ primitive: 'MIN_MAX', entity: e, field: 'score' }))
      .toThrow(/which/);
  });

  it('TOP_N uses provided rankField, quoted', () => {
    const e = { ...userEntity, rankingCandidates: ['created_at'], fields: { ...userEntity.fields, created_at: { column: 'created_at', type: 'timestamp' as const, nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'TOP_N', entity: e, n: 5 }))
      .toContain('ORDER BY "users"."created_at" DESC LIMIT 5');
  });

  it('PG-reserved-word table name "user" is safely quoted', () => {
    const e: Entity = { ...userEntity, name: 'user', table: 'user' };
    // Without quoting, FROM user resolves to PG CURRENT_USER and silently
    // returns wrong row count. Quoting the identifier prevents this entire
    // class of silent corruption.
    expect(buildPrimitive({ primitive: 'COUNT', entity: e }))
      .toBe('SELECT COUNT(*) FROM "user"');
  });

  it('throws when SUM field not on entity', () => {
    expect(() => buildPrimitive({ primitive: 'SUM', entity: userEntity, field: 'nope' }))
      .toThrow(/not in entity/);
  });
});
