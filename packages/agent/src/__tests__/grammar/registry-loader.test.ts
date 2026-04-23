import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildSchemaOnlyRegistry, loadRegistry } from '../../grammar/registry-loader.js';

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

describe('loadRegistry', () => {
  it('loads manifest when file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const manifestPath = path.join(dir, 'sql-chatbot-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      entities: { user: { table: 'users' } },
      aliases: {}, version: 1, generatedAt: 'x', framework: 'django',
    }));
    const r = loadRegistry({ manifestPath, schemaService: fakeSchemaService });
    expect(r.framework).toBe('django');
    expect(r.entities.user.table).toBe('users');
  });

  it('falls back to schema-only when manifest missing', () => {
    const r = loadRegistry({ manifestPath: '/nonexistent/path/manifest.json', schemaService: fakeSchemaService });
    expect(r.framework).toBe('generic');
    expect(r.entities.user).toBeDefined();
  });

  it('detects schema drift when manifest tables do not match DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const manifestPath = path.join(dir, 'sql-chatbot-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      entities: { stale: { table: 'no_such_table' } },
      aliases: {}, version: 1, generatedAt: 'x', framework: 'django',
    }));
    const warnings: string[] = [];
    loadRegistry({ manifestPath, schemaService: fakeSchemaService, onWarn: (m) => warnings.push(m) });
    expect(warnings.some(w => w.includes('schema_drift'))).toBe(true);
  });
});
