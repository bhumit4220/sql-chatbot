import type pg from 'pg';
import type { SqlExecutionResult } from '@chatbot/shared';
import { validateSQL, MAX_SQL_ROWS } from '@chatbot/shared';

export async function executeSQL(
  pool: pg.Pool,
  sql: string,
  schema: Record<string, string[]>
): Promise<SqlExecutionResult> {
  const validation = validateSQL(sql, schema);
  if (!validation.isValid) {
    return {
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: 0,
      error: `SQL validation failed: ${validation.rejectionReason}`,
    };
  }

  const start = performance.now();
  const client = await pool.connect();
  try {
    await client.query('SET TRANSACTION READ ONLY');
    const result = await client.query(validation.modifiedSql);
    const elapsed = performance.now() - start;

    const columns = result.fields.map(f => f.name);
    const rows = result.rows.slice(0, MAX_SQL_ROWS);

    return {
      success: true,
      columns,
      rows,
      totalRowCount: result.rowCount || 0,
      executionTimeMs: Math.round(elapsed * 100) / 100,
    };
  } catch (e: any) {
    const elapsed = performance.now() - start;
    return {
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: Math.round(elapsed * 100) / 100,
      error: e.message,
    };
  } finally {
    client.release();
  }
}
