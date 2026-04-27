import { Entity } from './registry.js';

export type PrimitiveKind = 'COUNT' | 'LIST' | 'SUM' | 'AVG' | 'MIN_MAX' | 'TOP_N' | 'RANK';

export interface PrimitiveInput {
  primitive: PrimitiveKind;
  entity: Entity;
  field?: string;
  which?: 'MIN' | 'MAX';
  n?: number;
  rankField?: string;
  groupBy?: string;
}

// Quote a single SQL identifier — wraps in double quotes and escapes any
// embedded quotes. Matters for PG reserved words like "user", "order", "group".
// Without this, `FROM user` silently resolves to the CURRENT_USER function.
export function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Qualified column reference: "table"."column"
export function qc(table: string, col: string): string {
  return `${q(table)}.${q(col)}`;
}

export function buildPrimitive(input: PrimitiveInput): string {
  const { primitive, entity } = input;
  const t = q(entity.table);
  switch (primitive) {
    case 'COUNT':
      return `SELECT COUNT(*) FROM ${t}`;
    case 'LIST':
      return `SELECT ${pickDisplayFields(entity).map(c => q(c)).join(', ')} FROM ${t}`;
    case 'SUM':
      requireField(input, entity, 'SUM');
      return `SELECT SUM(${qc(entity.table, input.field!)}) FROM ${t}`;
    case 'AVG':
      requireField(input, entity, 'AVG');
      return `SELECT ROUND(AVG(${qc(entity.table, input.field!)}), 2) FROM ${t}`;
    case 'MIN_MAX':
      requireField(input, entity, 'MIN_MAX');
      if (input.which !== 'MIN' && input.which !== 'MAX') throw new Error('MIN_MAX requires which');
      return `SELECT ${input.which}(${qc(entity.table, input.field!)}) FROM ${t}`;
    case 'TOP_N': {
      const rank = input.rankField ?? entity.rankingCandidates[0];
      if (!rank) throw new Error('TOP_N requires rankField');
      return `SELECT ${pickDisplayFields(entity).map(c => q(c)).join(', ')}, ${qc(entity.table, rank)} FROM ${t} ORDER BY ${qc(entity.table, rank)} DESC LIMIT ${input.n ?? 10}`;
    }
    case 'RANK': {
      const rank = input.rankField;
      const gb = input.groupBy;
      if (!rank || !gb) throw new Error('RANK requires rankField and groupBy');
      return `SELECT ${t}.*, DENSE_RANK() OVER (PARTITION BY ${qc(entity.table, gb)} ORDER BY ${qc(entity.table, rank)} DESC) AS rank FROM ${t}`;
    }
  }
}

function pickDisplayFields(entity: Entity): string[] {
  const preferred = ['id', 'name', 'title', 'label', 'email'];
  const present = preferred.filter(p => entity.fields[p]);
  if (present.length) return present.map(p => entity.fields[p].column);
  return Object.keys(entity.fields).slice(0, 4);
}

function requireField(input: PrimitiveInput, entity: Entity, name: string) {
  if (!input.field) throw new Error(`${name} requires field`);
  if (!entity.fields[input.field]) throw new Error(`${name} field '${input.field}' not in entity`);
}
