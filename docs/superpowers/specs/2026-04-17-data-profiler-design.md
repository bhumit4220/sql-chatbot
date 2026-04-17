# Data Profiler Design Spec

**Date:** 2026-04-17
**Branch:** feature/rails-gem
**Scope:** npm package only (`packages/agent`)

## Problem

The LLM generates incorrect SQL when it doesn't understand column semantics. Three failure patterns remain after schema selection and prompt fixes:

1. **Framework-level enums** — Gitea stores `type=0` (user) vs `type=1` (org) in the `user` table. Django, Go, Laravel all define enums in application code, not in the database. The LLM doesn't know what integer values mean.
2. **Zero-means-null conventions** — Gitea uses `last_login_unix=0` to mean "never signed in". The LLM checks for NULL instead of 0.
3. **Value distribution blindness** — The LLM doesn't know which values are common vs rare, leading to incorrect aggregations and groupings.

Current schema enrichment detects PG enums, check constraints, FK lookups, and code-level enums. But framework-level integer enums stored as plain INT columns are invisible to all of these.

## Solution: Data Profiler

A single new step during `SchemaService.discover()` that queries the actual data in candidate columns and annotates the schema with the real values and their distribution.

**Philosophy:** Instead of parsing every framework's enum syntax or adding one-off prompt rules, read the actual data. This is framework-agnostic — works for Go, Django, Rails, Laravel, NestJS, or any other framework.

## Candidate Column Selection

A column is profiled if ALL of these are true:
- Data type is INT, SMALLINT, BIGINT, VARCHAR, or TEXT
- Not a primary key
- Not already annotated (PG enum, check constraint, FK lookup)
- The table has at least 1 row

AND at least one of:
- **Named discriminator:** column name matches `type`, `status`, `kind`, `role`, `state`, `category`, `level`, `priority`, `mode`, `source` — OR ends with `_type`, `_status`, `_kind`, `_role`, `_state`
- **Low cardinality:** `COUNT(DISTINCT col)` ≤ 20 (checked via a single fast query)

Columns that are foreign keys are skipped — they're already covered by FK lookup annotations.

## Profiling Query

For each candidate column:

```sql
SELECT col::text, COUNT(*) as cnt
FROM table
WHERE col IS NOT NULL
GROUP BY col
ORDER BY cnt DESC
LIMIT 20
```

The `::text` cast handles INT, VARCHAR, and other types uniformly.

## Schema Annotation Format

```
TABLE user (~9 rows) (id BIGINT PK, name VARCHAR, type INT, ...)
  -- DATA VALUES: type → 0 (6 rows), 1 (3 rows)
```

For columns where values are strings:
```
TABLE conversations (~1 rows) (id INT PK, status VARCHAR, ...)
  -- DATA VALUES: status → open (1 rows)
```

Annotation goes on its own line after the TABLE line, alongside existing annotations (SOFT DELETE, POLYMORPHIC, etc.).

## Performance Constraints

- **Column cap:** Profile at most 50 columns across the entire database. If more candidates exist, prioritize named discriminators over low-cardinality detection.
- **Skip empty tables:** Tables with 0 rows (from `pg_stat_user_tables`) are not profiled.
- **Batch cardinality check:** For non-named columns, use a single fast query per table to check distinct count before profiling:
  ```sql
  SELECT COUNT(DISTINCT col) FROM table
  ```
  Only proceed to the full GROUP BY if count ≤ 20.
- **Expected performance:** Sub-second on databases up to 200 tables. Each query is a simple GROUP BY on typically small result sets.

## Implementation

### Files Modified

1. **`packages/agent/src/services/schema.ts`**
   - New private method: `profileColumns(pool, columnsByTable, tableNames, pkSet, fkMap, rowCounts, existingAnnotations)`
   - Returns: `Map<string, string[]>` — table name → array of annotation lines
   - Called from `discover()` after existing enrichment, before building summary
   - Annotations injected alongside existing annotations (SOFT DELETE, POLYMORPHIC, etc.)

2. **`packages/agent/src/__tests__/schema.test.ts`**
   - Test: named discriminator columns get profiled
   - Test: PK and FK columns are skipped
   - Test: already-annotated columns (PG enum, check constraint) are skipped
   - Test: columns with >20 distinct values are skipped
   - Test: empty tables are skipped
   - Test: 50-column cap is enforced
   - Test: annotation format is correct

### No Prompt Changes

The existing prompt rules handle enums generically. Rule 18 says "When a column has ENUM annotation, use ONLY these exact values." The DATA VALUES annotation gives the LLM the same information in a slightly different format — the LLM will naturally use the values it sees.

No new prompt rules needed.

## Expected Accuracy Impact

| Failure | Before | After (expected) |
|---------|--------|-----------------|
| Gitea Q1 (repos per user) | FAIL — included orgs | PASS — sees `type → 0 (6), 1 (3)` |
| Gitea Q3 (org count) | FAIL — wrong count | PASS — sees 3 distinct org entries |
| Gitea Q6 (never signed in) | FAIL — checked NULL | PASS — sees `last_login_unix → 0 (6)` |
| Gitea Q9 (non-org users) | FAIL — missed admin | PASS — sees type=0 means user |
| Saleor Q6 (permissions) | FAIL — said 0 | MAYBE — depends on permission table profiling |

Conservative estimate: Gitea 60% → 80-90%, overall hard Qs 77% → 83-87%.

## What This Does NOT Fix

- **Saleor Q10 (UUID type mismatch):** This is a SQL type casting error, not a missing-value problem. The column types are already in the schema. This would need a prompt rule or retry improvement.
- **Saleor Q9 (null FK guest orders):** Guest orders have `user_id=NULL` with data in `user_email`. Profiling doesn't help here — it's a data pattern issue.
- **Complex multi-path JOINs (Saleor Q6):** Permission systems with 3 paths (superuser OR group OR direct) are inherently complex.

These are separate, smaller improvements that can be tackled independently after the data profiler is validated.
