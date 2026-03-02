import { Pool } from 'pg';

const SOFT_DELETE_COLUMNS = new Set([
  'deleted_at', 'discarded_at', 'archived_at', 'removed_at',
]);

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

      // Collect FK target tables for lookup value detection (DB-level FKs)
      const fkTargetTables = new Set<string>(
        fksRes.rows.map((r: ForeignKey) => r.to_table)
      );

      // Also detect convention-based references: *_id columns → plural table names
      // This catches Rails-style associations without DB-level FK constraints
      const tableNameSet = new Set(tableNames);
      for (const columns of columnsByTable.values()) {
        for (const col of columns) {
          if (col.column_name.endsWith('_id') && !pkSet.has(`${col.table_name}.${col.column_name}`)) {
            // category_id → categories (simple pluralize: add 's' or 'ies')
            const base = col.column_name.slice(0, -3); // remove '_id'
            const candidates = [
              base + 's',                                    // category → categorys (won't match but try)
              base.replace(/y$/, 'ie') + 's',               // category → categories
              base + 'es',                                   // status → statuses
              base,                                          // singular same as table name
            ];
            for (const candidate of candidates) {
              if (tableNameSet.has(candidate)) {
                fkTargetTables.add(candidate);
                break;
              }
            }
          }
        }
      }

      // Discover lookup values for small referenced tables
      const lookupValues = await this.discoverLookupValues(
        pool, fkTargetTables, columnsByTable, pkSet
      );

      // Build summary lines
      const lines: string[] = [];
      for (const table of tableNames) {
        const columns = columnsByTable.get(table) || [];
        const colParts: string[] = [];
        const annotations: string[] = [];

        // Track column names for polymorphic detection
        const colNameSet = new Map<string, string>(); // name → mapped type

        for (const col of columns) {
          if (isSensitive(col.column_name)) continue;

          const key = `${table}.${col.column_name}`;
          const mappedType = mapType(col.data_type);
          let part = `${col.column_name} ${mappedType}`;

          if (pkSet.has(key)) part += ' PK';
          if (fkMap.has(key)) part += ` FK→${fkMap.get(key)}`;

          colParts.push(part);
          colNameSet.set(col.column_name, mappedType);

          // Soft delete detection
          if (SOFT_DELETE_COLUMNS.has(col.column_name)) {
            annotations.push(`  -- SOFT DELETE: filter ${col.column_name} IS NULL for active records`);
          }
        }

        // Polymorphic association detection
        for (const [colName, colType] of colNameSet) {
          if (colName.endsWith('_type') && (colType === 'VARCHAR' || colType === 'TEXT')) {
            const prefix = colName.slice(0, -5); // remove '_type'
            const idCol = `${prefix}_id`;
            const idType = colNameSet.get(idCol);
            if (idType && (idType === 'INT' || idType === 'BIGINT')) {
              annotations.push(`  -- POLYMORPHIC: ${colName} + ${idCol} (join target depends on type value)`);
            }
          }
        }

        // Lookup values annotation
        if (lookupValues.has(table)) {
          annotations.push(`  -- VALUES: ${lookupValues.get(table)}`);
        }

        lines.push(`TABLE ${table} (${colParts.join(', ')})`);
        for (const ann of annotations) {
          lines.push(ann);
        }
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

  private async discoverLookupValues(
    pool: Pool,
    fkTargetTables: Set<string>,
    columnsByTable: Map<string, ColumnInfo[]>,
    pkSet: Set<string>,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (fkTargetTables.size === 0) return result;


    // Get approximate row counts from pg_stat_user_tables
    const statsRes = await pool.query(
      `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public'`
    );

    const rowCounts = new Map<string, number>(
      statsRes.rows.map((r: { relname: string; n_live_tup: string }) =>
        [r.relname, parseInt(r.n_live_tup, 10)]
      )
    );

    // For each FK-target table with < 50 rows, find display column and query values
    for (const table of fkTargetTables) {
      const count = rowCounts.get(table);
      if (count === undefined || count >= 50) continue;

      const columns = columnsByTable.get(table);
      if (!columns) continue;

      // Find PK column
      const pkCol = columns.find(c => pkSet.has(`${table}.${c.column_name}`));
      if (!pkCol) continue;

      // Find first VARCHAR/TEXT non-PK column as display value
      const displayCol = columns.find(c => {
        if (pkSet.has(`${table}.${c.column_name}`)) return false;
        const t = mapType(c.data_type);
        return t === 'VARCHAR' || t === 'TEXT';
      });
      if (!displayCol) continue;

      // Query actual values
      try {
        const valuesRes = await pool.query(
          `SELECT ${pkCol.column_name}, ${displayCol.column_name} FROM ${table} ORDER BY ${pkCol.column_name} LIMIT 50`
        );

        if (valuesRes.rows.length > 0) {
          const pairs = valuesRes.rows.map(
            (r: Record<string, unknown>) => `${r[pkCol.column_name]}=${r[displayCol.column_name]}`
          );
          result.set(table, pairs.join(', '));
        }
      } catch {
        // Skip tables that fail (e.g., permission issues)
      }
    }

    return result;
  }

  async refresh(databaseUrl: string): Promise<void> {
    await this.discover(databaseUrl);
  }
}
