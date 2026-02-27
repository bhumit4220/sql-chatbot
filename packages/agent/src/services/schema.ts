import { Pool } from 'pg';

const SENSITIVE_PATTERNS = [
  'password', 'passwd', 'secret', 'token', 'ssn', 'social_security',
  'credit_card', 'card_number', 'cvv', 'pin', 'encrypted', 'hash',
  'salt', 'private_key', 'api_key', 'auth_key', 'access_key',
];

const TYPE_MAP: Record<string, string> = {
  'character varying': 'VARCHAR',
  'integer': 'INT',
  'bigint': 'BIGINT',
  'smallint': 'SMALLINT',
  'timestamp without time zone': 'TIMESTAMP',
  'timestamp with time zone': 'TIMESTAMPTZ',
  'numeric': 'DECIMAL',
  'boolean': 'BOOL',
  'text': 'TEXT',
  'date': 'DATE',
  'double precision': 'DOUBLE',
  'real': 'REAL',
  'uuid': 'UUID',
  'jsonb': 'JSONB',
  'json': 'JSON',
};

function mapType(pgType: string): string {
  return TYPE_MAP[pgType] || pgType.toUpperCase();
}

function isSensitive(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => {
    // Word-boundary matching: pattern must appear as a whole word segment
    // This avoids false positives like "pinned_at" matching "pin"
    const regex = new RegExp('(^|_)' + pattern + '($|_)');
    return regex.test(lower);
  });
}

interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface ForeignKey {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
}

export class SchemaService {
  private summary = '';
  private tables: string[] = [];

  async discover(databaseUrl: string): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      const [tablesRes, columnsRes, pksRes, fksRes] = await Promise.all([
        pool.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`
        ),
        pool.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public'
           ORDER BY table_name, ordinal_position`
        ),
        pool.query(
          `SELECT kcu.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.constraint_schema = kcu.constraint_schema
           WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`
        ),
        pool.query(
          `SELECT
             kcu.table_name AS from_table,
             kcu.column_name AS from_column,
             ccu.table_name AS to_table,
             ccu.column_name AS to_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.constraint_schema = kcu.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
             AND tc.constraint_schema = ccu.constraint_schema
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
        ),
      ]);

      const tableNames: string[] = tablesRes.rows.map((r: { table_name: string }) => r.table_name);

      // Index primary keys: Set of "table.column"
      const pkSet = new Set<string>(
        pksRes.rows.map((r: { table_name: string; column_name: string }) => `${r.table_name}.${r.column_name}`)
      );

      // Index foreign keys: Map of "table.column" → "target_table.target_column"
      const fkMap = new Map<string, string>(
        fksRes.rows.map((r: ForeignKey) => [`${r.from_table}.${r.from_column}`, `${r.to_table}.${r.to_column}`])
      );

      // Group columns by table
      const columnsByTable = new Map<string, ColumnInfo[]>();
      for (const col of columnsRes.rows as ColumnInfo[]) {
        if (!columnsByTable.has(col.table_name)) {
          columnsByTable.set(col.table_name, []);
        }
        columnsByTable.get(col.table_name)!.push(col);
      }

      // Build summary lines
      const lines: string[] = [];
      for (const table of tableNames) {
        const columns = columnsByTable.get(table) || [];
        const colParts: string[] = [];

        for (const col of columns) {
          if (isSensitive(col.column_name)) continue;

          const key = `${table}.${col.column_name}`;
          let part = `${col.column_name} ${mapType(col.data_type)}`;

          if (pkSet.has(key)) part += ' PK';
          if (fkMap.has(key)) part += ` FK→${fkMap.get(key)}`;

          colParts.push(part);
        }

        lines.push(`TABLE ${table} (${colParts.join(', ')})`);
      }

      this.tables = tableNames;
      this.summary = lines.join('\n');
    } finally {
      await pool.end();
    }
  }

  getSummary(): string {
    return this.summary;
  }

  tableCount(): number {
    return this.tables.length;
  }

  async refresh(databaseUrl: string): Promise<void> {
    await this.discover(databaseUrl);
  }
}
