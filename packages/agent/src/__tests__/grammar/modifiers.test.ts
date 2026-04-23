import { describe, it, expect } from 'vitest';
import { applyModifier, Modifier } from '../../grammar/modifiers.js';
import { Entity } from '../../grammar/registry.js';

const e: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
  primaryKey: 'id', timestamps: { created: 'created_at', deleted: 'deleted_at' },
  fields: {
    status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1, banned: 2 }, searchable: false },
    created_at: { column: 'created_at', type: 'timestamp', nullable: false, searchable: false },
  },
  scopes: {}, associations: {}, rankingCandidates: [],
};

describe('modifiers', () => {
  it('applies WHERE with enum value resolution', () => {
    const m: Modifier = { kind: 'where', field: 'status', op: 'eq', value: 'active' };
    const out = applyModifier('SELECT COUNT(*) FROM users', m, e);
    expect(out).toBe('SELECT COUNT(*) FROM users WHERE users.status = 1');
  });

  it('rejects unknown enum value', () => {
    const m: Modifier = { kind: 'where', field: 'status', op: 'eq', value: 'pending' };
    expect(() => applyModifier('SELECT COUNT(*) FROM users', m, e))
      .toThrow(/enum value.*not.*registry/);
  });

  it('applies TIME last_30_days', () => {
    const m: Modifier = { kind: 'time', field: 'created_at', window: 'last_30_days' };
    const out = applyModifier('SELECT COUNT(*) FROM users', m, e);
    expect(out).toBe("SELECT COUNT(*) FROM users WHERE users.created_at >= NOW() - INTERVAL '30 days'");
  });

  it('chains multiple modifiers with AND', () => {
    let sql = 'SELECT COUNT(*) FROM users';
    sql = applyModifier(sql, { kind: 'where', field: 'status', op: 'eq', value: 'active' }, e);
    sql = applyModifier(sql, { kind: 'time', field: 'created_at', window: 'last_30_days' }, e);
    expect(sql).toContain('WHERE users.status = 1');
    expect(sql).toContain('AND users.created_at >=');
  });
});
