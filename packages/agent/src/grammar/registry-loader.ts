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

  // Build aliases via a declarative rule registry. Each AliasRule is a pure
  // function that, given an entity name and shared context (e.g., common
  // prefixes detected across the registry), returns the alternative forms
  // to register as aliases pointing back to the canonical name.
  //
  // To support a new naming convention, push a new rule into ALIAS_RULES.
  // No edits to this loop or the alias-building function are needed.
  const ctx: AliasContext = {
    entityNames: new Set(Object.keys(r.entities)),
    commonPrefixes: detectCommonPrefixes(Object.keys(r.entities)),
  };

  for (const name of Object.keys(r.entities)) {
    const altForms = collectAlternativeForms(name, ctx);
    for (const alt of altForms) {
      if (!alt || alt === name) continue;
      if (r.entities[alt]) continue;      // don't shadow real entity
      if (r.aliases[alt]) continue;       // first-come-first-served on conflicts
      r.aliases[alt] = name;
    }
  }

  return r;
}

// ---------------------------------------------------------------------------
// Alias inference engine
// ---------------------------------------------------------------------------
// Each rule is independent and side-effect-free. The order of rules matters
// only for ties (first-come-first-served when alias keys collide); a rule
// returning more specific forms first is preferred.

interface AliasContext {
  entityNames: Set<string>;
  commonPrefixes: Set<string>;
}

type AliasRule = (name: string, parts: string[], ctx: AliasContext) => string[];

// Always emit the spaced and plural forms of every name.
const baseFormsRule: AliasRule = (name) => [
  name.replace(/_/g, ' '),
  pluralizeSimple(name.replace(/_/g, ' ')),
  pluralizeSimple(name),
];

// Django/duplicated-prefix variants. Three sub-cases share one rule.
const duplicatedSegmentRule: AliasRule = (_name, parts) => {
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1];
  const prefix = parts.slice(0, -1).join('_');
  const out: string[] = [];

  if (prefix === last) {
    // product_product → product, products, "product"
    out.push(last, pluralizeSimple(last), last.replace(/_/g, ' '));
  } else if (singularize(prefix) === last) {
    // userstories_userstory → userstory, userstories
    out.push(last, pluralizeSimple(last), prefix);
  } else if (parts[0] === last) {
    // account_user → user, users
    out.push(last, pluralizeSimple(last));
  }
  return out;
};

// TypeORM-style `<model>_entity` suffix.
const entitySuffixRule: AliasRule = (_name, parts) => {
  if (parts.length < 2) return [];
  if (parts[parts.length - 1] !== 'entity') return [];
  const stem = parts.slice(0, -1).join('_');
  return [stem, pluralizeSimple(stem)];
};

// Common-segment prefix shared by 5+ entities (Keycloak `keycloak_*`).
const commonPrefixRule: AliasRule = (_name, parts, ctx) => {
  if (parts.length < 2) return [];
  const firstSeg = parts[0];
  if (!ctx.commonPrefixes.has(firstSeg)) return [];
  const stripped = parts.slice(1).join('_');
  return [stripped, pluralizeSimple(stripped)];
};

const ALIAS_RULES: AliasRule[] = [
  baseFormsRule,
  duplicatedSegmentRule,
  entitySuffixRule,
  commonPrefixRule,
];

function collectAlternativeForms(name: string, ctx: AliasContext): string[] {
  const parts = name.split('_');
  const out: string[] = [];
  for (const rule of ALIAS_RULES) {
    out.push(...rule(name, parts, ctx));
  }
  return out;
}

function detectCommonPrefixes(entityNames: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of entityNames) {
    const idx = name.indexOf('_');
    if (idx <= 0) continue;
    const prefix = name.slice(0, idx);
    if (prefix.length < 3) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [prefix, count] of counts) {
    if (count >= 5) result.add(prefix);
  }
  return result;
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
