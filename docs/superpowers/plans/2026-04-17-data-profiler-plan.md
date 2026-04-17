# Data Profiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add framework-agnostic column profiling to the npm package's SchemaService that queries actual data values for enum-like columns and annotates the schema, fixing accuracy gaps on Go/Django/Laravel apps.

**Architecture:** A single new private method `profileColumns()` in `SchemaService` runs during `discover()`. It identifies candidate columns (named discriminators like `type`/`status` + low-cardinality integer columns), queries their distinct values with counts via `GROUP BY`, and injects `-- DATA VALUES:` annotations into the schema summary. Capped at 50 columns for performance.

**Tech Stack:** TypeScript, Vitest, PostgreSQL (pg), existing SchemaService patterns

---

### Task 1: Write failing tests for data profiler

**Files:**
- Modify: `packages/agent/src/__tests__/schema.test.ts`

The `setupMockQuery` function routes SQL strings to mock results. Profiler queries will use `GROUP BY` + `COUNT(*)`, so we match on `GROUP BY` in the SQL. We also need a `COUNT(DISTINCT` query for the cardinality check on non-named columns.

- [ ] **Step 1: Add profiler mock support to setupMockQuery**

In `packages/agent/src/__tests__/schema.test.ts`, add a `profileResults` parameter to `setupMockQuery`. Find the function signature at line ~54 and add the new parameter to `overrides`:

```typescript
// Add to the overrides type (around line 55):
profileResults?: Record<string, { rows: { value: string; cnt: string }[] }>;
cardinalityResults?: Record<string, { rows: { count: string }[] }>;
```

Then in the `mockQuery.mockImplementation` block (around line 89, before the final `return`), add:

```typescript
    // Match cardinality check queries: SELECT COUNT(DISTINCT col) ...
    if (sql.includes('COUNT(DISTINCT')) {
      for (const [key, result] of Object.entries(cardinalityResults)) {
        if (sql.includes(key)) {
          return Promise.resolve(result);
        }
      }
      return Promise.resolve({ rows: [{ count: '999' }] });
    }
    // Match profiler queries: SELECT col::text ... GROUP BY
    if (sql.includes('GROUP BY') && !sql.includes('information_schema')) {
      for (const [key, result] of Object.entries(profileResults)) {
        if (sql.includes(key)) {
          return Promise.resolve(result);
        }
      }
    }
```

Also add the defaults at the top of the function body (around line 70):

```typescript
  const profileResults = overrides.profileResults ?? {};
  const cardinalityResults = overrides.cardinalityResults ?? {};
```

- [ ] **Step 2: Write test — named discriminator column gets profiled**

Add this test in the main `describe('SchemaService', ...)` block:

```typescript
  it('profiles named discriminator columns with DATA VALUES annotation', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'user' }] },
      columns: { rows: [
        { table_name: 'user', column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', column_default: null },
        { table_name: 'user', column_name: 'name', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null },
        { table_name: 'user', column_name: 'type', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
      ] },
      primaryKeys: { rows: [{ table_name: 'user', column_name: 'id' }] },
      foreignKeys: { rows: [] },
      rowCounts: { rows: [{ relname: 'user', n_live_tup: '9' }] },
      profileResults: {
        'user': { rows: [
          { value: '0', cnt: '6' },
          { value: '1', cnt: '3' },
        ] },
      },
    });

    await service.discover('postgres://localhost/testdb');
    const summary = service.getSummary();
    expect(summary).toContain('-- DATA VALUES: type');
    expect(summary).toContain('0 (6 rows)');
    expect(summary).toContain('1 (3 rows)');
  });
```

- [ ] **Step 3: Write test — PK and FK columns are NOT profiled**

```typescript
  it('does not profile primary key or foreign key columns', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'orders' }, { table_name: 'users' }] },
      columns: { rows: [
        { table_name: 'orders', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'orders', column_name: 'status', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'orders', column_name: 'user_id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'users', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'users', column_name: 'name', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null },
      ] },
      primaryKeys: { rows: [
        { table_name: 'orders', column_name: 'id' },
        { table_name: 'users', column_name: 'id' },
      ] },
      foreignKeys: { rows: [
        { from_table: 'orders', from_column: 'user_id', to_table: 'users', to_column: 'id' },
      ] },
      rowCounts: { rows: [
        { relname: 'orders', n_live_tup: '100' },
        { relname: 'users', n_live_tup: '10' },
      ] },
      profileResults: {
        'orders': { rows: [
          { value: '1', cnt: '60' },
          { value: '2', cnt: '30' },
          { value: '3', cnt: '10' },
        ] },
      },
    });

    await service.discover('postgres://localhost/testdb');
    const summary = service.getSummary();
    // status IS profiled (named discriminator, not PK, not FK)
    expect(summary).toContain('-- DATA VALUES: status');
    // id and user_id should NOT be profiled
    expect(summary).not.toContain('DATA VALUES: id');
    expect(summary).not.toContain('DATA VALUES: user_id');
  });
```

- [ ] **Step 4: Write test — columns with existing ENUM annotation are NOT profiled**

```typescript
  it('does not profile columns already annotated with PG ENUM or CHECK ENUM', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'tickets' }] },
      columns: { rows: [
        { table_name: 'tickets', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'tickets', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'ticket_status', is_nullable: 'NO', column_default: null },
        { table_name: 'tickets', column_name: 'priority', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
      ] },
      primaryKeys: { rows: [{ table_name: 'tickets', column_name: 'id' }] },
      foreignKeys: { rows: [] },
      enums: { rows: [
        { enum_name: 'ticket_status', enum_value: 'open' },
        { enum_name: 'ticket_status', enum_value: 'closed' },
      ] },
      rowCounts: { rows: [{ relname: 'tickets', n_live_tup: '50' }] },
      profileResults: {
        'tickets': { rows: [
          { value: '1', cnt: '30' },
          { value: '2', cnt: '15' },
          { value: '3', cnt: '5' },
        ] },
      },
    });

    await service.discover('postgres://localhost/testdb');
    const summary = service.getSummary();
    // status already has PG ENUM annotation — should NOT get DATA VALUES
    expect(summary).toContain('ENUM(open,closed)');
    expect(summary).not.toContain('DATA VALUES: status');
    // priority IS profiled (no existing annotation, named discriminator)
    expect(summary).toContain('-- DATA VALUES: priority');
  });
```

- [ ] **Step 5: Write test — empty tables are NOT profiled**

```typescript
  it('does not profile columns in tables with 0 rows', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'settings' }] },
      columns: { rows: [
        { table_name: 'settings', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'settings', column_name: 'type', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
      ] },
      primaryKeys: { rows: [{ table_name: 'settings', column_name: 'id' }] },
      foreignKeys: { rows: [] },
      rowCounts: { rows: [{ relname: 'settings', n_live_tup: '0' }] },
    });

    await service.discover('postgres://localhost/testdb');
    const summary = service.getSummary();
    expect(summary).not.toContain('DATA VALUES');
  });
```

- [ ] **Step 6: Write test — 50-column cap is enforced**

```typescript
  it('caps profiling at 50 columns total', async () => {
    // Create 60 tables, each with a 'type' column
    const tableRows = Array.from({ length: 60 }, (_, i) => ({ table_name: `t${i}` }));
    const columnRows = tableRows.flatMap(t => [
      { table_name: t.table_name, column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
      { table_name: t.table_name, column_name: 'type', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
    ]);
    const pkRows = tableRows.map(t => ({ table_name: t.table_name, column_name: 'id' }));
    const rowCountRows = tableRows.map(t => ({ relname: t.table_name, n_live_tup: '10' }));

    const profileResults: Record<string, { rows: { value: string; cnt: string }[] }> = {};
    for (const t of tableRows) {
      profileResults[t.table_name] = { rows: [{ value: '1', cnt: '5' }, { value: '2', cnt: '5' }] };
    }

    setupMockQuery({
      tables: { rows: tableRows },
      columns: { rows: columnRows },
      primaryKeys: { rows: pkRows },
      foreignKeys: { rows: [] },
      rowCounts: { rows: rowCountRows },
      profileResults,
    });

    await service.discover('postgres://localhost/testdb');
    const summary = service.getSummary();
    const dataValueCount = (summary.match(/DATA VALUES/g) || []).length;
    expect(dataValueCount).toBeLessThanOrEqual(50);
  });
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent" && npx vitest run src/__tests__/schema.test.ts 2>&1 | tail -20`
Expected: 5 new tests FAIL (no `profileColumns` method, no `DATA VALUES` annotations)

---

### Task 2: Implement profileColumns method

**Files:**
- Modify: `packages/agent/src/services/schema.ts`

- [ ] **Step 1: Add DISCRIMINATOR_NAMES constant**

At the top of `packages/agent/src/services/schema.ts`, after the `SENSITIVE_PATTERNS` array (around line 11), add:

```typescript
const DISCRIMINATOR_NAMES = new Set([
  'type', 'status', 'kind', 'role', 'state', 'category',
  'level', 'priority', 'mode', 'source',
]);

function isDiscriminatorName(colName: string): boolean {
  if (DISCRIMINATOR_NAMES.has(colName)) return true;
  // Also match suffixed variants: user_type, account_status, etc.
  for (const name of DISCRIMINATOR_NAMES) {
    if (colName.endsWith(`_${name}`)) return true;
  }
  return false;
}
```

- [ ] **Step 2: Add profileColumns private method**

Add this method to the `SchemaService` class, after the `discoverLookupValues` method (around line 680):

```typescript
  private async profileColumns(
    pool: Pool,
    columnsByTable: Map<string, ColumnInfo[]>,
    tableNames: string[],
    pkSet: Set<string>,
    fkMap: Map<string, string>,
    rowCounts: Map<string, number>,
    annotatedColumns: Set<string>,
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const MAX_PROFILE_COLUMNS = 50;
    let profiledCount = 0;

    // Collect candidates: [table, column, isNamedDiscriminator]
    const candidates: Array<{ table: string; col: ColumnInfo; named: boolean }> = [];

    for (const table of tableNames) {
      const count = rowCounts.get(table);
      if (count === undefined || count === 0) continue;

      const columns = columnsByTable.get(table) || [];
      for (const col of columns) {
        const key = `${table}.${col.column_name}`;
        // Skip PKs, FKs, already-annotated, sensitive
        if (pkSet.has(key)) continue;
        if (fkMap.has(key)) continue;
        if (annotatedColumns.has(key)) continue;
        if (isSensitive(col.column_name)) continue;

        const mappedType = mapType(col.data_type);
        // Only profile INT, SMALLINT, BIGINT, VARCHAR, TEXT
        if (!['INT', 'SMALLINT', 'BIGINT', 'VARCHAR', 'TEXT'].includes(mappedType)) continue;

        if (isDiscriminatorName(col.column_name)) {
          candidates.push({ table, col, named: true });
        } else if (mappedType === 'INT' || mappedType === 'SMALLINT') {
          candidates.push({ table, col, named: false });
        }
      }
    }

    // Sort: named discriminators first (higher priority)
    candidates.sort((a, b) => (a.named === b.named ? 0 : a.named ? -1 : 1));

    for (const { table, col, named } of candidates) {
      if (profiledCount >= MAX_PROFILE_COLUMNS) break;

      // For non-named columns, check cardinality first
      if (!named) {
        try {
          const cardRes = await pool.query(
            `SELECT COUNT(DISTINCT "${col.column_name}") AS count FROM "${table}"`
          );
          const distinctCount = parseInt(cardRes.rows[0]?.count ?? '999', 10);
          if (distinctCount > 20) continue;
        } catch {
          continue;
        }
      }

      // Profile: get distinct values with counts
      try {
        const profRes = await pool.query(
          `SELECT "${col.column_name}"::text AS value, COUNT(*) AS cnt FROM "${table}" WHERE "${col.column_name}" IS NOT NULL GROUP BY "${col.column_name}" ORDER BY COUNT(*) DESC LIMIT 20`
        );

        if (profRes.rows.length === 0 || profRes.rows.length > 20) continue;

        const pairs = profRes.rows.map(
          (r: { value: string; cnt: string }) => `${r.value} (${r.cnt} rows)`
        );

        if (!result.has(table)) result.set(table, []);
        result.get(table)!.push(`  -- DATA VALUES: ${col.column_name} \u2192 ${pairs.join(', ')}`);
        profiledCount++;
      } catch {
        // Skip columns that fail (e.g., cast errors)
      }
    }

    return result;
  }
```

- [ ] **Step 3: Call profileColumns from discover() and inject annotations**

In the `discover()` method, we need to:

a) Build a set of already-annotated columns (PG enum + check constraint) so the profiler can skip them.
b) Call `profileColumns()` after existing enrichment.
c) Inject the profiler annotations into the summary.

First, after the `checkEnumMap` loop (around line 162), add:

```typescript
      // Track columns that already have enum annotations (PG enum or check constraint)
      const annotatedColumns = new Set<string>();
      for (const key of enumMap.keys()) {
        // PG enums: find columns using this enum type
        for (const columns of columnsByTable.values()) {
          for (const col of columns) {
            if (col.data_type === 'USER-DEFINED' && col.udt_name === key) {
              annotatedColumns.add(`${col.table_name}.${col.column_name}`);
            }
          }
        }
      }
      for (const key of checkEnumMap.keys()) {
        annotatedColumns.add(key);
      }
```

Then, after the `rowCounts` variable is built (after line 215), add the profiler call:

```typescript
      // Profile columns for data value annotations
      const profileAnnotations = await this.profileColumns(
        pool, columnsByTable, tableNames, pkSet, fkMap, rowCounts, annotatedColumns
      );
```

Finally, in the summary-building loop, after the lookup values annotation (around line 271, after `if (lookupValues.has(table))`), add:

```typescript
        // Data profiler annotations
        if (profileAnnotations.has(table)) {
          for (const ann of profileAnnotations.get(table)!) {
            annotations.push(ann);
          }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent" && npx vitest run src/__tests__/schema.test.ts 2>&1 | tail -20`
Expected: All tests PASS including the 5 new data profiler tests

- [ ] **Step 5: Run full test suite**

Run: `cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent" && npx vitest run 2>&1 | tail -10`
Expected: All suites pass, 0 failures

- [ ] **Step 6: Commit**

```bash
cd "/home/sotsys-322/Ruby Projects/sql-chatbot"
git add packages/agent/src/services/schema.ts packages/agent/src/__tests__/schema.test.ts
git commit -m "feat(npm): add data profiler for framework-agnostic enum detection

Profiles named discriminator columns (type, status, role, etc.) and
low-cardinality integer columns by querying actual data values. Adds
DATA VALUES annotations to schema summary with value distribution.
Works for any framework (Go, Django, Rails, Laravel) since it reads
the actual database, not framework code."
```

---

### Task 3: Rebuild and validate on live databases

**Files:**
- No file changes — validation only

- [ ] **Step 1: Rebuild TypeScript**

Run: `cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent" && npx tsc`
Expected: No errors

- [ ] **Step 2: Start chatbot on Gitea and check schema annotations**

```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 2
source "/home/sotsys-322/Ruby Projects/sql-chatbot/.env"
cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent"
node dist/cli.js \
  --db "postgresql://gitea:gitea@localhost:5437/gitea" \
  --provider openai --key "$OPENAI_API_KEY" \
  --port 3456 &
sleep 8
curl -s http://localhost:3456/chatbot/api/health
```

Expected: Health check returns `{"status":"ok","tables":112,...}`

- [ ] **Step 3: Verify DATA VALUES annotations appear in Gitea schema**

Use the API to ask a simple question and check the schema includes `type` annotations on the `user` table. Alternatively, add a temporary console.log in the CLI to print the schema. The key validation: the schema should now contain something like:
```
TABLE "user" (~9 rows) (id BIGINT PK, name VARCHAR, type INT, ...)
  -- DATA VALUES: type → 0 (6 rows), 1 (3 rows)
```

- [ ] **Step 4: Retest Gitea Q1 — "How many repositories does each user own?"**

Ask via API:
```bash
curl -s -X POST "http://localhost:3456/chatbot/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many repositories does each user own?"}' | grep '"type":"sql"'
```

Expected: The SQL should now include `WHERE type = 0` or equivalent to exclude organizations.
Verify the answer only lists actual users (admin, alice, bob, charlie, dave, eve), NOT organizations.

- [ ] **Step 5: Retest Gitea Q3 — "How many organizations exist and how many members does each have?"**

```bash
curl -s -X POST "http://localhost:3456/chatbot/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many organizations exist and how many members does each have?"}' | grep '"type":"sql"'
```

Expected: SQL should filter `type = 1` for organizations. Answer should show 3 orgs with 1 member each.

- [ ] **Step 6: Retest Gitea Q9 — "How many non-organization users are there?"**

```bash
curl -s -X POST "http://localhost:3456/chatbot/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many non-organization users are there and list their names?"}' | grep '"type":"token"'
```

Expected: Answer should list 6 users (admin, alice, bob, charlie, dave, eve), NOT 5.

- [ ] **Step 7: Test on Saleor to verify no regressions**

```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 2
node dist/cli.js \
  --db "postgresql://saleor:saleor@localhost:5434/saleor" \
  --provider openai --key "$OPENAI_API_KEY" \
  --code "/home/sotsys-322/Ruby Projects/saleor/saleor" \
  --port 3456 &
sleep 8

curl -s -X POST "http://localhost:3456/chatbot/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the total revenue from orders placed in the last 30 days?"}' | grep '"type":"token"'
```

Expected: Same correct answer as before ($13,962.21). No regressions.

- [ ] **Step 8: Commit validation results (if any test script changes)**

If no code changes were needed, skip this step. If any fixes were required during validation, commit them:

```bash
git add -u packages/agent/
git commit -m "fix(npm): adjust data profiler based on live validation"
```
