import { createRegistry, Registry, Entity, Field, Association } from './registry.js';

const SOFT_DELETE_COLUMNS = ['deleted_at', 'discarded_at', 'archived_at', 'removed_at'];

interface SchemaTableLike {
  name: string;
  rowCount: number;
  primaryKey: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    enumValues?: Record<string, number | string>;
    fkTo?: { table: string; column: string };
  }>;
}

interface SchemaServiceLike {
  getTableList(): SchemaTableLike[];
}

function singularize(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('sses')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function mapType(pg: string): Field['type'] {
  const t = pg.toLowerCase();
  if (t.includes('int') || t === 'serial' || t === 'bigint') return 'int';
  if (t.includes('char') || t === 'text') return 'text';
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t.includes('timestamp') || t === 'date') return 'timestamp';
  if (t === 'numeric' || t === 'decimal' || t === 'double') return 'decimal';
  if (t === 'jsonb' || t === 'json') return 'jsonb';
  if (t === 'uuid') return 'uuid';
  return 'text';
}

export function buildSchemaOnlyRegistry(schema: SchemaServiceLike): Registry {
  const r = createRegistry({ framework: 'generic' });
  const tables = schema.getTableList();
  const tableToEntity: Record<string, string> = {};

  for (const t of tables) {
    const entityName = singularize(t.name);
    tableToEntity[t.name] = entityName;
    const fields: Record<string, Field> = {};
    const timestamps: Entity['timestamps'] = {};
    const rankingCandidates: string[] = [];

    for (const c of t.columns) {
      const type = c.enumValues ? 'enum' : mapType(c.type);
      fields[c.name] = {
        column: c.name,
        type,
        nullable: c.nullable,
        enumValues: c.enumValues,
        fkTo: c.fkTo ? { entity: singularize(c.fkTo.table), onColumn: c.fkTo.column } : undefined,
        searchable: type === 'text',
      };
      if (c.name === 'created_at') timestamps.created = c.name;
      if (c.name === 'updated_at') timestamps.updated = c.name;
      if (SOFT_DELETE_COLUMNS.includes(c.name)) timestamps.deleted = c.name;
      if (type === 'int' || type === 'decimal' || type === 'timestamp') {
        rankingCandidates.push(c.name);
      }
    }

    r.entities[entityName] = {
      name: entityName,
      table: t.name,
      displayLabel: entityName.charAt(0).toUpperCase() + entityName.slice(1),
      rowCount: t.rowCount,
      primaryKey: t.primaryKey,
      timestamps,
      fields,
      scopes: {},
      associations: {},
      rankingCandidates,
    };
  }

  // Second pass: wire FKs into associations
  for (const t of tables) {
    const sourceEntityName = tableToEntity[t.name];
    const sourceEntity = r.entities[sourceEntityName];
    for (const c of t.columns) {
      if (!c.fkTo) continue;
      const targetEntity = tableToEntity[c.fkTo.table];
      if (!targetEntity) continue;
      const assocName = targetEntity;
      const assoc: Association = {
        name: assocName,
        kind: 'belongs_to',
        targetEntity,
        joinClause: `${t.name}.${c.name} = ${c.fkTo.table}.${c.fkTo.column}`,
      };
      sourceEntity.associations[assocName] = assoc;
    }
  }

  return r;
}
