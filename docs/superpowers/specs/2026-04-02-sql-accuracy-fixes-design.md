# SQL Accuracy Fixes — Design Spec

## Problem

Two SQL accuracy issues found during E2E testing on MSP and 2BNCHILL:

1. **Soft delete conflict:** When a table has BOTH a `deleted_at` column AND a Rails enum with a "Deleted" value, the LLM gets conflicting instructions from Rule 14 (use `deleted_at IS NULL`) and Rule 20 (use `status != 3`). In MSP, `deleted_at` exists but is unused — the app uses `status=3` for soft deletes. The LLM picks `deleted_at IS NULL` which returns wrong counts.

2. **FK lookup misplacement:** Lookup values (e.g., `1=Tv Shows, 2=Movie`) are annotated on the lookup table (`categories`) instead of on the referencing table (`titles.category_id`). The LLM can't cross-reference tables, so it confuses `status=2` with `category_id=2` when both exist as numeric columns on the same table.

## Fix 1: Smart Soft Delete Detection

### Approach

Detect whether a model uses a soft delete gem to determine if `deleted_at` is the real soft delete mechanism. Code-based detection, not data-based — works correctly even on empty tables.

### Logic

In `ModelIntrospector`, after detecting enums, add a new detection step per model:

```
has_soft_delete_gem = model includes Discard::Model, or
                      model includes Paranoia, or
                      model responds to acts_as_paranoid, or
                      model has paranoia column method
```

Return a set of tables that use gem-based soft deletes: `soft_delete_tables`.

In `SchemaService#discover`, when a `deleted_at` column is found:
- If the table is in `soft_delete_tables` → add `-- SOFT DELETE` annotation (the gem manages it)
- If the table is NOT in `soft_delete_tables` AND the table has an `ENUM SOFT DELETE` annotation → skip the `-- SOFT DELETE` annotation (the enum is the real mechanism, `deleted_at` is legacy/unused)
- If the table is NOT in `soft_delete_tables` AND has no enum soft delete → add `-- SOFT DELETE` annotation (column exists, no competing mechanism, assume it's used)

### Files Changed

- `lib/sql_chatbot/services/model_introspector.rb` — Add `detect_soft_delete_gems(model, table, annotations)` method that returns soft delete table set
- `lib/sql_chatbot/services/schema_service.rb` — Accept soft delete table set, use it to conditionally add SOFT DELETE annotations
- `lib/sql_chatbot_rails.rb` — Pass soft delete info from introspector to schema service

### Interface

`ModelIntrospector#introspect` currently returns `Hash[table_name => [annotation_strings]]`. It will additionally return two sets:

```ruby
result = introspector.introspect
# result.annotations => Hash[table => [strings]]
# result.soft_delete_tables => Set[table_names]  (tables using paranoia/discard gems)
# result.enum_soft_delete_tables => Set[table_names]  (tables with enum Deleted/Archived values)
```

**Ordering note:** `ModelIntrospector#introspect` runs after `SchemaService#discover`. The schema service needs the soft delete info to decide whether to keep or suppress `-- SOFT DELETE` annotations. So the flow becomes:

1. `SchemaService#discover` — build base schema WITHOUT soft delete annotations (defer them)
2. `ModelIntrospector#introspect` — detect enums, FKs, soft delete gems, enum soft deletes
3. `SchemaService#apply_soft_delete_annotations(soft_delete_tables, enum_soft_delete_tables)` — now add SOFT DELETE annotations using both sets to make the right decision
4. `SchemaService#append_model_annotations(annotations)` — inject enum/FK annotations as before

### Edge Cases

- Table has `deleted_at` + no soft delete gem + no enum soft delete → keep SOFT DELETE annotation (could be a non-Rails app or manual implementation)
- Table has `deleted_at` + soft delete gem + enum soft delete → SOFT DELETE annotation wins (gem is explicitly managing the column)
- Table has `discarded_at` (discard gem) → same logic, detected via `Discard::Model`
- No Rails models loaded (non-Rails app) → fall back to current behavior (annotate all `deleted_at` columns)

## Fix 2: Move Lookup Values to FK Columns

### Approach

Annotate lookup values on the table that HAS the FK column, not on the lookup table itself. The WHERE clause is always written against the FK column, so the annotation belongs there.

### Current Behavior

```
TABLE categories (id INT PK, name VARCHAR)
  -- VALUES: 1=Tv Shows, 2=Movie, 3=Action, ...

TABLE titles (id INT PK, name VARCHAR, category_id INT FK=>categories, status INT, ...)
  -- RAILS ENUM: status values: ...
```

LLM sees `status` and `category_id` both as numeric columns on `titles`. When asked about "movies", it may pick `status=2` instead of `category_id=2` because the VALUES annotation is on a different table.

### New Behavior

```
TABLE categories (id INT PK, name VARCHAR)

TABLE titles (id INT PK, name VARCHAR, category_id INT FK=>categories, status INT, ...)
  -- FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie, 3=Action, ...
  -- RAILS ENUM: status values: ...
```

Now the LLM sees the values directly next to the FK column. No cross-referencing needed.

### Logic

In `SchemaService`, after discovering lookup values for small tables (<50 rows):
1. Remove the `-- VALUES` annotation from the lookup table
2. For each FK that references the lookup table, add `-- FK LOOKUP: <fk_column> values: <id=name pairs>` on the referencing table

Uses the existing `fk_map` (already built during schema discovery) to find which tables/columns reference the lookup table. No new DB queries.

### Files Changed

- `lib/sql_chatbot/services/schema_service.rb` — Move lookup value annotations from referenced table to referencing tables via FK map
- `lib/sql_chatbot/prompts/generate_sql.rb` — Update Rule 16 to reference `-- FK LOOKUP` annotation format instead of `-- VALUES`

### Prompt Rule Change

Rule 16 changes from:
```
LOOKUP VALUES: When a table has "-- VALUES: id=name" mappings, use these exact IDs in WHERE clauses.
```

To:
```
FK LOOKUP VALUES: When a table has "-- FK LOOKUP: column values: id=name, ..." annotation, use these exact IDs in WHERE clauses for that column. For example, "FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie" means use WHERE category_id = 2 for movies.
```

## Testing

### Fix 1 Tests

- Model with `Discard::Model` + `deleted_at` → SOFT DELETE annotation present
- Model with `Paranoia` + `deleted_at` → SOFT DELETE annotation present
- Model without soft delete gem + `deleted_at` + enum `Deleted=3` → SOFT DELETE annotation suppressed, ENUM SOFT DELETE present
- Model without soft delete gem + `deleted_at` + no enum delete → SOFT DELETE annotation present
- No Rails models (empty descendants) → current behavior preserved

### Fix 2 Tests

- FK to small lookup table → `-- FK LOOKUP` annotation on referencing table
- Lookup table itself → no `-- VALUES` annotation
- Multiple FKs to same lookup table → annotation on each referencing table
- FK to large table (>50 rows) → no FK LOOKUP annotation
- Table with no FKs to lookup tables → unchanged

### E2E Verification

After implementation, re-test on both apps:
- **MSP:** "How many customers are there?" should use `status != 3`, not `deleted_at IS NULL`
- **2BNCHILL:** "How many movies are there?" should use `category_id = 2`, not `status = 2`
