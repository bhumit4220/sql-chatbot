import { Parser } from 'node-sql-parser';
import type { SqlValidationResult } from '../types/db.js';

const MAX_LIMIT = 500;

const BLOCKED_FUNCTIONS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export',
  'dblink', 'dblink_exec',
  'pg_sleep', 'pg_sleep_for',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'current_setting',
]);

const BLOCKED_SYSTEM_TABLES = new Set([
  'pg_stat_activity', 'pg_roles', 'pg_shadow', 'pg_authid',
  'pg_user', 'pg_group',
]);

interface ValidateOptions {
  excludeTables?: string[];
}

export function validateSQL(
  sql: string,
  schema: Record<string, string[]>,
  options: ValidateOptions = {}
): SqlValidationResult {
  const result: SqlValidationResult = { isValid: false, modifiedSql: '', rejectionReason: '' };
  const sqlTrimmed = sql.trim().replace(/;+$/, '');

  // Layer 1: Parse with node-sql-parser (PostgreSQL dialect)
  const parser = new Parser();
  let ast;
  try {
    ast = parser.astify(sqlTrimmed, { database: 'PostgresQL' });
  } catch (e: any) {
    result.rejectionReason = `SQL parse error: ${e.message}`;
    return result;
  }

  // Layer 2: Must be a single statement
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    result.rejectionReason = 'Multiple statements detected. Only single SELECT allowed.';
    return result;
  }

  const stmt = statements[0];

  // Layer 3: ALLOWLIST — must be SELECT (not insert/update/delete/create/drop/alter/truncate)
  if (stmt.type !== 'select') {
    result.rejectionReason = `Only SELECT statements allowed. Got: ${stmt.type?.toUpperCase()}`;
    return result;
  }

  // Layer 4: Walk AST to check for blocked patterns
  const sqlLower = sqlTrimmed.toLowerCase();

  // Check for SELECT INTO
  if (/\binto\s+\w+/i.test(sqlTrimmed) && /\bselect\b.*\binto\b/i.test(sqlTrimmed)) {
    result.rejectionReason = 'SELECT INTO not allowed';
    return result;
  }

  // Check for CTE mutations (WITH ... DELETE/INSERT/UPDATE)
  if (/\bwith\b/i.test(sqlTrimmed)) {
    if (/\b(insert|update|delete|truncate|drop|create|alter)\b/i.test(sqlTrimmed)) {
      result.rejectionReason = 'CTE with mutation (INSERT/UPDATE/DELETE) not allowed';
      return result;
    }
  }

  // Layer 5: Blocked functions
  for (const func of BLOCKED_FUNCTIONS) {
    if (sqlLower.includes(func)) {
      result.rejectionReason = `Blocked function: ${func}`;
      return result;
    }
  }

  // Layer 6: System catalog access
  for (const table of BLOCKED_SYSTEM_TABLES) {
    if (sqlLower.includes(table)) {
      result.rejectionReason = `Blocked system catalog: ${table}`;
      return result;
    }
  }
  if (sqlLower.includes('information_schema')) {
    result.rejectionReason = 'Blocked system catalog: information_schema';
    return result;
  }

  // Layer 7: Excluded tables
  const excludeSet = new Set((options.excludeTables || []).map(t => t.toLowerCase()));
  if (excludeSet.size > 0) {
    const tablePattern = /(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
    let match;
    while ((match = tablePattern.exec(sqlTrimmed)) !== null) {
      if (excludeSet.has(match[1].toLowerCase())) {
        result.rejectionReason = `Table '${match[1]}' is excluded from queries`;
        return result;
      }
    }
  }

  // Layer 8: Add LIMIT if missing
  let modifiedSql = sqlTrimmed;
  if (!/\blimit\b/i.test(sqlTrimmed)) {
    modifiedSql = `${sqlTrimmed} LIMIT ${MAX_LIMIT}`;
  }

  result.isValid = true;
  result.modifiedSql = modifiedSql;
  return result;
}
