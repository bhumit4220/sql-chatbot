// Post-execution sanity check for grammar-generated SQL.
//
// Catches "plausible but wrong" results where the SQL ran without error but
// the value is way off. Concrete case: Gitea's reserved-word `user` table
// returned 1 instead of 9 because PG silently resolved `FROM user` to the
// CURRENT_USER function. Even with quoted identifiers (V1.2 #1), other
// classes of bug can produce numeric results that disagree with the
// registry's known row count — this catches them universally.

import { Entity } from './registry.js';

export interface SanityCheckResult {
  ok: boolean;
  reason?: string;
}

// Mismatch tolerance: known > 5 rows AND result is <1/3 or >3x the known count.
// The thresholds are tuned to avoid false positives on small tables (where
// the registry's pg_stat snapshot can be 0 due to no autovacuum yet).
export function checkCountSanity(
  primitive: string,
  entity: Entity,
  resultRows: unknown[],
): SanityCheckResult {
  if (primitive !== 'COUNT') return { ok: true };
  if (!Array.isArray(resultRows) || resultRows.length !== 1) return { ok: true };

  const row = resultRows[0] as Record<string, unknown>;
  const v = Object.values(row)[0];
  const got = Number(v);
  if (!Number.isFinite(got)) return { ok: true };

  const expected = entity.rowCount;
  // Trust the registry only when it has a non-trivial value.
  // Tables with reltuples == 0 might just be stats-stale, not empty.
  if (expected <= 5) return { ok: true };

  if (got < expected / 3 || got > expected * 3) {
    return {
      ok: false,
      reason: `count_mismatch: SQL returned ${got}, registry has ~${expected} rows in ${entity.table}`,
    };
  }
  return { ok: true };
}
