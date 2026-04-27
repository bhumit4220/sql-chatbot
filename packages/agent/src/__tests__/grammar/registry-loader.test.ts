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

  it('Keycloak-style common prefix (5+ tables) exposes stripped alias', () => {
    const keycloakSchema = {
      getTableList: () => [
        { name: 'keycloak_role', rowCount: 32, primaryKey: 'id', columns: [] },
        { name: 'keycloak_group', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'keycloak_attribute', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'keycloak_realm', rowCount: 1, primaryKey: 'id', columns: [] },
        { name: 'keycloak_session', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'realm', rowCount: 1, primaryKey: 'id', columns: [] },
      ],
    } as any;
    const r = buildSchemaOnlyRegistry(keycloakSchema);
    expect(r.aliases.role).toBe('keycloak_role');
    expect(r.aliases.roles).toBe('keycloak_role');
    expect(r.aliases.group).toBe('keycloak_group');
    expect(r.aliases.groups).toBe('keycloak_group');
  });

  it('TypeORM _entity suffix exposes bare model alias (workflow_entity → workflow)', () => {
    const n8nSchema = {
      getTableList: () => [
        { name: 'workflow_entity', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'credentials_entity', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'tag_entity', rowCount: 0, primaryKey: 'id', columns: [] },
      ],
    } as any;
    const r = buildSchemaOnlyRegistry(n8nSchema);
    expect(r.aliases.workflow).toBe('workflow_entity');
    expect(r.aliases.workflows).toBe('workflow_entity');
    expect(r.aliases.credentials).toBe('credentials_entity');
    expect(r.aliases.tag).toBe('tag_entity');
    expect(r.aliases.tags).toBe('tag_entity');
  });

  it('Django plural-app naming exposes singular + plural alias (userstories_userstory)', () => {
    const taigaSchema = {
      getTableList: () => [
        { name: 'userstories_userstory', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'epics_epic', rowCount: 0, primaryKey: 'id', columns: [] },
        { name: 'milestones_milestone', rowCount: 0, primaryKey: 'id', columns: [] },
      ],
    } as any;
    const r = buildSchemaOnlyRegistry(taigaSchema);
    expect(r.aliases.userstory).toBe('userstories_userstory');
    expect(r.aliases.userstories).toBe('userstories_userstory');
    expect(r.aliases.epic).toBe('epics_epic');
    expect(r.aliases.epics).toBe('epics_epic');
    expect(r.aliases.milestone).toBe('milestones_milestone');
    expect(r.aliases.milestones).toBe('milestones_milestone');
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
