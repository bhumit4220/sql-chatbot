import type pg from 'pg';

export interface EnumCandidate {
  table: string;
  column: string;
  distinctValues: number[];
  sampleSize: number;
}

/**
 * Detects columns that look like integer enums:
 * - integer type
 * - low cardinality (< 30 distinct values)
 * - not a FK or PK
 */
export async function detectEnumCandidates(
  pool: pg.Pool,
  excludePks: Set<string>,
  excludeFks: Set<string>
): Promise<EnumCandidate[]> {
  const client = await pool.connect();
  try {
    // Get all integer columns from public tables
    const colsResult = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('integer', 'smallint', 'bigint')
      ORDER BY table_name, column_name
    `);

    const candidates: EnumCandidate[] = [];

    for (const row of colsResult.rows) {
      const key = `${row.table_name}.${row.column_name}`;
      if (excludePks.has(key) || excludeFks.has(key)) continue;

      // Check distinct value count
      const distinctResult = await client.query(`
        SELECT DISTINCT "${row.column_name}" as val
        FROM "${row.table_name}"
        WHERE "${row.column_name}" IS NOT NULL
        ORDER BY val
        LIMIT 31
      `);

      if (distinctResult.rows.length > 0 && distinctResult.rows.length <= 30) {
        candidates.push({
          table: row.table_name,
          column: row.column_name,
          distinctValues: distinctResult.rows.map(r => r.val),
          sampleSize: distinctResult.rows.length,
        });
      }
    }

    return candidates;
  } finally {
    client.release();
  }
}
