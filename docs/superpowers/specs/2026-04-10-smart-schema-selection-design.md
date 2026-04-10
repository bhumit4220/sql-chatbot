# Smart Schema Selection — Design Spec

## Problem

Every LLM call receives the full database schema. MSP has 54 tables → 275K chars (~70K tokens). This causes:
1. **Context overflow** — gpt-4o-mini's 128K limit exceeded when combined with history + annotations
2. **Wasted tokens** — "how many customers?" sends 53 irrelevant tables
3. **Won't scale** — production apps with 100+ tables are unusable
4. **Slower responses** — LLM processes more tokens = more latency

## Solution

**Schema Selector** — a new in-memory service that selects only the tables relevant to each question. No extra LLM calls. Built at boot, lookup in microseconds.

## Architecture

### Boot Time: Build Indexes

During `SchemaService.discover()`, build two additional indexes:

**Table Index** — maps table and column names to table identifiers:
```
tableIndex = {
  "customers" → "customers",
  "email" → "customers",
  "wallet_bal" → "customers",
  "jobs" → "jobs",
  "job_type_id" → "jobs",
  "job_types" → "job_types",
  "title" → "job_types",
  ...
}
```

Column names that appear in multiple tables map to an array: `"status" → ["customers", "contractors", "jobs", ...]`

**FK Graph** — maps foreign key relationships bidirectionally:
```
fkGraph = {
  "jobs" → [
    { column: "property_id", target: "properties", targetColumn: "id" },
    { column: "job_type_id", target: "job_types", targetColumn: "id" },
    { column: "contractor_id", target: "contractors", targetColumn: "id" },
  ],
  "properties" → [
    { column: "customer_id", target: "customers", targetColumn: "id" },
    { column: "service_area_id", target: "service_areas", targetColumn: "id" },
  ],
  // Also reverse direction:
  "job_types" → [
    { column: "id", target: "jobs", targetColumn: "job_type_id" },
  ],
  ...
}
```

Sources for FK detection:
- Column names ending in `_id` matching a table name (`customer_id` → `customers`)
- MODEL FK annotations from ModelIntrospector (`created_by → customers.id`)
- Explicit PostgreSQL foreign key constraints from schema introspection

### Request Time: Select Relevant Tables

**Input:** question string + searchTerms from classifier (already computed)

**Step 1: Match tables from question keywords**

Tokenize the question into words. Match against:
1. **Table names** (exact or plural/singular): "customers" → `customers`, "job type" → `job_types`
2. **Column names** (fallback): "rating" → `contractors` (has `avg_rating`), "wallet" → `customers` (has `wallet_bal`)
3. **searchTerms from classifier**: reuse the 2-5 keywords the classifier already returns

Matching rules:
- Case-insensitive
- Singular/plural normalization: "customer" matches `customers`, "job" matches `jobs`
- Underscore splitting: "job_types" matches "job type" or "job types"
- Column substring: "rating" matches `avg_rating`, `rating`

Result: `primaryTables` — the set of tables directly mentioned or implied by the question.

**Step 2: Find join paths between primary tables**

For each pair of primary tables, find the shortest FK path:

- **Direct FK** (0 hops): `jobs.job_type_id → job_types.id` → no bridge table needed
- **1-hop bridge**: `customers` ↔ `job_types` → bridge through `jobs` (customers ← jobs → job_types)
- **Max 2 hops**: if no path within 2 hops, include both tables without a join path (LLM can still generate subqueries)

Only include bridge tables that are on the shortest path. Do NOT include all FK-connected tables.

Algorithm: BFS from each primary table, max depth 2, stop when another primary table is reached.

**Step 3: Build minimal schema**

For the selected tables only, build the schema string in the same format as today:
```
TABLE customers (
  id BIGINT PK,
  email VARCHAR,
  first_name VARCHAR,
  ...
  -- RAILS ENUM: status values: Active=1, Inactive=2, Deleted=3
  -- ENUM SOFT DELETE: status != 3 to exclude deleted records
)

TABLE jobs (
  id BIGINT PK,
  property_id BIGINT FK → properties.id,
  job_type_id BIGINT FK → job_types.id,
  ...
)
```

### Two Schema Formats for Different LLM Calls

**Classify prompt** — table names only:
```
Available tables: customers, contractors, jobs, job_types, properties, ratings, transactions, wallet_transactions, coupons, ...
```
~200 tokens. Enough for the classifier to decide question type.

**Generate SQL prompt** — full details for selected tables only:
Same format as current `summary()`, but only 1-5 tables instead of 54. ~2-5K tokens.

**Answer prompt** — no schema needed (already has query results).

## Public API

### SchemaService (both packages)

New methods:
```
tableNames() → string
  Returns comma-separated list of all table names. For classify prompt.

selectSchema(terms: string[]) → string
  Given search terms, returns full schema for matching + FK-connected tables.
  Falls back to top 10 hub tables if no terms match.
```

Existing `summary()` method stays for backward compatibility but is no longer called by the orchestrator.

### Orchestrator Changes

```
// Before:
schema_summary = @schema.summary  // 275K chars, ALL tables
classify_messages = Classify.build(schema_summary: schema_summary, ...)
generate_sql_messages = GenerateSql.build(schema: schema_summary, ...)

// After:
table_names = @schema.table_names  // ~500 chars, just names
classify_messages = Classify.build(schema_summary: table_names, ...)

selected_schema = @schema.select_schema(search_terms)  // ~5K chars, relevant tables
generate_sql_messages = GenerateSql.build(schema: selected_schema, ...)
```

## Edge Cases

**No tables matched:** Fall back to "hub tables" — the 10 tables with the most FK references (incoming + outgoing). These are the core entities (jobs, customers, contractors, etc.).

**Single table, no joins:** "How many customers?" → just `customers`. One table, full details.

**Ambiguous column match:** "average rating" → `avg_rating` exists on `customers` AND `contractors`. Include both. LLM picks based on question context.

**Very specific column match:** "wallet balance" → `wallet_bal` on `customers` only. Include just `customers`.

**Question mentions no entities:** "show me everything" or "what data do you have?" → return hub tables.

**Follow-up questions:** History already contains the previous question which mentioned entities. searchTerms from classifier should pick up context. If not, the history text itself may match table names.

## What Changes Where

| File | Change | Both Packages? |
|---|---|---|
| `services/schema_service` / `services/schema.ts` | Add `tableIndex`, `fkGraph` built during `discover()`. New methods: `table_names()`, `select_schema(terms)` | Yes |
| `services/orchestrator` | Use `table_names()` for classify, `select_schema(searchTerms)` for SQL generation | Yes |
| `prompts/classify` | No code change — just receives smaller schema string | No change |
| `prompts/generate_sql` | No code change — just receives smaller schema string | No change |

## Expected Results

| Metric | Before | After |
|---|---|---|
| Classify input tokens | ~70K | ~500 |
| GenerateSQL input tokens | ~70K | 2-5K |
| Works with 100+ tables | No | Yes |
| Extra LLM calls | 0 | 0 |
| Extra latency | — | ~1ms (in-memory lookup) |
| Response speed | Slow (LLM reads 70K tokens) | Fast (LLM reads 2-5K tokens) |

## Not In Scope

- Embedding/vector-based semantic matching (overkill, can add later)
- LLM-based table selection (extra call, adds latency)
- Schema caching across requests (already in memory)
- Changes to answer prompts, widget, middleware, or any other component
