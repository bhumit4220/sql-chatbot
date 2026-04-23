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

export function buildPrimitive(input: PrimitiveInput): string {
  const { primitive, entity } = input;
  switch (primitive) {
    case 'COUNT':
      return `SELECT COUNT(*) FROM ${entity.table}`;
    case 'LIST':
      return `SELECT ${pickDisplayFields(entity).join(', ')} FROM ${entity.table}`;
    case 'SUM':
      requireField(input, entity, 'SUM');
      return `SELECT SUM(${entity.table}.${input.field}) FROM ${entity.table}`;
    case 'AVG':
      requireField(input, entity, 'AVG');
      return `SELECT ROUND(AVG(${entity.table}.${input.field}), 2) FROM ${entity.table}`;
    case 'MIN_MAX':
      requireField(input, entity, 'MIN_MAX');
      if (input.which !== 'MIN' && input.which !== 'MAX') throw new Error('MIN_MAX requires which');
      return `SELECT ${input.which}(${entity.table}.${input.field}) FROM ${entity.table}`;
    case 'TOP_N': {
      const rank = input.rankField ?? entity.rankingCandidates[0];
      if (!rank) throw new Error('TOP_N requires rankField');
      return `SELECT ${pickDisplayFields(entity).join(', ')}, ${entity.table}.${rank} FROM ${entity.table} ORDER BY ${entity.table}.${rank} DESC LIMIT ${input.n ?? 10}`;
    }
    case 'RANK': {
      const rank = input.rankField;
      const gb = input.groupBy;
      if (!rank || !gb) throw new Error('RANK requires rankField and groupBy');
      return `SELECT ${entity.table}.*, DENSE_RANK() OVER (PARTITION BY ${entity.table}.${gb} ORDER BY ${entity.table}.${rank} DESC) AS rank FROM ${entity.table}`;
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
