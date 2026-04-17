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
  udt_name: string;
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
  private perTableSchemas: Map<string, string> = new Map();
  private tableIndex: Map<string, string[]> = new Map();
  private fkGraph: Map<string, Array<{ fromCol: string; toTable: string; toCol: string }>> = new Map();

  async discover(databaseUrl: string): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      const [tablesRes, columnsRes, pksRes, fksRes, enumsRes, checksRes] = await Promise.all([
        pool.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`
        ),
        pool.query(
          `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
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
        pool.query(
          `SELECT t.typname AS enum_name, e.enumlabel AS enum_value
           FROM pg_enum e
           JOIN pg_type t ON e.enumtypid = t.oid
           ORDER BY t.typname, e.enumsortorder`
        ),
        pool.query(
          `SELECT conrelid::regclass AS table_name, pg_get_constraintdef(oid) AS check_def
           FROM pg_constraint
           WHERE contype = 'c' AND connamespace = 'public'::regnamespace`
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

      // Index enum types: enum_name → ordered list of values
      const enumMap = new Map<string, string[]>();
      for (const row of enumsRes.rows as { enum_name: string; enum_value: string }[]) {
        if (!enumMap.has(row.enum_name)) {
          enumMap.set(row.enum_name, []);
        }
        enumMap.get(row.enum_name)!.push(row.enum_value);
      }

      // Parse check constraints for IN (...) or ANY(ARRAY[...]) patterns → "table.column" → values[]
      const checkEnumMap = new Map<string, string[]>();
      for (const row of checksRes.rows as { table_name: string; check_def: string }[]) {
        // Format 1: ((col)::text = ANY ((ARRAY['a'::varchar, 'b'::varchar])::text[]))
        // Format 2: (col IN ('a', 'b', 'c'))
        const match = row.check_def.match(
          /\(\((\w+)\)::\w+\s*=\s*ANY\s*\(\(?ARRAY\[([^\]]+)\]/i
        ) || row.check_def.match(
          /\((\w+)\s+IN\s*\(([^)]+)\)/i
        );
        if (!match) continue;
        const colName = match[1];
        const valuesStr = match[2];
        if (!valuesStr) continue;
        const values = valuesStr
          .split(',')
          .map(v => v.trim().replace(/^'([^']*)'(?:::\w+.*)?$/, '$1').trim())
          .filter(v => v.length > 0);
        if (values.length > 0) {
          checkEnumMap.set(`${row.table_name}.${colName}`, values);
        }
      }

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

      // Get approximate row counts for all tables (helps LLM distinguish data vs config tables)
      const rowCountRes = await pool.query(
        `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public'`
      );
      const rowCounts = new Map<string, number>(
        rowCountRes.rows.map((r: { relname: string; n_live_tup: string }) =>
          [r.relname, parseInt(r.n_live_tup, 10)]
        )
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
          const enumValues = (col.data_type === 'USER-DEFINED' && col.udt_name
            ? enumMap.get(col.udt_name) : undefined)
            || checkEnumMap.get(key);
          const mappedType = enumValues
            ? `ENUM(${enumValues.join(',')})`
            : mapType(col.data_type);
          let part = `${col.column_name} ${mappedType}`;

          if (pkSet.has(key)) part += ' PK';
          if (fkMap.has(key)) part += ` FK→${fkMap.get(key)}`;

          colParts.push(part);
          colNameSet.set(col.column_name, mappedType);

          // Soft delete detection
          if (SOFT_DELETE_COLUMNS.has(col.column_name)) {
            annotations.push(`  -- SOFT DELETE: filter ${col.column_name} IS NULL for active records`);
          }

          // Enum value annotation
          if (enumValues) {
            annotations.push(`  -- ENUM: ${col.column_name} values: ${enumValues.join(', ')}`);
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

        const count = rowCounts.get(table);
        const countHint = count !== undefined ? ` (~${count} rows)` : '';
        lines.push(`TABLE ${table}${countHint} (${colParts.join(', ')})`);
        for (const ann of annotations) {
          lines.push(ann);
        }
      }

      this.tables = tableNames;
      this.summary = lines.join('\n');
      this.buildPerTableSchemas(lines);
      this.buildTableIndex(columnsRes.rows);
      this.buildFkGraph(fksRes.rows, columnsRes.rows, new Set(tableNames));
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

  getTableNames(): string {
    if (this.tables.length === 0) return '';
    return `Available tables: ${this.tables.join(', ')}`;
  }

  /**
   * Scan FK LOOKUP and RAILS ENUM annotations for values that match words in the question.
   * Returns array of hint strings like:
   *   "The user mentions 'movies'. In the titles table, use WHERE category_id = 2 (Movie)."
   *   "The user mentions 'active'. In the contractors table, use WHERE status = 1 (Active)."
   */
  findLookupHints(question: string): string[] {
    if (!this.summary) return [];

    const stopWords = new Set(['a','an','the','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','shall','should','may','might','can','could','how','what','when','where','who','which','why','not','and','or','but','if','then','else','for','from','by','with','at','in','on','to','of','it','its','this','that','these','those','many','much','there','some','all','any','each','every','no','me','my','show','get','list','find','give','tell']);
    const words = question.toLowerCase().split(/\W+/).filter(w => w.length >= 2 && !stopWords.has(w));
    const hints: string[] = [];
    let currentTable: string | null = null;

    for (const line of this.summary.split('\n')) {
      const tableMatch = line.match(/^TABLE (\S+)/);
      if (tableMatch) {
        currentTable = tableMatch[1];
      } else if (line.includes('FK LOOKUP:') && currentTable) {
        const match = line.match(/FK LOOKUP:\s+(\S+).*?values:\s+(.+)/);
        if (!match) continue;

        const fkCol = match[1];
        const pairs = match[2].split(',').map(s => s.trim());
        for (const pair of pairs) {
          const [id, name] = pair.split('=', 2);
          if (!name) continue;
          const cleanName = name.trim();
          if (cleanName.length < 2) continue;

          const nameWords = cleanName.toLowerCase().split(/\W+/).filter(w => w.length > 0);
          const nameLower = cleanName.toLowerCase();
          const matchedWord = words.find(w =>
            nameWords.includes(w) || nameLower === w ||
            (cleanName.length >= 3 && nameLower.startsWith(w)) ||
            (w.length >= 3 && w.startsWith(nameLower))
          );
          if (matchedWord) {
            hints.push(`The user mentions "${matchedWord}". In the ${currentTable} table, use WHERE ${fkCol} = ${id.trim()} (${cleanName}).`);
          }
        }
      } else if (line.includes('RAILS ENUM:') && currentTable) {
        const match = line.match(/RAILS ENUM:\s+(\S+)\s+values:\s+(.+)/);
        if (!match) continue;

        const col = match[1];
        const pairs = match[2].split(',').map(s => s.trim());
        for (const pair of pairs) {
          const [label, num] = pair.split('=', 2);
          if (!label || !num) continue;
          const cleanLabel = label.trim();
          if (cleanLabel.length < 2) continue;

          const labelWords = cleanLabel.toLowerCase().split(/\W+/).filter(w => w.length > 0);
          const labelLower = cleanLabel.toLowerCase();
          const matchedWord = words.find(w =>
            labelWords.includes(w) || labelLower === w ||
            (cleanLabel.length >= 3 && labelLower.startsWith(w)) ||
            (w.length >= 3 && w.startsWith(labelLower))
          );
          if (matchedWord) {
            hints.push(`The user mentions "${matchedWord}". In the ${currentTable} table, use WHERE ${col} = ${num.trim()} (${cleanLabel}).`);
          }
        }
      }
    }

    return [...new Set(hints)].slice(0, 15);
  }

  /**
   * Extract RAILS ENUM annotations from a schema string for the answer prompt.
   * Returns a string like:
   *   "contractors.status: Active=1, Inactive=2, Deleted=3\njobs.status: Active=1, ..."
   */
  extractEnumContext(schemaText?: string): string {
    const source = schemaText ?? this.summary;
    if (!source) return '';

    const lines: string[] = [];
    let currentTable: string | null = null;

    for (const line of source.split('\n')) {
      const tableMatch = line.match(/^TABLE (\S+)/);
      if (tableMatch) {
        currentTable = tableMatch[1];
      } else if (line.includes('RAILS ENUM:') && currentTable) {
        const match = line.match(/RAILS ENUM:\s+(\S+)\s+values:\s+(.+)/);
        if (!match) continue;
        lines.push(`${currentTable}.${match[1]}: ${match[2]}`);
      }
    }

    return lines.join('\n');
  }

  selectSchema(terms: string[]): string {
    if (this.perTableSchemas.size === 0) return this.summary;

    // Step 1: Score tables by relevance to search terms
    const scores = this.scoreTables(terms);

    // Step 2: Fallback to hub tables if no matches
    if (scores.size === 0) {
      const hubs = this.hubTables(8);
      for (const t of hubs) scores.set(t, 1);
    }

    // Step 3: Take top 8 tables by score (cap to avoid overwhelming the LLM)
    const MAX_PRIMARY = 8;
    const topTables = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PRIMARY)
      .map(([t]) => t);

    // Step 4: Find FK join paths between top tables (add bridge tables)
    const allTables = new Set(topTables);
    for (let i = 0; i < topTables.length; i++) {
      for (let j = i + 1; j < topTables.length; j++) {
        const bridge = this.findJoinPath(topTables[i], topTables[j]);
        if (bridge) bridge.forEach(t => allTables.add(t));
      }
    }

    // Step 5: Cap total at 12 (primary + bridge)
    const MAX_TOTAL = 12;
    const finalTables = allTables.size <= MAX_TOTAL
      ? Array.from(allTables)
      : [...topTables, ...Array.from(allTables).filter(t => !topTables.includes(t))].slice(0, MAX_TOTAL);

    // Step 6: Build schema string preserving original table order
    return this.tables
      .filter(t => finalTables.includes(t))
      .map(t => this.perTableSchemas.get(t))
      .filter(Boolean)
      .join('\n');
  }

  private scoreTables(terms: string[]): Map<string, number> {
    const scores = new Map<string, number>();
    const lowerTerms = terms.map(t => t.toLowerCase());

    const addScore = (table: string, points: number) => {
      scores.set(table, (scores.get(table) ?? 0) + points);
    };

    for (const term of lowerTerms) {
      for (const table of this.tables) {
        // Exact match (highest priority)
        if (table === term) {
          addScore(table, 10);
          continue;
        }
        // Singular/plural match
        if (this.singularize(table) === term || this.pluralize(table) === term ||
            this.singularize(term) === table || this.pluralize(term) === table) {
          addScore(table, 8);
          continue;
        }
        // Django-style prefix match: term "order" matches "order_order", "order_orderline"
        // Primary table (app_model where model contains term) gets higher score
        const parts = table.split('_');
        if (parts.length >= 2) {
          const appName = parts[0];
          const modelName = parts.slice(1).join('_');
          if (appName === term) {
            // "order" matches "order_order" (primary) vs "order_orderevent" (secondary)
            addScore(table, modelName === term || modelName === appName ? 7 : 4);
            continue;
          }
          if (modelName === term || this.singularize(modelName) === term || this.pluralize(modelName) === term) {
            addScore(table, 6);
            continue;
          }
        }
        // General substring match (lower priority)
        if (table.includes(term) && term.length >= 3) {
          addScore(table, 2);
        }
      }

      // Column name match (lowest priority for table selection)
      for (const [colName, tables] of this.tableIndex) {
        if (colName === term || colName === `${term}_id`) {
          for (const t of tables) addScore(t, 3);
        }
      }
    }

    return scores;
  }

  private hubTables(limit: number): string[] {
    const edgeCounts = new Map<string, number>();
    for (const table of this.tables) {
      edgeCounts.set(table, this.fkGraph.get(table)?.length ?? 0);
    }
    return this.tables
      .slice()
      .sort((a, b) => (edgeCounts.get(b) ?? 0) - (edgeCounts.get(a) ?? 0))
      .slice(0, limit);
  }

  private findJoinPath(from: string, to: string, maxDepth = 2): string[] | null {
    if (from === to) return [];

    // BFS
    const queue: Array<{ table: string; path: string[] }> = [{ table: from, path: [] }];
    const visited = new Set<string>([from]);

    while (queue.length > 0) {
      const { table, path } = queue.shift()!;
      if (path.length >= maxDepth) continue;

      const edges = this.fkGraph.get(table) ?? [];
      for (const edge of edges) {
        const neighbor = edge.toTable;
        if (neighbor === to) {
          return path; // bridge tables (excluding from and to)
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ table: neighbor, path: [...path, neighbor] });
        }
      }
    }

    return null;
  }

  private buildPerTableSchemas(lines: string[]): void {
    this.perTableSchemas.clear();
    let currentTable: string | null = null;
    const tableLines: string[] = [];

    const flush = () => {
      if (currentTable && tableLines.length > 0) {
        this.perTableSchemas.set(currentTable, tableLines.join('\n'));
      }
    };

    for (const line of lines) {
      const match = line.match(/^TABLE (\w+)/);
      if (match) {
        flush();
        currentTable = match[1];
        tableLines.length = 0;
        tableLines.push(line);
      } else if (currentTable) {
        tableLines.push(line);
      }
    }
    flush();
  }

  private buildTableIndex(rows: ColumnInfo[]): void {
    this.tableIndex.clear();
    for (const row of rows) {
      const col = row.column_name;
      if (!this.tableIndex.has(col)) {
        this.tableIndex.set(col, []);
      }
      this.tableIndex.get(col)!.push(row.table_name);
    }
  }

  private buildFkGraph(
    fkRows: ForeignKey[],
    _colRows: ColumnInfo[],
    tableNames: Set<string>,
  ): void {
    this.fkGraph.clear();

    // Initialize all tables
    for (const table of tableNames) {
      this.fkGraph.set(table, []);
    }

    // Add bidirectional FK edges
    for (const fk of fkRows) {
      // Forward: from_table → to_table
      if (!this.fkGraph.has(fk.from_table)) this.fkGraph.set(fk.from_table, []);
      this.fkGraph.get(fk.from_table)!.push({
        fromCol: fk.from_column,
        toTable: fk.to_table,
        toCol: fk.to_column,
      });

      // Reverse: to_table → from_table
      if (!this.fkGraph.has(fk.to_table)) this.fkGraph.set(fk.to_table, []);
      this.fkGraph.get(fk.to_table)!.push({
        fromCol: fk.to_column,
        toTable: fk.from_table,
        toCol: fk.from_column,
      });
    }
  }

  private singularize(word: string): string {
    if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }

  private pluralize(word: string): string {
    if (word.endsWith('y') && !['ay', 'ey', 'iy', 'oy', 'uy'].some(e => word.endsWith(e))) {
      return word.slice(0, -1) + 'ies';
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') ||
        word.endsWith('ch') || word.endsWith('sh')) {
      return word + 'es';
    }
    return word + 's';
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
