# npm Package Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the npm package (`packages/agent`) to feature parity with the Rails gem for DB Q&A accuracy.

**Architecture:** Four independent tasks: (1) clean up orphaned JWT test, (2) add lookup hints to SQL generation, (3) add SQL retry with column auto-fix, (4) add follow-up SQL in conversation history. Each task is self-contained and testable independently.

**Tech Stack:** TypeScript, Vitest, PostgreSQL (pg), OpenAI SDK

---

### Task 1: Clean up orphaned JWT test file

**Files:**
- Delete: `packages/agent/src/__tests__/jwt.test.ts`

- [ ] **Step 1: Delete the orphaned test file**

```bash
rm packages/agent/src/__tests__/jwt.test.ts
```

The file imports `../auth/jwt.js` which doesn't exist. The `jsonwebtoken` dependency stays (may be used for cross-origin later).

- [ ] **Step 2: Run tests to verify all pass**

Run: `cd packages/agent && npx vitest run`
Expected: 11 suites pass, 0 fail (was 11 pass + 1 fail)

- [ ] **Step 3: Commit**

```bash
git add -u packages/agent/src/__tests__/jwt.test.ts
git commit -m "chore(npm): remove orphaned jwt.test.ts (auth/jwt.ts not yet implemented)"
```

---

### Task 2: Add lookup hints to SQL generation

The gem passes lookup hints (e.g., "For column job_type_id, use values: 1=Snow Removal, 2=Lawn Mowing") to the LLM before the question. The npm package has `findLookupHints()` on SchemaService but never calls it from the orchestrator or passes hints to `buildGenerateSqlMessages`.

**Files:**
- Modify: `packages/agent/src/prompts/generate-sql.ts` — accept `lookupHints` param
- Modify: `packages/agent/src/services/orchestrator.ts` — call `findLookupHints()` and pass to SQL gen
- Modify: `packages/agent/src/__tests__/prompts/generate-sql.test.ts` — test lookup hints in prompt
- Modify: `packages/agent/src/__tests__/orchestrator.test.ts` — test findLookupHints is called

- [ ] **Step 1: Write failing test for lookup hints in generate-sql prompt**

In `packages/agent/src/__tests__/prompts/generate-sql.test.ts`, add:

```typescript
it('14. includes lookup hints when provided', () => {
  const messages = buildGenerateSqlMessages({
    question: 'show me snow removal jobs',
    schema: 'TABLE jobs (id INT PK, job_type_id INT)',
    lookupHints: ['For column job_type_id on table jobs, values: 1=Snow Removal, 2=Lawn Mowing'],
  });
  const userMsg = messages.find(m => m.role === 'user')!;
  expect(userMsg.content).toContain('LOOKUP HINTS');
  expect(userMsg.content).toContain('Snow Removal');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && npx vitest run src/__tests__/prompts/generate-sql.test.ts`
Expected: FAIL — `lookupHints` not accepted

- [ ] **Step 3: Add lookupHints to buildGenerateSqlMessages**

In `packages/agent/src/prompts/generate-sql.ts`, update the input interface and function:

```typescript
// Add to GenerateSqlInput interface:
lookupHints?: string[];

// Add before the "Question:" line in buildGenerateSqlMessages:
if (input.lookupHints?.length) {
  userContent += 'IMPORTANT LOOKUP HINTS (use these exact columns and IDs):\n';
  for (const hint of input.lookupHints) {
    userContent += `- ${hint}\n`;
  }
  userContent += '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && npx vitest run src/__tests__/prompts/generate-sql.test.ts`
Expected: PASS

- [ ] **Step 5: Wire up in orchestrator — call findLookupHints()**

In `packages/agent/src/services/orchestrator.ts`, in the `handleData` method, add before `buildGenerateSqlMessages`:

```typescript
const lookupHints = this.schemaService.findLookupHints(input.question);
```

And pass it to the SQL generation:

```typescript
const sqlMessages = buildGenerateSqlMessages({
  question: input.question,
  schema: schemaSummary,
  codeContext,
  lookupHints: lookupHints.length ? lookupHints : undefined,
  history,
});
```

- [ ] **Step 6: Run all tests**

Run: `cd packages/agent && npx vitest run`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/prompts/generate-sql.ts packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/prompts/generate-sql.test.ts
git commit -m "feat(npm): add lookup hints to SQL generation for better accuracy"
```

---

### Task 3: Add SQL retry with column auto-fix

When SQL execution fails with "column X does not exist", the gem does a two-tier retry: (1) programmatic column name fix, (2) LLM-based retry with error hints. The npm package currently fails on first error with no retry.

**Files:**
- Modify: `packages/agent/src/services/orchestrator.ts` — add `tryFixColumn()`, `buildColumnHint()`, retry logic in `handleData`
- Modify: `packages/agent/src/__tests__/orchestrator.test.ts` — test retry scenarios

- [ ] **Step 1: Write failing test for column auto-fix**

In `packages/agent/src/__tests__/orchestrator.test.ts`, add a test where `executeSql` fails on first call with an UndefinedColumn error and succeeds on second call:

```typescript
it('retries SQL with column fix on UndefinedColumn error', async () => {
  const mockSchema = {
    ...defaultMockSchema,
    selectSchema: vi.fn(() => 'TABLE job_types (~12 rows) (id INT PK, title VARCHAR)'),
    getSummary: vi.fn(() => 'TABLE job_types (~12 rows) (id INT PK, title VARCHAR)'),
  };

  const deps = { schemaService: mockSchema, codeIndexer: mockCodeIndexer, databaseUrl: 'postgres://test' };
  const orch = new Orchestrator(deps);

  // Mock: classify as data, generate SQL with bad column "jt.name"
  const classifyResponse = JSON.stringify({ type: 'data', confidence: 0.9, searchTerms: ['job_types'] });
  const sqlResponse = JSON.stringify({ sql: 'SELECT jt.name FROM job_types jt', explanation: 'test' });
  const retrySqlResponse = JSON.stringify({ sql: 'SELECT jt.title FROM job_types jt', explanation: 'fixed' });
  const answerText = 'The answer';

  // callLLM: first call = classify, second = SQL gen, third = retry SQL
  vi.mocked(callLLM)
    .mockResolvedValueOnce(classifyResponse)
    .mockResolvedValueOnce(sqlResponse)
    .mockResolvedValueOnce(retrySqlResponse);

  // executeSql: first fails, second succeeds
  vi.mocked(executeSql)
    .mockRejectedValueOnce(new Error('PG::UndefinedColumn: ERROR: column jt.name does not exist'))
    .mockResolvedValueOnce({ columns: ['title'], rows: [{ title: 'Snow' }], rowCount: 1 });

  vi.mocked(streamLLM).mockImplementation(async function* () { yield answerText; });

  const events: SSEEvent[] = [];
  for await (const event of orch.handleQuestion({ question: 'show job types' })) {
    events.push(event);
  }

  // Should have two sql events (original + fixed)
  const sqlEvents = events.filter(e => e.type === 'sql');
  expect(sqlEvents.length).toBe(2);
  expect(sqlEvents[1].query).toContain('title');

  // Should have a token event (answer streamed)
  expect(events.some(e => e.type === 'token')).toBe(true);

  // Should NOT have an error event
  expect(events.some(e => e.type === 'error')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && npx vitest run src/__tests__/orchestrator.test.ts`
Expected: FAIL — no retry logic exists

- [ ] **Step 3: Implement tryFixColumn and buildColumnHint**

Add these private methods to the `Orchestrator` class in `packages/agent/src/services/orchestrator.ts`:

```typescript
/**
 * Attempt to fix an UndefinedColumn error by finding the correct column name.
 * Returns the corrected SQL string, or null if no fix could be determined.
 */
private tryFixColumn(errorMessage: string, sql: string, schema: string): string | null {
  if (!errorMessage.includes('UndefinedColumn') && !errorMessage.includes('does not exist')) {
    return null;
  }

  // Extract "alias.column" from: column jt.name does not exist
  const colMatch = errorMessage.match(/column\s+"?(\w+)\.(\w+)"?\s+does not exist/i);
  if (!colMatch) return null;

  const tableAlias = colMatch[1];
  const badCol = colMatch[2];

  // Find the real table name from SQL (e.g., "FROM job_types jt" → jt = job_types)
  const aliasRegex = new RegExp(`(?:FROM|JOIN)\\s+(\\w+)\\s+${tableAlias}\\b`, 'i');
  const aliasMatch = sql.match(aliasRegex);
  if (!aliasMatch) return null;
  const realTable = aliasMatch[1];

  // Extract columns from schema for this table
  const tableLine = schema.split('\n').find(l =>
    l.startsWith(`TABLE ${realTable} `) || l.startsWith(`TABLE ${realTable}\t`) || l.match(new RegExp(`^TABLE ${realTable}\\s*\\(`)) || l.match(new RegExp(`^TABLE ${realTable}\\s*\\(~`))
  );
  if (!tableLine) return null;

  const colsMatch = tableLine.match(/\((.+)\)/);
  if (!colsMatch) return null;
  const columns = [...colsMatch[1].matchAll(/(\w+)\s+\w+/g)].map(m => m[1]);

  // Find replacement: prefer title > label > description for "name" hallucination
  let replacement: string | undefined;
  if (['name', 'names'].includes(badCol.toLowerCase())) {
    replacement = ['title', 'label', 'first_name', 'display_name', 'description']
      .find(c => columns.includes(c));
  }
  // Fallback: fuzzy match
  if (!replacement) {
    replacement = columns.find(c => c.includes(badCol) || badCol.includes(c));
  }
  if (!replacement) return null;

  // Replace in SQL
  const fixRegex = new RegExp(`\\b${tableAlias}\\.${badCol}\\b`, 'gi');
  const fixed = sql.replace(fixRegex, `${tableAlias}.${replacement}`);
  return fixed === sql ? null : fixed;
}

/**
 * Build a hint from the PG error and schema for LLM retry.
 */
private buildColumnHint(errorMessage: string, schema: string): string {
  if (!errorMessage.includes('UndefinedColumn') && !errorMessage.includes('does not exist')) {
    return '';
  }

  const colMatch = errorMessage.match(/column[:\s]+"?(\w+\.)?(\w+)"?\s+(does not exist|of relation)/i);
  if (!colMatch) return '';

  const badCol = colMatch[2];
  const tableColumns: Record<string, string[]> = {};

  for (const line of schema.split('\n')) {
    if (line.startsWith('TABLE ')) {
      const tableMatch = line.match(/^TABLE (\S+)/);
      const colsMatch = line.match(/\((.+)\)/);
      if (tableMatch && colsMatch) {
        tableColumns[tableMatch[1]] = [...colsMatch[1].matchAll(/(\w+)\s+\w+/g)].map(m => m[1]);
      }
    }
  }

  const hints = Object.entries(tableColumns)
    .filter(([, cols]) => !cols.includes(badCol))
    .map(([table, cols]) => `Table '${table}' columns include: ${cols.slice(0, 15).join(', ')}`)
    .slice(0, 3);

  return hints.length
    ? `HINT: Column '${badCol}' does not exist. ${hints.join('. ')}.\n\n`
    : '';
}
```

- [ ] **Step 4: Add retry logic to handleData**

Replace the SQL execution block in `handleData` (lines ~194-203) with:

```typescript
// Execute SQL with retry on column errors
yield { type: 'executing' };

let sqlResult;
try {
  sqlResult = await executeSql(this.databaseUrl, validation.sql!);
} catch (err) {
  const errMsg = err instanceof Error ? err.message : String(err);

  // Strategy 1: Programmatic column fix (fast, no LLM call)
  const fixedSql = this.tryFixColumn(errMsg, validation.sql!, schemaSummary);
  if (fixedSql) {
    const fixedValidation = validateSql(fixedSql);
    if (fixedValidation.valid) {
      try {
        yield { type: 'sql', query: fixedSql, explanation: 'Auto-corrected column name' };
        sqlResult = await executeSql(this.databaseUrl, fixedValidation.sql!);
      } catch {
        // Fall through to LLM retry
      }
    }
  }

  // Strategy 2: LLM-based retry (slower, more flexible)
  if (!sqlResult) {
    const columnHint = this.buildColumnHint(errMsg, schemaSummary);
    const retryMessages = [
      ...sqlMessages,
      { role: 'assistant' as const, content: sqlRaw },
      { role: 'user' as const, content: `The SQL query failed with this error:\n${errMsg}\n\n${columnHint}Fix the query using ONLY columns from the schema. Keep all SELECT columns — do not drop columns, use the correct names.` },
    ];

    try {
      const retrySqlRaw = await callLLM(retryMessages, { jsonMode: true });
      const retryParsed = this.parseSqlGeneration(retrySqlRaw);
      const retryValidation = validateSql(retryParsed.sql);

      if (retryValidation.valid && retryParsed.sql) {
        yield { type: 'sql', query: retryParsed.sql, explanation: `Corrected: ${retryParsed.explanation}` };
        sqlResult = await executeSql(this.databaseUrl, retryValidation.sql!);
      } else {
        yield { type: 'error', message: errMsg };
        return;
      }
    } catch {
      yield { type: 'error', message: errMsg };
      return;
    }
  }
}
```

Note: This requires `sqlMessages` and `sqlRaw` to be accessible. Move them to `let` declarations before the try block.

- [ ] **Step 5: Run tests**

Run: `cd packages/agent && npx vitest run`
Expected: All pass including new retry test

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/orchestrator.test.ts
git commit -m "feat(npm): add SQL retry with column auto-fix on execution errors"
```

---

### Task 4: Add follow-up SQL in conversation history

The widget already sends `[SQL: ...]` tags in history (line 168 of ChatWidget.tsx). The generate-sql prompt already has rule 20 (FOLLOW-UP QUERIES) that tells the LLM to use previous SQL. But the gem's orchestrator also includes the SQL tag in its own response content, which we should verify the npm side handles correctly.

This is actually already working end-to-end:
1. Widget captures SQL from `sql` events and prepends `[SQL: ...]` to assistant messages in history
2. The generate-sql prompt rule 20 instructs the LLM to use it

However, the npm orchestrator's `handleData` emits `{ type: 'sql', sql: ... }` (key: `sql`) but the gem emits `{ type: 'sql', query: ... }` (key: `query`). The widget may expect one or the other. Let me verify.

**Files:**
- Modify: `packages/agent/src/services/orchestrator.ts` — ensure SSE `sql` event uses `query` key (consistent with gem)
- Modify: `packages/agent/widget-src/ChatWidget.tsx` — verify it reads the right key
- Modify: `packages/agent/src/__tests__/orchestrator.test.ts` — update test expectations if key changes

- [ ] **Step 1: Check widget SQL capture**

In `packages/agent/widget-src/ChatWidget.tsx`, find where it reads the SQL from SSE events and verify it matches the key the orchestrator emits. If the orchestrator emits `sql` but widget reads `query` (or vice versa), fix the mismatch.

- [ ] **Step 2: Align SSE sql event key**

In `packages/agent/src/services/orchestrator.ts`, change:
```typescript
yield { type: 'sql', sql: sqlParsed.sql };
```
to:
```typescript
yield { type: 'sql', query: sqlParsed.sql, explanation: sqlParsed.explanation };
```

This matches the gem's format and includes the explanation.

- [ ] **Step 3: Update widget to read `query` key**

In `packages/agent/widget-src/ChatWidget.tsx`, update the SQL capture to read `parsed.query` instead of `parsed.sql` (if not already).

- [ ] **Step 4: Update orchestrator tests**

Update any test assertions that check for `event.sql` to check `event.query` instead.

- [ ] **Step 5: Rebuild widget**

```bash
cd packages/agent && npm run build:widget
```

- [ ] **Step 6: Run all tests**

Run: `cd packages/agent && npx vitest run`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/orchestrator.test.ts packages/agent/widget-src/ChatWidget.tsx packages/agent/widget/widget.js
git commit -m "fix(npm): align SSE sql event key with gem format and ensure follow-up SQL works"
```
