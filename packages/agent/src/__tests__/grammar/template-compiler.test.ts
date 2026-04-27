import { describe, it, expect } from 'vitest';
import { compileTemplate, Intent } from '../../grammar/template-compiler.js';
import { Registry } from '../../grammar/registry.js';

const registry: Registry = {
  version: 1, generatedAt: '', framework: 'rails',
  aliases: { customers: 'user' },
  entities: {
    user: {
      name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
      primaryKey: 'id',
      timestamps: { deleted: 'deleted_at' },
      fields: {
        status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1, banned: 2 }, searchable: false },
        created_at: { column: 'created_at', type: 'timestamp', nullable: false, searchable: false },
        deleted_at: { column: 'deleted_at', type: 'timestamp', nullable: true, searchable: false },
      },
      scopes: {}, associations: {}, rankingCandidates: [],
    },
  },
};

describe('compileTemplate', () => {
  it('compiles COUNT + where + time + auto soft-delete', () => {
    const intent: Intent = {
      status: 'matched',
      primitive: 'COUNT',
      entity: 'user',
      modifiers: [
        { kind: 'where', field: 'status', op: 'eq', value: 'active' },
        { kind: 'time', field: 'created_at', window: 'last_30_days' },
      ],
      confidence: 0.9,
    };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('SELECT COUNT(*) FROM "users"');
      expect(out.sql).toContain('"users"."status" = 1');
      expect(out.sql).toContain(`"users"."created_at" >= NOW() - INTERVAL '30 days'`);
      expect(out.sql).toContain('"users"."deleted_at" IS NULL');
    }
  });

  it('returns {ok:false} when entity not in registry', () => {
    const intent: Intent = { status: 'matched', primitive: 'COUNT', entity: 'ghost', modifiers: [], confidence: 0.9 };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/entity/);
  });

  it('returns {ok:false} when intent is unmatched', () => {
    const intent: Intent = { status: 'unmatched', confidence: 0.2, reason: 'nope' };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(false);
  });
});
