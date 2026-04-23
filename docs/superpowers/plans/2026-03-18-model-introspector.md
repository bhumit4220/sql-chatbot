# ModelIntrospector Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Rails enums and non-standard foreign keys at boot time so developers need minimal `custom_context` configuration.

**Architecture:** New `ModelIntrospector` service that uses Rails runtime APIs (`defined_enums`, `reflect_on_all_associations`) to discover application-level metadata invisible to DB introspection. Runs once at boot, zero DB queries, results injected into the schema summary alongside existing annotations.

**Tech Stack:** Ruby, Rails 4.1+ APIs (verified stable through Rails 8), RSpec.

**Memory context:** See `memory/project_model_introspector.md` for design decisions and API verification.

---

## File Structure

```
sql-chatbot-rails/
  lib/
    sql_chatbot_rails.rb                              # MODIFY: require + boot integration
    sql_chatbot/
      services/
        model_introspector.rb                         # CREATE: core introspection service
        schema_service.rb                             # MODIFY: add append_model_annotations method
      prompts/
        generate_sql.rb                               # MODIFY: add rules 18-19 for RAILS ENUM and MODEL FK
  spec/
    sql_chatbot/
      services/
        model_introspector_spec.rb                    # CREATE: unit tests
        schema_service_spec.rb                        # MODIFY: add tests for append_model_annotations
```

---

## Task 1: ModelIntrospector Service

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/services/model_introspector.rb`
- Create: `sql-chatbot-rails/spec/sql_chatbot/services/model_introspector_spec.rb`

- [ ] **Step 1: Write failing tests for ModelIntrospector**

Create `sql-chatbot-rails/spec/sql_chatbot/services/model_introspector_spec.rb`:

```ruby
# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/model_introspector"

RSpec.describe SqlChatbot::Services::ModelIntrospector do
  let(:introspector) { described_class.new }

  # Helper: create a fake model class that duck-types ActiveRecord model API
  def fake_model(table_name:, enums: {}, associations: [], abstract: false, table_exists: true)
    Class.new do
      define_singleton_method(:table_name) { table_name }
      define_singleton_method(:abstract_class?) { abstract }
      define_singleton_method(:table_exists?) { table_exists }
      define_singleton_method(:defined_enums) { enums }
      define_singleton_method(:reflect_on_all_associations) { |*| associations }
    end
  end

  # Helper: create a fake belongs_to reflection
  def fake_reflection(name:, foreign_key: nil, class_name: nil, polymorphic: false)
    fk = foreign_key || "#{name}_id"
    cn = class_name || name.to_s.split("_").map(&:capitalize).join
    ref_name = name.to_sym

    Object.new.tap do |r|
      r.define_singleton_method(:name) { ref_name }
      r.define_singleton_method(:foreign_key) { fk }
      r.define_singleton_method(:class_name) { cn }
      r.define_singleton_method(:polymorphic?) { polymorphic }
    end
  end

  describe "#introspect" do
    context "when ActiveRecord is not defined" do
      before { hide_const("ActiveRecord::Base") if defined?(ActiveRecord::Base) }

      it "returns empty hash" do
        expect(introspector.introspect).to eq({})
      end
    end

    context "when no models exist" do
      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
      end

      it "returns empty hash" do
        expect(introspector.introspect).to eq({})
      end
    end

    context "with Rails enums" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "status" => { "Active" => 1, "Pending" => 2, "Deleted" => 3 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects enum and returns annotation" do
        result = introspector.introspect
        expect(result).to have_key("jobs")
        expect(result["jobs"]).to include(
          a_string_matching(/RAILS ENUM: status values: Active=1, Pending=2, Deleted=3/)
        )
      end
    end

    context "with multiple enums on one model" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: {
            "status" => { "Active" => 1, "Pending" => 2 },
            "priority" => { "Low" => 0, "High" => 1 }
          }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects all enums" do
        result = introspector.introspect
        expect(result["jobs"].length).to eq(2)
        expect(result["jobs"]).to include(a_string_matching(/status values:/))
        expect(result["jobs"]).to include(a_string_matching(/priority values:/))
      end
    end

    context "with non-standard foreign key" do
      let(:reflection) do
        fake_reflection(name: :creator, foreign_key: "created_by", class_name: "Customer")
      end
      let(:model) do
        fake_model(table_name: "jobs", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects non-standard FK" do
        result = introspector.introspect
        expect(result["jobs"]).to include(
          a_string_matching(/MODEL FK: created_by -> .+\.id/)
        )
      end
    end

    context "with custom class_name but standard FK" do
      let(:reflection) do
        fake_reflection(name: :author, foreign_key: "author_id", class_name: "User")
      end
      let(:model) do
        fake_model(table_name: "posts", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects custom class name" do
        result = introspector.introspect
        expect(result["posts"]).to include(
          a_string_matching(/MODEL FK: author_id -> .+\.id/)
        )
      end
    end

    context "with standard belongs_to" do
      let(:reflection) do
        fake_reflection(name: :customer, foreign_key: "customer_id", class_name: "Customer")
      end
      let(:model) do
        fake_model(table_name: "orders", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips standard associations" do
        result = introspector.introspect
        expect(result).to be_empty
      end
    end

    context "with polymorphic association" do
      let(:reflection) do
        fake_reflection(name: :commentable, polymorphic: true)
      end
      let(:model) do
        fake_model(table_name: "comments", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips polymorphic associations (already detected by schema_service)" do
        result = introspector.introspect
        expect(result).to be_empty
      end
    end

    context "with abstract model" do
      let(:model) do
        fake_model(
          table_name: "abstract_records",
          enums: { "status" => { "Active" => 1 } },
          abstract: true
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips abstract models" do
        expect(introspector.introspect).to be_empty
      end
    end

    context "when table_exists? raises" do
      let(:model) do
        klass = fake_model(table_name: "broken")
        allow(klass).to receive(:table_exists?).and_raise(StandardError.new("no connection"))
        klass
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips the model gracefully" do
        expect(introspector.introspect).to be_empty
      end
    end

    context "with STI models sharing a table" do
      let(:parent) do
        fake_model(
          table_name: "animals",
          enums: { "status" => { "Alive" => 0, "Deceased" => 1 } }
        )
      end
      let(:child) do
        fake_model(
          table_name: "animals",
          enums: { "status" => { "Alive" => 0, "Deceased" => 1 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([parent, child])
      end

      it "deduplicates annotations for the same table" do
        result = introspector.introspect
        expect(result["animals"].length).to eq(1)
      end
    end

    context "with both enums and non-standard FKs" do
      let(:reflection) do
        fake_reflection(name: :creator, foreign_key: "created_by", class_name: "Customer")
      end
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "status" => { "Active" => 1, "Pending" => 2, "Deleted" => 3 } },
          associations: [reflection]
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "returns both enum and FK annotations" do
        result = introspector.introspect
        expect(result["jobs"].length).to eq(2)
        expect(result["jobs"]).to include(a_string_matching(/RAILS ENUM/))
        expect(result["jobs"]).to include(a_string_matching(/MODEL FK/))
      end
    end
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/model_introspector_spec.rb`
Expected: FAIL — `cannot load such file -- sql_chatbot/services/model_introspector`

- [ ] **Step 3: Write ModelIntrospector implementation**

Create `sql-chatbot-rails/lib/sql_chatbot/services/model_introspector.rb`:

```ruby
# frozen_string_literal: true

module SqlChatbot
  module Services
    class ModelIntrospector
      # Returns Hash of table_name => [annotation_strings]
      # Annotations match the schema summary format: "  -- TYPE: details"
      def introspect
        annotations = Hash.new { |h, k| h[k] = Set.new }

        models = discover_models
        models.each do |model|
          table = model.table_name

          detect_enums(model, table, annotations)
          detect_associations(model, table, annotations)
        end

        # Convert Sets to Arrays (deduplication handles STI)
        annotations.transform_values(&:to_a)
      end

      private

      def discover_models
        return [] unless defined?(ActiveRecord::Base)

        load_models

        ActiveRecord::Base.descendants.select do |model|
          !model.abstract_class? &&
            model.respond_to?(:table_name) &&
            safe_table_exists?(model)
        end
      end

      def load_models
        return unless defined?(Rails) && Rails.respond_to?(:application) && Rails.application

        if Rails.application.config.eager_load
          return # Production: already loaded
        end

        # Development/test: load model files via Zeitwerk if available
        if defined?(Zeitwerk) && Rails.autoloaders.respond_to?(:main)
          model_paths = Rails.application.paths["app/models"]&.to_a || []
          model_paths.each do |path|
            abs_path = Rails.root.join(path).to_s
            Rails.autoloaders.main.eager_load_dir(abs_path) if Dir.exist?(abs_path)
          end
        else
          # Fallback for older Rails: eager_load everything
          Rails.application.eager_load!
        end
      rescue => e
        warn "[SqlChatbot] ModelIntrospector: Could not load models: #{e.message}"
      end

      def safe_table_exists?(model)
        model.table_exists?
      rescue => _e
        false
      end

      def detect_enums(model, table, annotations)
        return unless model.respond_to?(:defined_enums)

        model.defined_enums.each do |column, values|
          next if values.empty?

          formatted = values.map { |label, num| "#{label}=#{num}" }.join(", ")
          annotations[table].add("  -- RAILS ENUM: #{column} values: #{formatted}")
        end
      end

      def detect_associations(model, table, annotations)
        return unless model.respond_to?(:reflect_on_all_associations)

        model.reflect_on_all_associations(:belongs_to).each do |reflection|
          next if reflection.respond_to?(:polymorphic?) && reflection.polymorphic?

          fk = reflection.foreign_key.to_s
          target_class = reflection.class_name
          standard_fk = "#{reflection.name}_id"
          standard_class = reflection.name.to_s.split("_").map(&:capitalize).join

          non_standard_fk = (fk != standard_fk)
          non_standard_class = (target_class != standard_class)

          next unless non_standard_fk || non_standard_class

          target_table = resolve_table_name(target_class)

          detail = "belongs_to :#{reflection.name}"
          detail += ", class_name: \"#{target_class}\"" if non_standard_class
          detail += ", foreign_key: \"#{fk}\"" if non_standard_fk

          annotations[table].add("  -- MODEL FK: #{fk} -> #{target_table}.id (#{detail})")
        end
      end

      def resolve_table_name(class_name)
        class_name.constantize.table_name
      rescue NameError
        # Fallback: simple pluralization
        class_name.gsub(/([a-z])([A-Z])/, '\1_\2').downcase + "s"
      end
    end
  end
end
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/model_introspector_spec.rb -fd`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd sql-chatbot-rails
git add lib/sql_chatbot/services/model_introspector.rb spec/sql_chatbot/services/model_introspector_spec.rb
git commit -m "feat(rails): add ModelIntrospector service for auto-detecting Rails enums and non-standard FKs"
```

---

## Task 2: SchemaService#append_model_annotations

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb:68-69` (add method)
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb` (add tests)

- [ ] **Step 1: Write failing tests for append_model_annotations**

Add to the end of `sql-chatbot-rails/spec/sql_chatbot/services/schema_service_spec.rb`, before the final `end`:

```ruby
describe "#append_model_annotations" do
  let(:service) { described_class.new }

  before do
    # Set up a fake summary_text (bypass discover)
    service.instance_variable_set(:@summary_text, <<~SCHEMA.strip)
      TABLE users (id INT PK, name VARCHAR)
        -- SOFT DELETE: filter deleted_at IS NULL for active records
      TABLE jobs (id INT PK, created_by INT, status INT)
      TABLE transactions (id INT PK, type VARCHAR, amount DECIMAL)
        -- POLYMORPHIC: commentable_type + commentable_id
    SCHEMA
  end

  it "injects annotations after the correct table" do
    annotations = {
      "jobs" => ["  -- RAILS ENUM: status values: Active=1, Pending=2, Deleted=3"]
    }
    service.append_model_annotations(annotations)

    lines = service.summary.split("\n")
    jobs_idx = lines.index { |l| l.start_with?("TABLE jobs") }
    expect(lines[jobs_idx + 1]).to include("RAILS ENUM: status")
  end

  it "appends after existing annotations for a table" do
    annotations = {
      "users" => ["  -- RAILS ENUM: role values: Admin=0, User=1"]
    }
    service.append_model_annotations(annotations)

    lines = service.summary.split("\n")
    users_idx = lines.index { |l| l.start_with?("TABLE users") }
    # Existing annotation is at users_idx + 1
    expect(lines[users_idx + 1]).to include("SOFT DELETE")
    # New annotation at users_idx + 2
    expect(lines[users_idx + 2]).to include("RAILS ENUM: role")
  end

  it "handles multiple annotations for one table" do
    annotations = {
      "jobs" => [
        "  -- RAILS ENUM: status values: Active=1, Deleted=3",
        "  -- MODEL FK: created_by -> customers.id (belongs_to :creator)"
      ]
    }
    service.append_model_annotations(annotations)

    lines = service.summary.split("\n")
    jobs_idx = lines.index { |l| l.start_with?("TABLE jobs") }
    expect(lines[jobs_idx + 1]).to include("RAILS ENUM")
    expect(lines[jobs_idx + 2]).to include("MODEL FK")
  end

  it "handles annotations for the last table" do
    annotations = {
      "transactions" => ["  -- RAILS ENUM: kind values: Credit=0, Debit=1"]
    }
    service.append_model_annotations(annotations)

    lines = service.summary.split("\n")
    expect(lines.last).to include("RAILS ENUM: kind")
  end

  it "does nothing with empty annotations" do
    original = service.summary.dup
    service.append_model_annotations({})
    expect(service.summary).to eq(original)
  end

  it "does nothing with nil annotations" do
    original = service.summary.dup
    service.append_model_annotations(nil)
    expect(service.summary).to eq(original)
  end

  it "ignores annotations for tables not in the schema" do
    original = service.summary.dup
    service.append_model_annotations({ "nonexistent" => ["  -- RAILS ENUM: x values: A=1"] })
    expect(service.summary).to eq(original)
  end
end
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb -fd --tag ~requires_db`
Expected: FAIL — `undefined method 'append_model_annotations'`

- [ ] **Step 3: Implement append_model_annotations**

Add to `sql-chatbot-rails/lib/sql_chatbot/services/schema_service.rb`, after the `summary` method (around line 69), add:

```ruby
# Inject model-level annotations (from ModelIntrospector) into the schema summary.
# annotations_by_table: Hash of table_name => [annotation_strings]
# Each annotation is inserted after the TABLE line and any existing annotations.
def append_model_annotations(annotations_by_table)
  return if annotations_by_table.nil? || annotations_by_table.empty?

  lines = @summary_text.split("\n")
  result = []
  current_table = nil

  lines.each do |line|
    if line.start_with?("TABLE ")
      # Before moving to next table, flush pending annotations for previous table
      if current_table && annotations_by_table.key?(current_table)
        annotations_by_table[current_table].each { |ann| result << ann }
      end
      current_table = line.match(/^TABLE (\S+)/)[1]
    end
    result << line
  end

  # Flush annotations for the last table
  if current_table && annotations_by_table.key?(current_table)
    annotations_by_table[current_table].each { |ann| result << ann }
  end

  @summary_text = result.join("\n")
end
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/schema_service_spec.rb -fd --tag ~requires_db`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd sql-chatbot-rails
git add lib/sql_chatbot/services/schema_service.rb spec/sql_chatbot/services/schema_service_spec.rb
git commit -m "feat(rails): add SchemaService#append_model_annotations for injecting model metadata"
```

---

## Task 3: Generate SQL Prompt Updates

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/prompts/generate_sql.rb:6-29` (add rules 18-19)
- Modify: `sql-chatbot-rails/spec/sql_chatbot/prompts/generate_sql_spec.rb` (add tests)

- [ ] **Step 1: Write failing tests for new prompt rules**

Add to `sql-chatbot-rails/spec/sql_chatbot/prompts/generate_sql_spec.rb`, inside the existing `describe ".build_messages"` block:

```ruby
it "includes rule 18 about RAILS ENUM values" do
  messages = described_class.build_messages(question: "test", schema: "TABLE t (id INT)")
  system = messages.first[:content]
  expect(system).to include("RAILS ENUM")
  expect(system).to include("NUMERIC value")
end

it "includes rule 19 about MODEL FK joins" do
  messages = described_class.build_messages(question: "test", schema: "TABLE t (id INT)")
  system = messages.first[:content]
  expect(system).to include("MODEL FK")
  expect(system).to include("MODEL FOREIGN KEYS")
end

it "includes all 19 rules in system prompt" do
  messages = described_class.build_messages(question: "test", schema: "TABLE t (id INT)")
  system = messages.first[:content]
  (1..19).each { |n| expect(system).to include("#{n}.") }
end
```

**Note:** Also update the existing test `"includes all 17 rules in system prompt"` — change `(1..17)` to `(1..19)` and rename the test description to `"includes all 19 rules"`. The new test above can replace the old one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/prompts/generate_sql_spec.rb -fd`
Expected: FAIL — system prompt does not contain "RAILS ENUM" or "MODEL FK"

- [ ] **Step 3: Add rules 18-19 to generate_sql.rb**

In `sql-chatbot-rails/lib/sql_chatbot/prompts/generate_sql.rb`, after rule 17, add:

```
        18. RAILS ENUM VALUES: When a table has "-- RAILS ENUM: column values: Label=N, ..." annotation, the database stores the NUMERIC value N, not the label string. Use WHERE column = N. For example, if "RAILS ENUM: status values: Active=1, Pending=2, Deleted=3", use WHERE status = 1 for active records and WHERE status != 3 to exclude deleted.
        19. MODEL FOREIGN KEYS: When a table has "-- MODEL FK: column -> target_table.id" annotation, use this column for JOINs even if it doesn't follow standard naming. For example, "MODEL FK: created_by -> customers.id" means JOIN customers ON jobs.created_by = customers.id.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/prompts/generate_sql_spec.rb -fd`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd sql-chatbot-rails
git add lib/sql_chatbot/prompts/generate_sql.rb spec/sql_chatbot/prompts/generate_sql_spec.rb
git commit -m "feat(rails): add prompt rules 18-19 for RAILS ENUM and MODEL FK annotations"
```

---

## Task 4: Boot Integration

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot_rails.rb:1-13` (add require) and `:33-59` (add introspection to boot)

- [ ] **Step 1: Add require for model_introspector**

In `sql-chatbot-rails/lib/sql_chatbot_rails.rb`, after line 12 (`require "sql_chatbot/services/orchestrator"`), add:

```ruby
require "sql_chatbot/services/model_introspector"
```

- [ ] **Step 2: Add ModelIntrospector to ensure_initialized!**

In `sql-chatbot-rails/lib/sql_chatbot_rails.rb`, inside `ensure_initialized!`, after line 41 (`@schema_service.discover`), add:

```ruby
        # Introspect Rails models for enums and non-standard FKs
        introspector = Services::ModelIntrospector.new
        model_annotations = introspector.introspect
        @schema_service.append_model_annotations(model_annotations)
```

- [ ] **Step 3: Add model_introspector to reset!**

No changes needed — `reset!` already sets `@schema_service = nil` which discards the annotations.

- [ ] **Step 4: Run full test suite to verify nothing breaks**

Run: `cd sql-chatbot-rails && bundle exec rspec -fd`
Expected: All existing tests PASS (ModelIntrospector is a no-op when ActiveRecord::Base has no descendants, which is the case in unit tests)

- [ ] **Step 5: Commit**

```bash
cd sql-chatbot-rails
git add lib/sql_chatbot_rails.rb
git commit -m "feat(rails): integrate ModelIntrospector into boot sequence"
```

---

## Task 5: Full Test Suite Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd sql-chatbot-rails && bundle exec rspec -fd`
Expected: All tests PASS

- [ ] **Step 2: Run integration tests specifically**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/integration/ -fd`
Expected: All integration tests PASS

- [ ] **Step 3: Verify no regressions in existing specs**

Run: `cd sql-chatbot-rails && bundle exec rspec --format documentation 2>&1 | tail -5`
Expected: `0 failures` in output

- [ ] **Step 4: Commit any fixes if needed**

Only if Step 1-3 revealed issues.

---

## Summary of Changes

| Component | What Changes | Why |
|-----------|-------------|-----|
| `model_introspector.rb` | NEW: discovers Rails enums + non-standard FKs | Core feature — auto-detects app-level metadata |
| `schema_service.rb` | ADD: `append_model_annotations` method | Injects model annotations into schema summary |
| `generate_sql.rb` | ADD: rules 18-19 | Teaches LLM to use RAILS ENUM numbers and MODEL FK joins |
| `sql_chatbot_rails.rb` | ADD: require + 3 lines in boot | Wires ModelIntrospector into the initialization pipeline |

**What this eliminates from `custom_context`:**
- Rails integer enums (status codes, types, priorities) — auto-detected
- Non-standard foreign keys (created_by, updated_by, etc.) — auto-detected
- Custom class names on associations — auto-detected

**What still needs `custom_context`:**
- Business rules ("always exclude test accounts")
- Non-association join chains
- App-specific exclusion patterns
