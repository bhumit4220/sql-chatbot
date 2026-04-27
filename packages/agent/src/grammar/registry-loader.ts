import fs from 'fs';
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

  // Detect common prefix shared across 5+ entities (e.g. Keycloak's
  // `keycloak_role`, `keycloak_group`, `keycloak_attribute` ...). Tables that
  // start with this prefix get a stripped alias so questions about "role" /
  // "group" map to the right entity even when the canonical name has the prefix.
  const prefixCounts = new Map<string, number>();
  for (const name of Object.keys(r.entities)) {
    const idx = name.indexOf('_');
    if (idx <= 0) continue;
    const prefix = name.slice(0, idx);
    if (prefix.length < 3) continue;
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const commonPrefixes = new Set<string>();
  for (const [prefix, count] of prefixCounts) {
    if (count >= 5) commonPrefixes.add(prefix);
  }

  // Build aliases for common question phrasings.
  // Rules (skip when alias clashes with a canonical entity name or another alias):
  //   plural form       → canonical    ("products" → "product_product" if entity has it)
  //   multi-word spaces → canonical    ("service areas" → "service_area")
  //   Django app_model  → model        ("product_product" exposes alias "product")
  //   Django app_model  → model plural ("product_product" exposes alias "products")
  for (const name of Object.keys(r.entities)) {
    const altForms: string[] = [];
    const spaced = name.replace(/_/g, ' ');
    altForms.push(spaced);
    altForms.push(pluralizeSimple(spaced));
    altForms.push(pluralizeSimple(name));

    // Django pattern: <app>_<model> where app and model refer to the same thing.
    // Variants:
    //   product_product (prefix === suffix)              → expose "product", "products"
    //   userstories_userstory (singularize(prefix) === suffix) → expose "userstory", "userstories"
    //   account_user (parts[0] === suffix)               → expose "user", "users"
    const parts = name.split('_');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const prefix = parts.slice(0, -1).join('_');
      const singularPrefix = singularize(prefix);
      if (prefix === last) {
        altForms.push(last);
        altForms.push(pluralizeSimple(last));
        altForms.push(last.replace(/_/g, ' '));
      } else if (singularPrefix === last) {
        // userstories_userstory → expose "userstory" and "userstories"
        altForms.push(last);
        altForms.push(pluralizeSimple(last));
        altForms.push(prefix); // expose the plural app form too
      } else if (parts[0] === last) {
        altForms.push(last);
        altForms.push(pluralizeSimple(last));
      }

      // TypeORM convention: `<model>_entity` (workflow_entity, tag_entity).
      // Strip the suffix and expose the bare model name + its plural.
      if (last === 'entity' && parts.length >= 2) {
        const stem = parts.slice(0, -1).join('_');
        altForms.push(stem);
        altForms.push(pluralizeSimple(stem));
      }

      // Common-prefix convention: e.g. Keycloak's `keycloak_role`.
      // If 5+ entities share the same first segment, strip it and expose
      // the rest as an alias.
      const firstSeg = parts[0];
      if (commonPrefixes.has(firstSeg) && parts.length >= 2) {
        const stripped = parts.slice(1).join('_');
        altForms.push(stripped);
        altForms.push(pluralizeSimple(stripped));
      }
    }

    for (const alt of altForms) {
      if (!alt || alt === name) continue;
      if (r.entities[alt]) continue;      // don't shadow real entity
      if (r.aliases[alt]) continue;       // first-come-first-served on conflicts
      r.aliases[alt] = name;
    }
  }

  return r;
}

function pluralizeSimple(word: string): string {
  if (!word) return word;
  if (/(s|x|ch|sh)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

export interface LoadOptions {
  manifestPath: string;
  schemaService: SchemaServiceLike;
  onWarn?: (msg: string) => void;
}

export function loadRegistry(opts: LoadOptions): Registry {
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[sql-chatbot] ${m}`));
  if (!fs.existsSync(opts.manifestPath)) {
    return buildSchemaOnlyRegistry(opts.schemaService);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(opts.manifestPath, 'utf8'));
  } catch (e) {
    warn(`manifest_parse_error: ${(e as Error).message} — falling back to schema-only`);
    return buildSchemaOnlyRegistry(opts.schemaService);
  }
  const liveTables = new Set(opts.schemaService.getTableList().map(t => t.name));
  const manifestTables = Object.values(raw.entities ?? {}).map((e: any) => e.table).filter(Boolean) as string[];
  const driftTables = manifestTables.filter(t => !liveTables.has(t));
  if (driftTables.length > 0) {
    warn(`schema_drift_detected: manifest references tables not in DB: ${driftTables.join(', ')}`);
  }
  return raw as Registry;
}
