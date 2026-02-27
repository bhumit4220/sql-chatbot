import { Pool } from 'pg';

// ============================================================
// Types
// ============================================================

export interface ValidationResult {
  valid: boolean;
  sql?: string;
  reason?: string;
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
}

// ============================================================
// Blocklists (word-boundary matched)
// ============================================================

const KEYWORD_BLOCKLIST = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
  'GRANT', 'TRUNCATE', 'EXECUTE', 'REVOKE', 'COPY',
];

const FUNCTION_BLOCKLIST = [
  'pg_read_file', 'pg_read_binary_file', 'dblink',
  'pg_terminate_backend', 'lo_import', 'lo_export',
  'pg_sleep', 'set_config', 'current_setting',
];

const CATALOG_BLOCKLIST = [
  'pg_shadow', 'pg_roles', 'pg_authid', 'pg_user',
];

const AGGREGATE_PATTERN = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;

// ============================================================
// validateSql
// ============================================================

export function validateSql(sql: string): ValidationResult {
  // Strip leading whitespace and SQL comments
  let trimmed = sql.replace(/^\s+/, '');
  trimmed = trimmed.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  trimmed = trimmed.trim();

  // 1. Must be a single statement: reject if contains `;` followed by another statement
  const parts = trimmed.split(';').filter((p) => p.trim().length > 0);
  if (parts.length > 1) {
    return { valid: false, reason: 'Only a single statement is allowed' };
  }

  // Remove trailing semicolon for the working copy
  let workingSql = trimmed.replace(/;\s*$/, '').trim();

  // 2. Must start with SELECT
  if (!/^SELECT\b/i.test(workingSql)) {
    return { valid: false, reason: 'Only SELECT queries are allowed' };
  }

  // 3. Keyword blocklist (word-boundary matching)
  for (const keyword of KEYWORD_BLOCKLIST) {
    const regex = new RegExp('\\b' + keyword + '\\b', 'i');
    if (regex.test(workingSql)) {
      return { valid: false, reason: `Blocked keyword: ${keyword}` };
    }
  }

  // 4. Function blocklist (word-boundary matching)
  for (const fn of FUNCTION_BLOCKLIST) {
    const regex = new RegExp('\\b' + fn + '\\b', 'i');
    if (regex.test(workingSql)) {
      return { valid: false, reason: `Blocked function: ${fn}` };
    }
  }

  // 5. System catalog blocklist (word-boundary matching)
  for (const catalog of CATALOG_BLOCKLIST) {
    const regex = new RegExp('\\b' + catalog + '\\b', 'i');
    if (regex.test(workingSql)) {
      return { valid: false, reason: `Blocked system catalog: ${catalog}` };
    }
  }

  // 6. Auto-add LIMIT 500 if no LIMIT clause present
  //    Skip for aggregate queries (COUNT/SUM/AVG/MIN/MAX) without GROUP BY having a LIMIT
  const hasLimit = /\bLIMIT\b/i.test(workingSql);
  const isAggregate = AGGREGATE_PATTERN.test(workingSql);

  if (!hasLimit && !isAggregate) {
    workingSql = workingSql + ' LIMIT 500';
  }

  return { valid: true, sql: workingSql };
}

// ============================================================
// executeSql
// ============================================================

export async function executeSql(databaseUrl: string, sql: string): Promise<SqlResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("SET statement_timeout = '10s'");
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    const result = await client.query(sql);

    await client.query('COMMIT');

    return {
      columns: result.fields.map((f: { name: string }) => f.name),
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
