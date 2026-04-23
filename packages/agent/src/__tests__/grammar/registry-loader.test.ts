import { describe, it, expect } from 'vitest';
import { buildSchemaOnlyRegistry } from '../../grammar/registry-loader.js';

const fakeSchemaService = {
  getTableList: () => [
    { name: 'users', rowCount: 100, primaryKey: 'id', columns: [
      { name: 'id', type: 'int', nullable: false },
      { name: 'status', type: 'int', nullable: false, enumValues: { active: 1, banned: 2 } },
      { name: 'deleted_at', type: 'timestamp', nullable: true },
    ]},
    { name: 'orders', rowCount: 50, primaryKey: 'id', columns: [
      { name: 'id', type: 'int', nullable: false },
      { name: 'user_id', type: 'int', nullable: false, fkTo: { table: 'users', column: 'id' }},
    ]},
  ],
} as any;

describe('buildSchemaOnlyRegistry', () => {
  it('creates entities for each table', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.table).toBe('users');
    expect(r.entities.order.table).toBe('orders');
  });

  it('singularizes table names as entity canonical names', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(Object.keys(r.entities).sort()).toEqual(['order', 'user']);
  });

  it('maps enum column values into Field.enumValues', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.fields.status.enumValues).toEqual({ active: 1, banned: 2 });
  });

  it('auto-detects soft-delete column as timestamps.deleted', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.timestamps.deleted).toBe('deleted_at');
  });

  it('converts FK columns into associations on the source entity', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.order.associations.user).toEqual({
      name: 'user',
      kind: 'belongs_to',
      targetEntity: 'user',
      joinClause: 'orders.user_id = users.id',
    });
  });
});
