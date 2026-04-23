export interface Registry {
  entities: Record<string, Entity>;
  aliases: Record<string, string>;
  version: number;
  generatedAt: string;
  framework: 'rails' | 'django' | 'generic';
}

export interface Entity {
  name: string;
  table: string;
  displayLabel: string;
  rowCount: number;
  primaryKey: string;
  timestamps: { created?: string; updated?: string; deleted?: string };
  fields: Record<string, Field>;
  scopes: Record<string, Scope>;
  associations: Record<string, Association>;
  rankingCandidates: string[];
}

export type FieldType = 'int' | 'text' | 'bool' | 'timestamp' | 'decimal' | 'enum' | 'jsonb' | 'uuid';

export interface Field {
  column: string;
  type: FieldType;
  nullable: boolean;
  enumValues?: Record<string, number | string>;
  fkTo?: { entity: string; onColumn: string };
  userFacingLabel?: string;
  searchable: boolean;
}

export interface Scope {
  name: string;
  whereClause: string;
  paramSlots: string[];
}

export interface Association {
  name: string;
  kind: 'belongs_to' | 'has_many' | 'has_one' | 'has_many_through';
  targetEntity: string;
  joinClause: string;
  throughEntity?: string;
}

export function createRegistry(opts: { framework: Registry['framework'] }): Registry {
  return {
    entities: {},
    aliases: {},
    version: 1,
    generatedAt: new Date().toISOString(),
    framework: opts.framework,
  };
}

export function findEntity(r: Registry, name: string): Entity | null {
  return r.entities[name] ?? null;
}

export function resolveAlias(r: Registry, term: string): string | null {
  if (r.aliases[term]) return r.aliases[term];
  if (r.entities[term]) return term;
  return null;
}
