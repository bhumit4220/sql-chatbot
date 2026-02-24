import type pg from 'pg';
import type { TableSchema, ColumnInfo, ForeignKeyInfo } from '@chatbot/shared';

const SENSITIVE_COLUMN_PATTERNS = [
  'password', 'pwd', 'token', 'secret', 'ssn', 'api_key', 'salt',
  'encr_', 'stripe_', 'bank_',
];

function isSensitiveColumn(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_COLUMN_PATTERNS.some(p => lower.includes(p));
}

export async function inspectSchema(pool: pg.Pool): Promise<TableSchema[]> {
  const client = await pool.connect();
  try {
    const tablesResult = await client.query(`
      SELECT table_name, obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass) as comment
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables: TableSchema[] = [];

    for (const tableRow of tablesResult.rows) {
      const tableName = tableRow.table_name;

      const colsResult = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default,
          col_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, ordinal_position) as comment
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      const columns: ColumnInfo[] = colsResult.rows
        .filter(c => !isSensitiveColumn(c.column_name))
        .map(c => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: false,
          comment: c.comment || undefined,
        }));

      const pkResult = await client.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
      `, [tableName]);
      const pkColumns = new Set(pkResult.rows.map(r => r.attname));
      for (const col of columns) {
        col.isPrimaryKey = pkColumns.has(col.name);
      }

      const fkResult = await client.query(`
        SELECT
          kcu.column_name,
          ccu.table_name AS referred_table,
          ccu.column_name AS referred_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
      `, [tableName]);

      const foreignKeys: ForeignKeyInfo[] = fkResult.rows.map(r => ({
        column: r.column_name,
        referredTable: r.referred_table,
        referredColumn: r.referred_column,
      }));

      tables.push({
        name: tableName,
        columns,
        primaryKeys: Array.from(pkColumns),
        foreignKeys,
        comment: tableRow.comment || undefined,
      });
    }

    return tables;
  } finally {
    client.release();
  }
}

export function formatSchemaForPrompt(tables: TableSchema[]): string {
  return tables.map(t => {
    const cols = t.columns.map(c => c.name).join(', ');
    return `TABLE ${t.name} (${cols})`;
  }).join('\n');
}
