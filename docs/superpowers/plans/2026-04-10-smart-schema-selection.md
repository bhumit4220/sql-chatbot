# Smart Schema Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send only relevant tables to the LLM instead of the full schema — classify gets table names only (~500 tokens), SQL generation gets 1-5 relevant tables (~2-5K tokens) instead of all tables (~70K tokens).

**Architecture:** Add `table_names()` and `select_schema(terms)` methods to SchemaService in both packages. At boot, build a table index (table/column name → table) and FK graph (bidirectional). At request time, match question keywords to tables, find FK join paths between matched tables via BFS, build schema string for only those tables. Orchestrator calls `table_names()` for classify and `select_schema(search_terms)` for SQL generation.

**Tech Stack:** Ruby (gem), TypeScript (npm), PostgreSQL introspection (already done in discover).

**Design spec:** `docs/superpowers/specs/2026-04-10-smart-schema-selection-design.md`

---

## File Structure

### Modified files in `sql-chatbot-rails/` (gem)

```
lib/sql_chatbot/services/schema_service.rb   — Add table_names(), select_schema(), build indexes
lib/sql_chatbot/services/orchestrator.rb      — Use table_names() and select_schema()
spec/sql_chatbot/services/schema_service_spec.rb — Tests for new methods
spec/sql_chatbot/services/orchestrator_spec.rb   — Update schema mock
```

### Modified files in `packages/agent/` (npm)

```
src/services/schema.ts              — Add getTableNames(), selectSchema(), build indexes
src/services/orchestrator.ts        — Use getTableNames() and selectSchema()
src/__tests__/schema.test.ts        — Tests for new methods
src/__tests__/orchestrator.test.ts  — Update schema mock
```

---

## Phase 1: Rails Gem (Tasks 1-3)

### Task 1: SchemaService — Build Indexes + New Methods (Tests)

**Files:**
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb`

- [ ] **Step 1: Write failing tests for table_names and select_schema**

Add to the existing spec file:

```ruby
describe "#table_names" do
  it "returns comma-separated list of all table names" do
    schema = described_class.new
    # Simulate a discovered schema
    schema.instance_variable_set(:@tables, ["customers", "jobs", "job_types", "properties"])
    result = schema.table_names
    expect(result).to include("customers")
    expect(result).to include("jobs")
    expect(result).to include("job_types")
    expect(result).to include("properties")
    expect(result).to eq("Available tables: customers, jobs, job_types, properties")
  end
end

describe "#select_schema" do
  before do
    @schema = described_class.new

    # Build fake per-table schemas
    @schema.instance_variable_set(:@per_table_schemas, {
      "customers" => "TABLE customers (id BIGINT PK, email VARCHAR, first_name VARCHAR, status INT)\n  -- RAILS ENUM: status values: Active=1, Deleted=3",
      "jobs" => "TABLE jobs (id BIGINT PK, customer_id BIGINT FK=>customers.id, job_type_id BIGINT FK=>job_types.id, status INT)\n  -- RAILS ENUM: status values: Active=1, Completed=11",
      "job_types" => "TABLE job_types (id BIGINT PK, title VARCHAR, status INT)",
      "properties" => "TABLE properties (id BIGINT PK, customer_id BIGINT FK=>customers.id, address1 VARCHAR)",
      "contractors" => "TABLE contractors (id BIGINT PK, first_name VARCHAR, avg_rating DECIMAL, status INT)",
      "ratings" => "TABLE ratings (id BIGINT PK, job_id BIGINT FK=>jobs.id, rating DECIMAL)",
    })

    # Build table index
    @schema.instance_variable_set(:@table_index, {
      "customers" => ["customers"], "email" => ["customers"], "first_name" => ["customers", "contractors"],
      "jobs" => ["jobs"], "customer_id" => ["jobs", "properties"], "job_type_id" => ["jobs"],
      "job_types" => ["job_types"], "title" => ["job_types"],
      "properties" => ["properties"], "address1" => ["properties"],
      "contractors" => ["contractors"], "avg_rating" => ["contractors"],
      "ratings" => ["ratings"], "rating" => ["ratings"], "job_id" => ["ratings"],
    })

    # Build FK graph
    @schema.instance_variable_set(:@fk_graph, {
      "jobs" => [
        { from_col: "customer_id", to_table: "customers", to_col: "id" },
        { from_col: "job_type_id", to_table: "job_types", to_col: "id" },
      ],
      "properties" => [
        { from_col: "customer_id", to_table: "customers", to_col: "id" },
      ],
      "ratings" => [
        { from_col: "job_id", to_table: "jobs", to_col: "id" },
      ],
      "customers" => [
        { from_col: "id", to_table: "jobs", to_col: "customer_id" },
        { from_col: "id", to_table: "properties", to_col: "customer_id" },
      ],
      "job_types" => [
        { from_col: "id", to_table: "jobs", to_col: "job_type_id" },
      ],
    })

    @schema.instance_variable_set(:@tables, %w[customers jobs job_types properties contractors ratings])
  end

  it "selects only matched tables for simple count" do
    result = @schema.select_schema(["customers"])
    expect(result).to include("TABLE customers")
    expect(result).not_to include("TABLE jobs")
    expect(result).not_to include("TABLE properties")
  end

  it "selects matched tables and FK-connected tables" do
    result = @schema.select_schema(["jobs", "job_types"])
    expect(result).to include("TABLE jobs")
    expect(result).to include("TABLE job_types")
    expect(result).not_to include("TABLE customers")
    expect(result).not_to include("TABLE properties")
  end

  it "finds bridge table between indirectly connected tables" do
    # customers and job_types are connected via jobs
    result = @schema.select_schema(["customers", "job_types"])
    expect(result).to include("TABLE customers")
    expect(result).to include("TABLE job_types")
    expect(result).to include("TABLE jobs") # bridge table
  end

  it "matches column names to tables" do
    result = @schema.select_schema(["rating", "contractors"])
    expect(result).to include("TABLE contractors")
    expect(result).to include("TABLE ratings") # matched via "rating" column
  end

  it "falls back to hub tables when no terms match" do
    result = @schema.select_schema(["something_unknown"])
    # Should return tables with most FK connections
    expect(result).to include("TABLE")
    expect(result.length).to be > 0
  end

  it "includes annotations for selected tables" do
    result = @schema.select_schema(["customers"])
    expect(result).to include("RAILS ENUM")
    expect(result).to include("Active=1")
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb`
Expected: FAIL — `undefined method 'table_names'`

---

### Task 2: SchemaService — Implementation

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb`

- [ ] **Step 1: Add instance variables for indexes**

In `initialize`, add:

```ruby
def initialize
  @summary_text = ""
  @tables = []
  @per_table_schemas = {}  # table_name => schema string for that table
  @table_index = {}        # word => [table_names] for keyword matching
  @fk_graph = {}           # table_name => [{ from_col:, to_table:, to_col: }]
end
```

- [ ] **Step 2: Add table_names method**

```ruby
def table_names
  return "" if @tables.empty?
  "Available tables: #{@tables.join(', ')}"
end
```

- [ ] **Step 3: Add select_schema method**

```ruby
def select_schema(terms)
  return @summary_text if @per_table_schemas.empty?

  # Step 1: Match terms to tables
  matched = match_tables(terms)

  # Step 2: If no matches, use hub tables (most FK connections)
  if matched.empty?
    matched = hub_tables(10)
  end

  # Step 3: Find FK join paths between matched tables
  all_tables = Set.new(matched)
  matched_arr = matched.to_a
  matched_arr.combination(2).each do |t1, t2|
    bridge = find_join_path(t1, t2)
    bridge.each { |t| all_tables.add(t) } if bridge
  end

  # Step 4: Build schema string for selected tables
  all_tables.map { |t| @per_table_schemas[t] }.compact.join("\n\n")
end
```

- [ ] **Step 4: Add private helper methods**

```ruby
private

def match_tables(terms)
  matched = Set.new
  terms.each do |term|
    lower = term.downcase
    # Try exact table name match
    if @per_table_schemas.key?(lower)
      matched.add(lower)
      next
    end
    # Try singular/plural
    singular = singularize_word(lower)
    plural = pluralize_word(lower)
    [singular, plural].each do |variant|
      matched.add(variant) if @per_table_schemas.key?(variant)
    end
    # Try table index (column name match)
    if @table_index.key?(lower)
      @table_index[lower].each { |t| matched.add(t) }
    end
    # Try substring match on column names
    @table_index.each do |col, tables|
      if col.include?(lower) || lower.include?(col)
        tables.each { |t| matched.add(t) }
      end
    end
  end
  matched
end

def hub_tables(limit)
  # Tables with most FK connections (both directions)
  counts = Hash.new(0)
  @fk_graph.each do |table, edges|
    counts[table] += edges.length
  end
  counts.sort_by { |_, c| -c }.first(limit).map(&:first).to_set
end

def find_join_path(from_table, to_table, max_depth: 2)
  return [] if from_table == to_table
  return nil unless @fk_graph.key?(from_table)

  # BFS to find shortest path
  queue = [[from_table, [from_table]]]
  visited = Set.new([from_table])

  while queue.any?
    current, path = queue.shift
    return path - [from_table, to_table] if current == to_table
    next if path.length > max_depth + 1

    (@fk_graph[current] || []).each do |edge|
      next_table = edge[:to_table]
      unless visited.include?(next_table)
        visited.add(next_table)
        queue << [next_table, path + [next_table]]
      end
    end
  end

  nil # No path found
end

def singularize_word(word)
  if word.end_with?("ies")
    word[0...-3] + "y"
  elsif word.end_with?("ses")
    word[0...-2]
  elsif word.end_with?("s") && !word.end_with?("ss")
    word[0...-1]
  else
    word
  end
end

def pluralize_word(word)
  if word.end_with?("y") && !word.end_with?("ey")
    word[0...-1] + "ies"
  elsif word.end_with?("s") || word.end_with?("x") || word.end_with?("sh")
    word + "es"
  else
    word + "s"
  end
end
```

- [ ] **Step 5: Build indexes during discover()**

At the end of the `discover` method, after `@summary_text = lines.join("\n")`, add:

```ruby
# Build per-table schemas for selective retrieval
build_per_table_schemas(lines)

# Build indexes for keyword matching and FK traversal
build_table_index(columns_by_table)
build_fk_graph(fk_rows, columns_by_table, table_name_set)
```

Add private methods:

```ruby
def build_per_table_schemas(lines)
  @per_table_schemas = {}
  current_table = nil
  current_lines = []

  lines.each do |line|
    if line.start_with?("TABLE ")
      if current_table
        @per_table_schemas[current_table] = current_lines.join("\n")
      end
      current_table = line.match(/^TABLE (\S+)/)[1]
      current_lines = [line]
    else
      current_lines << line
    end
  end

  if current_table
    @per_table_schemas[current_table] = current_lines.join("\n")
  end
end

def build_table_index(columns_by_table)
  @table_index = {}
  columns_by_table.each do |table, cols|
    cols.each do |col|
      col_name = col["column_name"]
      next if self.class.sensitive?(col_name)
      (@table_index[col_name] ||= []) << table
    end
  end
  # Deduplicate
  @table_index.each_value(&:uniq!)
end

def build_fk_graph(fk_rows, columns_by_table, table_name_set)
  @fk_graph = Hash.new { |h, k| h[k] = [] }

  # From explicit FK constraints
  fk_rows.each do |r|
    @fk_graph[r["from_table"]] << { from_col: r["from_column"], to_table: r["to_table"], to_col: r["to_column"] }
    # Reverse direction
    @fk_graph[r["to_table"]] << { from_col: r["to_column"], to_table: r["from_table"], to_col: r["from_column"] }
  end

  # From convention-based _id columns (not already in FK constraints)
  fk_from_set = Set.new(fk_rows.map { |r| "#{r['from_table']}.#{r['from_column']}" })

  columns_by_table.each do |table, cols|
    cols.each do |col|
      col_name = col["column_name"]
      next unless col_name.end_with?("_id")
      next if fk_from_set.include?("#{table}.#{col_name}")

      base = col_name[0..-4]
      candidates = ["#{base}s", "#{base.sub(/y$/, 'ie')}s", "#{base}es", base]
      target = candidates.find { |c| table_name_set.include?(c) }
      if target
        @fk_graph[table] << { from_col: col_name, to_table: target, to_col: "id" }
        @fk_graph[target] << { from_col: "id", to_table: table, to_col: col_name }
      end
    end
  end
end
```

- [ ] **Step 6: Run tests**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb`
Expected: All tests PASS

- [ ] **Step 7: Run full gem test suite**

Run: `cd sql-chatbot-rails && bundle exec rspec`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb
git commit -m "feat(rails): add smart schema selection to SchemaService"
```

---

### Task 3: Gem Orchestrator — Use Smart Schema Selection

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/orchestrator_spec.rb`

- [ ] **Step 1: Write failing test**

Add to orchestrator spec:

```ruby
describe "smart schema selection" do
  it "passes table_names to classify instead of full summary" do
    allow(schema_service).to receive(:table_names).and_return("Available tables: customers, jobs")
    allow(llm_client).to receive(:call).and_return('{"type":"data","confidence":0.9,"searchTerms":["customers"]}')
    allow(schema_service).to receive(:select_schema).with(["customers"]).and_return("TABLE customers (id BIGINT PK)")
    allow(llm_client).to receive(:call).and_return('{"sql":"SELECT COUNT(*) FROM customers","explanation":"count"}')
    allow(SqlChatbot::Services::SqlExecutor).to receive(:validate_sql).and_return({ valid: true, sql: "SELECT COUNT(*) FROM customers" })
    allow(SqlChatbot::Services::SqlExecutor).to receive(:execute_sql).and_return({ rows: [{ "count" => 5 }], columns: ["count"], row_count: 1 })
    allow(llm_client).to receive(:stream).and_yield("5 customers.")

    events = orchestrator.handle_question(question: "How many customers?").to_a
    expect(schema_service).to have_received(:table_names)
    expect(schema_service).to have_received(:select_schema).with(["customers"])
  end
end
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/orchestrator_spec.rb`
Expected: FAIL — `table_names` not called

- [ ] **Step 3: Update orchestrator to use smart schema selection**

In `handle_question`, change the classify call:

```ruby
# Before:
schema_summary = @schema.summary
classify_messages = Prompts::Classify.build_messages(
  question: question,
  schema_summary: schema_summary,
  ...
)

# After:
table_names_str = @schema.table_names
classify_messages = Prompts::Classify.build_messages(
  question: question,
  schema_summary: table_names_str,
  ...
)
```

In `handle_data_with_code`, change the SQL generation call:

```ruby
# Before:
gen_messages = Prompts::GenerateSql.build_messages(
  question: question,
  schema: schema_summary,
  ...
)

# After:
search_terms = classification[:searchTerms] || []
selected_schema = @schema.select_schema(search_terms)
gen_messages = Prompts::GenerateSql.build_messages(
  question: question,
  schema: selected_schema,
  ...
)
```

Also update `handle_question` to pass `search_terms` through. The `schema_summary` variable that was used for both classify and SQL gen now becomes two separate calls.

- [ ] **Step 4: Update schema_service mock in test setup**

In the `let(:schema_service)` definition, add stubs for new methods:

```ruby
let(:schema_service) do
  instance_double(SqlChatbot::Services::SchemaService,
    summary: "TABLE users (id INT, name VARCHAR)",
    table_names: "Available tables: users",
    select_schema: "TABLE users (id INT, name VARCHAR)",
    find_lookup_hints: []
  )
end
```

- [ ] **Step 5: Run full gem test suite**

Run: `cd sql-chatbot-rails && bundle exec rspec`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/orchestrator.rb sql-chatbot-rails/spec/sql_chatbot/services/orchestrator_spec.rb
git commit -m "feat(rails): use smart schema selection in orchestrator"
```

---

## Phase 2: NPM Package (Tasks 4-5)

### Task 4: NPM SchemaService — Build Indexes + New Methods

**Files:**
- Modify: `packages/agent/src/services/schema.ts`
- Modify: `packages/agent/src/__tests__/schema.test.ts`

Same logic as Task 1-2 but in TypeScript. Key differences:

- `getTableNames(): string` — returns `"Available tables: customers, jobs, ..."`
- `selectSchema(terms: string[]): string` — returns schema for matched + FK-connected tables
- Build `perTableSchemas: Map<string, string>`, `tableIndex: Map<string, string[]>`, `fkGraph: Map<string, Edge[]>` during `discover()`
- BFS for join path finding, same max depth of 2

- [ ] **Step 1: Write failing tests**

Add to `packages/agent/src/__tests__/schema.test.ts`:

```typescript
describe('getTableNames', () => {
  it('returns comma-separated table names', () => {
    const service = new SchemaService();
    // @ts-ignore — accessing private for test
    service['tables'] = ['customers', 'jobs', 'job_types'];
    expect(service.getTableNames()).toBe('Available tables: customers, jobs, job_types');
  });
});

describe('selectSchema', () => {
  let service: SchemaService;

  beforeEach(() => {
    service = new SchemaService();
    // @ts-ignore
    service['perTableSchemas'] = new Map([
      ['customers', 'TABLE customers (id BIGINT PK, email VARCHAR, status INT)\n  -- RAILS ENUM: status values: Active=1'],
      ['jobs', 'TABLE jobs (id BIGINT PK, customer_id BIGINT FK=>customers.id, job_type_id BIGINT FK=>job_types.id)'],
      ['job_types', 'TABLE job_types (id BIGINT PK, title VARCHAR)'],
      ['contractors', 'TABLE contractors (id BIGINT PK, avg_rating DECIMAL)'],
    ]);
    // @ts-ignore
    service['tableIndex'] = new Map([
      ['email', ['customers']], ['status', ['customers', 'jobs']],
      ['customer_id', ['jobs']], ['job_type_id', ['jobs']],
      ['title', ['job_types']], ['avg_rating', ['contractors']],
    ]);
    // @ts-ignore
    service['fkGraph'] = new Map([
      ['jobs', [{ fromCol: 'customer_id', toTable: 'customers', toCol: 'id' }, { fromCol: 'job_type_id', toTable: 'job_types', toCol: 'id' }]],
      ['customers', [{ fromCol: 'id', toTable: 'jobs', toCol: 'customer_id' }]],
      ['job_types', [{ fromCol: 'id', toTable: 'jobs', toCol: 'job_type_id' }]],
    ]);
    // @ts-ignore
    service['tables'] = ['customers', 'jobs', 'job_types', 'contractors'];
  });

  it('selects only matched tables', () => {
    const result = service.selectSchema(['customers']);
    expect(result).toContain('TABLE customers');
    expect(result).not.toContain('TABLE jobs');
  });

  it('selects matched tables with FK connections', () => {
    const result = service.selectSchema(['jobs', 'job_types']);
    expect(result).toContain('TABLE jobs');
    expect(result).toContain('TABLE job_types');
    expect(result).not.toContain('TABLE customers');
  });

  it('finds bridge tables', () => {
    const result = service.selectSchema(['customers', 'job_types']);
    expect(result).toContain('TABLE customers');
    expect(result).toContain('TABLE job_types');
    expect(result).toContain('TABLE jobs'); // bridge
  });

  it('matches column names', () => {
    const result = service.selectSchema(['rating']);
    expect(result).toContain('TABLE contractors'); // avg_rating
  });
});
```

- [ ] **Step 2: Implement in schema.ts**

Same logic as Ruby: add `perTableSchemas`, `tableIndex`, `fkGraph` maps. Add `getTableNames()`, `selectSchema(terms)`, and private `matchTables()`, `findJoinPath()`, `hubTables()` methods. Build indexes at end of `discover()`.

- [ ] **Step 3: Run tests**

Run: `cd packages/agent && npx vitest run src/__tests__/schema.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/services/schema.ts packages/agent/src/__tests__/schema.test.ts
git commit -m "feat(npm): add smart schema selection to SchemaService"
```

---

### Task 5: NPM Orchestrator — Use Smart Schema Selection

**Files:**
- Modify: `packages/agent/src/services/orchestrator.ts`
- Modify: `packages/agent/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Update orchestrator to use getTableNames() for classify and selectSchema() for SQL gen**

Same changes as Task 3:
- Classify gets `this.schemaService.getTableNames()` instead of `getSummary()`
- SQL generation gets `this.schemaService.selectSchema(searchTerms)` instead of `getSummary()`

- [ ] **Step 2: Update mock in tests**

Add `getTableNames` and `selectSchema` stubs to `createMockSchemaService()`.

- [ ] **Step 3: Run all npm tests**

Run: `cd packages/agent && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/orchestrator.test.ts
git commit -m "feat(npm): use smart schema selection in orchestrator"
```

---

## Phase 3: E2E Validation (Task 6)

### Task 6: Test on MSP

- [ ] **Step 1: Restart MSP and verify health**

```bash
curl http://localhost:3000/chatbot/api/health
```

- [ ] **Step 2: Test previously failing questions via Playwright**

1. "How many customers are there?" — should work (was working before)
2. "Show me the top 5 contractors by rating" — was failing with 400 context overflow, should work now
3. "What is the average rating of contractors?" — should show ROUND'd result
4. "Which job type has the most jobs?" — should work with only jobs + job_types tables
5. "How many completed jobs are there?" — should work, concise answer without filler

- [ ] **Step 3: Verify schema size reduction**

```ruby
rails runner "SqlChatbot.ensure_initialized!; puts 'Full: ' + SqlChatbot.schema_service.summary.length.to_s; puts 'Selected: ' + SqlChatbot.schema_service.select_schema(['customers']).length.to_s"
```

Expected: Full ~275K, Selected ~2-5K for a single table query.

- [ ] **Step 4: Run all test suites**

```bash
cd sql-chatbot-rails && bundle exec rspec
cd packages/agent && npx vitest run
```

- [ ] **Step 5: Commit any integration fixes**

```bash
git commit -m "fix: integration fixes for smart schema selection"
```
