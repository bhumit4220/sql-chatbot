import { Entity } from './registry.js';

export type Modifier =
  | { kind: 'where'; field: string; op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'in'; value: any }
  | { kind: 'time'; field: string; window: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month' | 'this_year' }
  | { kind: 'join'; association: string }
  | { kind: 'group_by'; field: string }
  | { kind: 'having'; field: string; op: string; value: any }
  | { kind: 'order_by'; field: string; direction: 'asc' | 'desc' }
  | { kind: 'limit'; value: number }
  | { kind: 'distinct' };

const WINDOWS: Record<string, string> = {
  today: "DATE_TRUNC('day', NOW())",
  yesterday: "DATE_TRUNC('day', NOW() - INTERVAL '1 day')",
  last_7_days: "NOW() - INTERVAL '7 days'",
  last_30_days: "NOW() - INTERVAL '30 days'",
  this_month: "DATE_TRUNC('month', NOW())",
  this_year: "DATE_TRUNC('year', NOW())",
};

const OPS: Record<string, string> = { eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function applyModifier(sql: string, m: Modifier, e: Entity): string {
  switch (m.kind) {
    case 'where':    return applyWhere(sql, m, e);
    case 'time':     return applyTime(sql, m, e);
    case 'join':     return applyJoin(sql, m, e);
    case 'group_by': return applyGroupBy(sql, m, e);
    case 'having':   return applyHaving(sql, m, e);
    case 'order_by': return applyOrderBy(sql, m, e);
    case 'limit':    return applyLimit(sql, m);
    case 'distinct': return sql.replace(/^SELECT /, 'SELECT DISTINCT ');
  }
}

function appendClause(sql: string, clause: string): string {
  if (/ WHERE /i.test(sql)) return `${sql} AND ${clause}`;
  return `${sql} WHERE ${clause}`;
}

function applyWhere(sql: string, m: Extract<Modifier, { kind: 'where' }>, e: Entity): string {
  const field = e.fields[m.field];
  if (!field) throw new Error(`field '${m.field}' not on entity ${e.name}`);
  let value = m.value;
  if (field.type === 'enum') {
    if (!field.enumValues || !(String(value) in field.enumValues)) {
      throw new Error(`enum value '${value}' not in registry for ${e.name}.${m.field}`);
    }
    value = field.enumValues[String(value)];
  }
  const op = OPS[m.op] ?? '=';
  const formatted = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value;
  return appendClause(sql, `${e.table}.${m.field} ${op} ${formatted}`);
}

function applyTime(sql: string, m: Extract<Modifier, { kind: 'time' }>, e: Entity): string {
  const expr = WINDOWS[m.window];
  if (!expr) throw new Error(`unknown time window ${m.window}`);
  return appendClause(sql, `${e.table}.${m.field} >= ${expr}`);
}

function applyJoin(sql: string, m: Extract<Modifier, { kind: 'join' }>, e: Entity): string {
  const assoc = e.associations[m.association];
  if (!assoc) throw new Error(`association '${m.association}' not on entity ${e.name}`);
  // Determine the target table from the join clause: "<src_table>.<col> = <tgt_table>.<col>"
  const rhs = assoc.joinClause.split('=')[1]?.trim() ?? '';
  const targetTable = rhs.split('.')[0] ?? '';
  const joinClause = ` JOIN ${targetTable} ON ${assoc.joinClause}`;
  const matchWhere = sql.match(/ WHERE /i);
  return matchWhere ? sql.replace(/ WHERE /i, `${joinClause} WHERE `) : `${sql}${joinClause}`;
}

function applyGroupBy(sql: string, m: Extract<Modifier, { kind: 'group_by' }>, e: Entity): string {
  if (!e.fields[m.field]) throw new Error(`group_by field '${m.field}' not on entity ${e.name}`);
  return `${sql} GROUP BY ${e.table}.${m.field}`;
}

function applyHaving(sql: string, m: Extract<Modifier, { kind: 'having' }>, e: Entity): string {
  if (!/GROUP BY/i.test(sql)) throw new Error('HAVING requires GROUP BY');
  const op = OPS[m.op] ?? '=';
  return `${sql} HAVING ${m.field} ${op} ${m.value}`;
}

function applyOrderBy(sql: string, m: Extract<Modifier, { kind: 'order_by' }>, e: Entity): string {
  if (!e.fields[m.field]) throw new Error(`order_by field '${m.field}' not on entity ${e.name}`);
  const dir = String(m.direction ?? 'desc').toUpperCase();
  return `${sql} ORDER BY ${e.table}.${m.field} ${dir}`;
}

function applyLimit(sql: string, m: Extract<Modifier, { kind: 'limit' }>): string {
  if (/LIMIT \d+/i.test(sql)) return sql.replace(/LIMIT \d+/i, `LIMIT ${m.value}`);
  return `${sql} LIMIT ${m.value}`;
}
