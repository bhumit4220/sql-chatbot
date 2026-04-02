# SQL Accuracy Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two SQL generation accuracy issues: smart soft delete detection (gem-based vs enum-based) and moving FK lookup values to referencing tables.

**Architecture:** ModelIntrospector gains soft delete gem detection. SchemaService defers soft delete annotations until model introspection is complete, then applies them conditionally. Lookup values move from referenced tables to FK columns on referencing tables.

**Tech Stack:** Ruby, RSpec, Rails model introspection APIs

**Spec:** `docs/superpowers/specs/2026-04-02-sql-accuracy-fixes-design.md`

---

## File Structure

### Modified Files

| File | Responsibility |
|------|---------------|
| `lib/sql_chatbot/services/model_introspector.rb` | Add `detect_soft_delete_gem` method, change return type to include soft_delete_tables and enum_soft_delete_tables |
| `lib/sql_chatbot/services/schema_service.rb` | Defer soft delete annotations, add `apply_soft_delete_annotations` method, move lookup values to FK columns |
| `lib/sql_chatbot/prompts/generate_sql.rb` | Update Rule 16 from `VALUES` to `FK LOOKUP` format |
| `lib/sql_chatbot_rails.rb` | Update initialization flow to pass soft delete info between introspector and schema service |
| `spec/sql_chatbot/services/model_introspector_spec.rb` | Add soft delete gem detection tests |
| `spec/sql_chatbot/services/schema_service_spec.rb` | Add soft delete conditional annotation tests, FK lookup tests |
| `spec/sql_chatbot/prompts/generate_sql_spec.rb` | Update rule count and rule 16 test |

---

## Task 1: ModelIntrospector — Soft Delete Gem Detection

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/model_introspector.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/model_introspector_spec.rb`

- [ ] **Step 1: Write failing tests**

Add these test contexts to the existing spec file, after the "with enum that has no deleted/archived values" context:

```ruby
context "with model using Paranoia gem" do
  let(:model) do
    klass = fake_model(
      table_name: "posts",
      enums: { "status" => { "Active" => 1, "Deleted" => 3 } }
    )
    # Simulate Paranoia module
    paranoia_module = Module.new
    stub_const("Paranoia", paranoia_module)
    klass.include(paranoia_module)
    klass
  end

  before do
    stub_const("ActiveRecord::Base", Class.new {
      define_singleton_method(:descendants) { [] }
    })
    allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
  end

  it "includes table in soft_delete_tables" do
    result = introspector.introspect
    expect(result.soft_delete_tables).to include("posts")
  end

  it "still detects enum soft delete" do
    result = introspector.introspect
    expect(result.annotations["posts"]).to include(
      a_string_matching(/ENUM SOFT DELETE/)
    )
  end
end

context "with model using Discard gem" do
  let(:model) do
    klass = fake_model(
      table_name: "comments",
      enums: {}
    )
    discard_module = Module.new
    stub_const("Discard::Model", discard_module)
    klass.include(discard_module)
    klass
  end

  before do
    stub_const("ActiveRecord::Base", Class.new {
      define_singleton_method(:descendants) { [] }
    })
    allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
  end

  it "includes table in soft_delete_tables" do
    result = introspector.introspect
    expect(result.soft_delete_tables).to include("comments")
  end
end

context "with model without soft delete gem but with enum Deleted" do
  let(:model) do
    fake_model(
      table_name: "jobs",
      enums: { "status" => { "Active" => 1, "Deleted" => 3 } }
    )
  end

  before do
    stub_const("ActiveRecord::Base", Class.new {
      define_singleton_method(:descendants) { [] }
    })
    allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
  end

  it "includes table in enum_soft_delete_tables" do
    result = introspector.introspect
    expect(result.enum_soft_delete_tables).to include("jobs")
  end

  it "does not include table in soft_delete_tables" do
    result = introspector.introspect
    expect(result.soft_delete_tables).not_to include("jobs")
  end
end

context "with model without any soft delete mechanism" do
  let(:model) do
    fake_model(
      table_name: "settings",
      enums: { "priority" => { "Low" => 0, "High" => 1 } }
    )
  end

  before do
    stub_const("ActiveRecord::Base", Class.new {
      define_singleton_method(:descendants) { [] }
    })
    allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
  end

  it "does not include table in either set" do
    result = introspector.introspect
    expect(result.soft_delete_tables).not_to include("settings")
    expect(result.enum_soft_delete_tables).not_to include("settings")
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/model_introspector_spec.rb
```

Expected: FAIL — `NoMethodError: undefined method 'soft_delete_tables'`

- [ ] **Step 3: Implement return type and soft delete gem detection**

Change the `introspect` method to return a struct with three fields, and add `detect_soft_delete_gem`:

```ruby
# At the top of the class, add the result struct
IntrospectionResult = Struct.new(:annotations, :soft_delete_tables, :enum_soft_delete_tables, keyword_init: true)

def introspect
  annotations = Hash.new { |h, k| h[k] = Set.new }
  soft_delete_tables = Set.new
  enum_soft_delete_tables = Set.new

  models = discover_models
  models.each do |model|
    table = model.table_name

    detect_enums(model, table, annotations, enum_soft_delete_tables)
    detect_associations(model, table, annotations)
    detect_soft_delete_gem(model, table, soft_delete_tables)
  end

  IntrospectionResult.new(
    annotations: annotations.transform_values(&:to_a),
    soft_delete_tables: soft_delete_tables,
    enum_soft_delete_tables: enum_soft_delete_tables,
  )
end
```

Update `detect_enums` to also populate `enum_soft_delete_tables`:

```ruby
def detect_enums(model, table, annotations, enum_soft_delete_tables)
  return unless model.respond_to?(:defined_enums)

  model.defined_enums.each do |column, values|
    next if values.empty?

    formatted = values.map { |label, num| "#{label}=#{num}" }.join(", ")
    annotations[table].add("  -- RAILS ENUM: #{column} values: #{formatted}")

    # Detect enum-based soft delete patterns
    values.each do |label, num|
      if SOFT_DELETE_LABELS.include?(label.downcase)
        annotations[table].add("  -- ENUM SOFT DELETE: #{column} != #{num} to exclude #{label.downcase} records (do NOT use deleted_at)")
        enum_soft_delete_tables.add(table)
        break
      end
    end
  end
end
```

Add the new detection method:

```ruby
SOFT_DELETE_GEMS = [
  "Paranoia",
  "Discard::Model",
].freeze

def detect_soft_delete_gem(model, table, soft_delete_tables)
  SOFT_DELETE_GEMS.each do |gem_module_name|
    mod = gem_module_name.safe_constantize rescue nil
    next unless mod

    if model.ancestors.include?(mod)
      soft_delete_tables.add(table)
      return
    end
  end

  # Also check for acts_as_paranoid class method (older API)
  if model.respond_to?(:acts_as_paranoid?) && model.acts_as_paranoid?
    soft_delete_tables.add(table)
  end
end
```

Note: `String#safe_constantize` is a Rails method. For the `rescue nil` fallback, use:

```ruby
def detect_soft_delete_gem(model, table, soft_delete_tables)
  SOFT_DELETE_GEMS.each do |gem_module_name|
    begin
      mod = Object.const_get(gem_module_name)
      if model.ancestors.include?(mod)
        soft_delete_tables.add(table)
        return
      end
    rescue NameError
      # Gem not installed, skip
    end
  end

  # Also check for acts_as_paranoid class method (older API)
  if model.respond_to?(:acts_as_paranoid?) && model.acts_as_paranoid?
    soft_delete_tables.add(table)
  end
end
```

- [ ] **Step 4: Update existing tests that call `.introspect`**

All existing tests access the result as a Hash. They now need to access `result.annotations`. Update every test that does `result = introspector.introspect` followed by `result["table_name"]` to use `result.annotations["table_name"]` instead.

The test at "with Rails enums" becomes:
```ruby
it "detects enum and returns annotation" do
  result = introspector.introspect
  expect(result.annotations).to have_key("jobs")
  expect(result.annotations["jobs"]).to include(
    a_string_matching(/RAILS ENUM: status values: Active=1, Pending=2, Deleted=3/)
  )
end
```

Apply the same `.annotations` change to ALL existing test expectations that access `result[table_name]` or `result.to have_key`.

Also update "with both enums and non-standard FKs" — the annotation count is still 3 (RAILS ENUM + ENUM SOFT DELETE + MODEL FK).

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/model_introspector_spec.rb
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/model_introspector.rb sql-chatbot-rails/spec/sql_chatbot/services/model_introspector_spec.rb
git commit -m "feat(rails): add soft delete gem detection to ModelIntrospector"
```

---

## Task 2: SchemaService — Conditional Soft Delete Annotations

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb`

- [ ] **Step 1: Write failing tests**

Add to the schema_service_spec (find the appropriate location or create a new context):

```ruby
describe "#apply_soft_delete_annotations" do
  let(:service) { described_class.new }

  before do
    # Set up a schema summary with deferred soft delete columns
    service.instance_variable_set(:@summary_text, [
      "TABLE customers (id INT PK, name VARCHAR, status INT, deleted_at TIMESTAMP)",
      "TABLE posts (id INT PK, title VARCHAR, discarded_at TIMESTAMP)",
      "TABLE settings (id INT PK, key VARCHAR, deleted_at TIMESTAMP)",
    ].join("\n"))
    service.instance_variable_set(:@deferred_soft_deletes, {
      "customers" => ["deleted_at"],
      "posts" => ["discarded_at"],
      "settings" => ["deleted_at"],
    })
  end

  it "adds SOFT DELETE for tables with soft delete gem" do
    service.apply_soft_delete_annotations(
      soft_delete_tables: Set.new(["posts"]),
      enum_soft_delete_tables: Set.new
    )
    expect(service.summary).to include("SOFT DELETE: filter discarded_at IS NULL")
  end

  it "suppresses SOFT DELETE for tables with enum soft delete and no gem" do
    service.apply_soft_delete_annotations(
      soft_delete_tables: Set.new,
      enum_soft_delete_tables: Set.new(["customers"])
    )
    expect(service.summary).not_to include("SOFT DELETE: filter deleted_at IS NULL for active records")
  end

  it "adds SOFT DELETE for tables with neither gem nor enum soft delete" do
    service.apply_soft_delete_annotations(
      soft_delete_tables: Set.new,
      enum_soft_delete_tables: Set.new
    )
    expect(service.summary).to include("SOFT DELETE: filter deleted_at IS NULL")
  end

  it "adds SOFT DELETE when table has both gem and enum soft delete (gem wins)" do
    service.apply_soft_delete_annotations(
      soft_delete_tables: Set.new(["customers"]),
      enum_soft_delete_tables: Set.new(["customers"])
    )
    expect(service.summary).to include("SOFT DELETE: filter deleted_at IS NULL")
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb
```

Expected: FAIL — `NoMethodError: undefined method 'apply_soft_delete_annotations'`

- [ ] **Step 3: Implement deferred soft delete annotations**

In `SchemaService#discover`, change the soft delete annotation logic (around line 209-212) from:

```ruby
# Soft delete annotation
if SOFT_DELETE_COLUMNS.include?(col["column_name"])
  annotations << "  -- SOFT DELETE: filter #{col['column_name']} IS NULL for active records"
end
```

To defer it:

```ruby
# Defer soft delete annotation (applied after model introspection)
if SOFT_DELETE_COLUMNS.include?(col["column_name"])
  (@deferred_soft_deletes ||= {})[table] ||= []
  @deferred_soft_deletes[table] << col["column_name"]
end
```

Add the new public method:

```ruby
# Apply soft delete annotations conditionally based on model introspection results.
# - Tables using a soft delete gem (paranoia, discard): always add SOFT DELETE annotation
# - Tables with enum soft delete but no gem: suppress SOFT DELETE (enum is the real mechanism)
# - Tables with neither: add SOFT DELETE annotation (assume column is used)
def apply_soft_delete_annotations(soft_delete_tables:, enum_soft_delete_tables:)
  return if @deferred_soft_deletes.nil? || @deferred_soft_deletes.empty?

  new_annotations = {}
  @deferred_soft_deletes.each do |table, columns|
    if soft_delete_tables.include?(table)
      # Gem manages this column — keep the annotation
      columns.each do |col|
        (new_annotations[table] ||= []) << "  -- SOFT DELETE: filter #{col} IS NULL for active records"
      end
    elsif enum_soft_delete_tables.include?(table)
      # Enum is the real soft delete, column is likely unused — suppress
      next
    else
      # No competing mechanism — assume column is used
      columns.each do |col|
        (new_annotations[table] ||= []) << "  -- SOFT DELETE: filter #{col} IS NULL for active records"
      end
    end
  end

  append_model_annotations(new_annotations) unless new_annotations.empty?
end
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb
git commit -m "feat(rails): defer soft delete annotations, apply conditionally based on model introspection"
```

---

## Task 3: SchemaService — Move Lookup Values to FK Columns

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb`

- [ ] **Step 1: Write failing tests**

Add to the schema_service_spec:

```ruby
describe "FK lookup value annotations" do
  let(:service) { described_class.new }

  it "annotates explicit FK columns instead of lookup tables" do
    service.instance_variable_set(:@summary_text, [
      "TABLE categories (id INT PK, name VARCHAR)",
      "  -- VALUES: 1=Tv Shows, 2=Movie",
      "TABLE titles (id INT PK, name VARCHAR, category_id INT FK=>categories.id, status INT)",
    ].join("\n"))

    service.relocate_lookup_annotations

    expect(service.summary).to include("FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie")
    expect(service.summary).not_to include("-- VALUES:")
  end

  it "annotates convention-based FK columns (no explicit FK marker)" do
    service.instance_variable_set(:@summary_text, [
      "TABLE categories (id INT PK, name VARCHAR)",
      "  -- VALUES: 1=Tv Shows, 2=Movie",
      "TABLE titles (id INT PK, name VARCHAR, category_id INT, status INT)",
    ].join("\n"))

    service.relocate_lookup_annotations

    expect(service.summary).to include("FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie")
    expect(service.summary).not_to include("-- VALUES:")
  end

  it "annotates multiple FK columns referencing the same lookup table" do
    service.instance_variable_set(:@summary_text, [
      "TABLE categories (id INT PK, name VARCHAR)",
      "  -- VALUES: 1=Tv Shows, 2=Movie",
      "TABLE titles (id INT PK, category_id INT FK=>categories.id)",
      "TABLE posts (id INT PK, category_id INT)",
    ].join("\n"))

    service.relocate_lookup_annotations

    expect(service.summary).not_to include("-- VALUES:")
    lines = service.summary.split("\n")
    fk_lookups = lines.select { |l| l.include?("FK LOOKUP") }
    expect(fk_lookups.length).to eq(2)
  end

  it "does nothing when no VALUES annotations exist" do
    original = "TABLE titles (id INT PK, name VARCHAR)"
    service.instance_variable_set(:@summary_text, original)

    service.relocate_lookup_annotations

    expect(service.summary).to eq(original)
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb
```

Expected: FAIL — `NoMethodError: undefined method 'relocate_lookup_annotations'`

- [ ] **Step 3: Implement relocate_lookup_annotations**

Add this public method to `SchemaService`:

```ruby
# Move "-- VALUES:" annotations from lookup tables to the FK columns that reference them.
# Parses the schema summary text, finds VALUES annotations, matches them to FK columns
# via "FK=>table.column" markers, and re-emits as "-- FK LOOKUP: fk_col values: ..."
def relocate_lookup_annotations
  lines = @summary_text.split("\n")
  
  # Step 1: Extract VALUES annotations and their tables
  lookup_values = {} # table_name => values_string
  lines_without_values = []
  current_table = nil

  lines.each do |line|
    if line.start_with?("TABLE ")
      current_table = line.match(/^TABLE (\S+)/)[1]
    end

    if line.strip.start_with?("-- VALUES:")
      lookup_values[current_table] = line.strip.sub("-- VALUES: ", "") if current_table
    else
      lines_without_values << line
    end
  end

  return if lookup_values.empty?

  # Step 2: Build convention-based table name patterns for matching
  # e.g., "categories" => matches "category_id" column
  convention_map = {} # singularized_name + "_id" => lookup_table
  lookup_values.each_key do |table|
    # Simple singularization: remove trailing 's', handle 'ies' -> 'y'
    singular = if table.end_with?("ies")
                 table[0..-4] + "y"
               elsif table.end_with?("ses")
                 table[0..-3]
               elsif table.end_with?("s")
                 table[0..-2]
               else
                 table
               end
    convention_map["#{singular}_id"] = table
  end

  # Step 3: Find FK columns that reference lookup tables and inject FK LOOKUP annotations
  result = []
  lines_without_values.each do |line|
    result << line

    if line.start_with?("TABLE ")
      # Match explicit FK references: "column_name INT FK=>target_table.target_column"
      lookup_values.each do |lookup_table, values|
        line.scan(/(\w+)\s+\w+\s+FK=>#{Regexp.escape(lookup_table)}\.(\w+)/).each do |fk_col, _target_col|
          result << "  -- FK LOOKUP: #{fk_col} values: #{values}"
        end
      end

      # Match convention-based references: "category_id INT" (no FK=> marker)
      convention_map.each do |fk_col_name, lookup_table|
        # Only if not already matched by explicit FK above
        next if line.include?("#{fk_col_name} ") && line.include?("FK=>#{lookup_table}")
        if line.match?(/\b#{Regexp.escape(fk_col_name)}\s+\w+(?!\s+FK)/)
          result << "  -- FK LOOKUP: #{fk_col_name} values: #{lookup_values[lookup_table]}"
        end
      end
    end
  end

  @summary_text = result.join("\n")
end
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb
git commit -m "feat(rails): move lookup values from referenced tables to FK columns"
```

---

## Task 4: Update Prompt Rule 16 and Initialization Flow

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/prompts/generate_sql.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot_rails.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/prompts/generate_sql_spec.rb`

- [ ] **Step 1: Update Rule 16 in generate_sql.rb**

Change Rule 16 from:

```
16. LOOKUP VALUES: When a table has "-- VALUES: id=name" mappings, use these exact IDs in WHERE clauses. For example, if categories shows "1=TV Shows, 2=Movie" and the user asks about movies, use category_id = 2
```

To:

```
16. FK LOOKUP VALUES: When a table has "-- FK LOOKUP: column values: id=name, ..." annotation, use these exact IDs in WHERE clauses for that specific column. For example, "FK LOOKUP: category_id values: 1=Tv Shows, 2=Movie" means use WHERE category_id = 2 for movies. Never use a different column (like status) for category filtering.
```

- [ ] **Step 2: Update initialization flow in sql_chatbot_rails.rb**

Change the `ensure_initialized!` method from:

```ruby
@schema_service = Services::SchemaService.new
@schema_service.discover

# Introspect Rails models for enums and non-standard FKs
introspector = Services::ModelIntrospector.new
model_annotations = introspector.introspect
@schema_service.append_model_annotations(model_annotations)
```

To:

```ruby
@schema_service = Services::SchemaService.new
@schema_service.discover

# Introspect Rails models for enums, non-standard FKs, and soft delete gems
introspector = Services::ModelIntrospector.new
introspection = introspector.introspect

# Apply soft delete annotations conditionally (gem-based vs enum-based)
@schema_service.apply_soft_delete_annotations(
  soft_delete_tables: introspection.soft_delete_tables,
  enum_soft_delete_tables: introspection.enum_soft_delete_tables,
)

# Inject model annotations (enums, FKs)
@schema_service.append_model_annotations(introspection.annotations)

# Move lookup values from referenced tables to FK columns
@schema_service.relocate_lookup_annotations
```

- [ ] **Step 3: Update prompt rule test**

In `generate_sql_spec.rb`, update the Rule 16 test. Find the test that checks for `LOOKUP VALUES` or `VALUES` and change it to check for `FK LOOKUP`:

```ruby
it "includes rule 16 about FK LOOKUP values" do
  messages = described_class.build_messages(question: "test", schema: "")
  system = messages.first[:content]
  expect(system).to include("FK LOOKUP VALUES")
  expect(system).to include("FK LOOKUP: category_id")
end
```

- [ ] **Step 4: Run all tests**

```bash
cd sql-chatbot-rails && bundle exec rspec
```

Expected: All tests PASS (270+ existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/prompts/generate_sql.rb sql-chatbot-rails/lib/sql_chatbot_rails.rb sql-chatbot-rails/spec/sql_chatbot/prompts/generate_sql_spec.rb
git commit -m "feat(rails): update prompt rule 16 for FK LOOKUP, wire up initialization flow"
```

---

## Task 5: Full Test Suite Verification

- [ ] **Step 1: Run full gem test suite**

```bash
cd sql-chatbot-rails && bundle exec rspec
```

Expected: All tests PASS (270 existing + new tests from Tasks 1-4)

- [ ] **Step 2: Verify no regressions**

Check that existing annotation types still work:
- RAILS ENUM annotations still present
- ENUM SOFT DELETE annotations still present
- MODEL FK annotations still present
- POLYMORPHIC annotations still present
- PG ENUM annotations still present

- [ ] **Step 3: Commit if any adjustments needed**

```bash
git add -A sql-chatbot-rails/
git commit -m "test: verify all tests pass for SQL accuracy fixes"
```

---

## What's NOT in This Plan

- **E2E browser testing** — done separately after implementation, on MSP and 2BNCHILL
- **npm package changes** — these fixes are Rails gem only
- **Prompt rule priority overhaul** — the conditional annotation approach avoids rule conflicts entirely
- **Data-based soft delete detection** — rejected in design phase; code-based detection is more reliable
