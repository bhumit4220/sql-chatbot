import { Registry, Entity } from './registry.js';
import { buildPrimitive, PrimitiveKind, qc } from './primitives.js';
import { applyModifier, Modifier } from './modifiers.js';

export type Intent =
  | {
      status: 'matched';
      primitive: PrimitiveKind;
      entity: string;
      modifiers: Modifier[];
      field?: string;
      which?: 'MIN' | 'MAX';
      n?: number;
      rankField?: string;
      groupBy?: string;
      confidence: number;
    }
  | { status: 'unmatched'; confidence: number; reason: string };

export type CompileResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

export function compileTemplate(intent: Intent, registry: Registry): CompileResult {
  if (intent.status === 'unmatched') {
    return { ok: false, reason: `unmatched: ${intent.reason}` };
  }

  const entityName = registry.aliases[intent.entity] ?? intent.entity;
  const entity = registry.entities[entityName];
  if (!entity) return { ok: false, reason: `entity '${intent.entity}' not in registry` };

  try {
    let sql = buildPrimitive({
      primitive: intent.primitive,
      entity,
      field: intent.field,
      which: intent.which,
      n: intent.n,
      rankField: intent.rankField,
      groupBy: intent.groupBy,
    });

    for (const m of intent.modifiers) sql = applyModifier(sql, m, entity);

    if (entity.timestamps.deleted) {
      sql = withSoftDelete(sql, entity);
    }

    if (!/LIMIT \d+/i.test(sql) && intent.primitive !== 'COUNT' && !/COUNT\(/i.test(sql)) {
      sql = `${sql} LIMIT 100`;
    }

    return { ok: true, sql };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function withSoftDelete(sql: string, entity: Entity): string {
  const col = entity.timestamps.deleted!;
  const quotedRef = qc(entity.table, col);
  const clause = `${quotedRef} IS NULL`;
  // If the column reference already appears (user explicitly filtered on it), skip.
  // Match either the quoted form or the unquoted-pair form (defensive).
  if (sql.includes(quotedRef) || new RegExp(`\\b${entity.table}\\.${col}\\b`, 'i').test(sql)) return sql;
  if (/ WHERE /i.test(sql)) return sql.replace(/ WHERE /i, ` WHERE ${clause} AND `);
  // No WHERE: inject before GROUP BY/ORDER BY/LIMIT, or append.
  const beforeGroupOrOrder = sql.match(/ (GROUP BY|ORDER BY|LIMIT) /i);
  if (beforeGroupOrOrder) return sql.replace(beforeGroupOrOrder[0], ` WHERE ${clause}${beforeGroupOrOrder[0]}`);
  return `${sql} WHERE ${clause}`;
}
