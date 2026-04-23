# Compositional Grammar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace arbitrary LLM SQL generation with a compositional grammar (7 primitives × 8 modifiers) auto-derived from schema + code + data. Grammar runs first, LLM is fallback.

**Architecture:** Two layers on top of today's pipeline — a shared Metadata Registry (built from Rails AR introspection or npm Django AST parser) plus a Grammar pipeline (Intent Extractor LLM → Template Compiler deterministic → existing validator/executor). Grammar path is additive; today's LLM pipeline stays byte-identical as fallback.

**Tech Stack:** TypeScript/Node (npm package `packages/agent`), Ruby/Rails (gem `sql-chatbot-rails`), Python stdlib `ast` (Django parser, dev-time only), PostgreSQL, vitest, rspec.

**Spec:** [`docs/superpowers/specs/2026-04-23-compositional-grammar-design.md`](../specs/2026-04-23-compositional-grammar-design.md)
**Master index:** [`docs/grammar/README.md`](../../grammar/README.md) — **MUST BE UPDATED** at end of each session and each phase.
**Branch:** `feature/compositional-grammar` — stays independent. **No merge steps in this plan.**

---

## File Structure

### npm package (`packages/agent/`)

```
src/grammar/
├── registry.ts                     — types (Registry, Entity, Field, Scope, Association) + lookup helpers
├── registry-loader.ts              — load manifest JSON or build schema-only registry
├── entity-candidates.ts            — pre-select top-5 entities (string/alias match)
├── intent-extractor.ts             — LLM call + JSON parse + confidence gate
├── primitives.ts                   — 7 primitive template functions
├── modifiers.ts                    — 8 modifier appliers
├── template-compiler.ts            — orchestrates primitives + modifiers
├── miss-logger.ts                  — ndjson append to logs/grammar-misses.ndjson
├── try-grammar-path.ts             — top-level entry: question → SQL or miss
└── introspectors/
    ├── django.ts                   — Node wrapper (spawns Python subprocess)
    └── scripts/django_introspect.py — stdlib Python AST walker

src/__tests__/grammar/              — unit + integration tests

src/cli.ts                          — MODIFY: add `introspect` subcommand
src/config.ts                       — MODIFY: add `grammar.enabled` flag
src/services/orchestrator.ts        — MODIFY: `handleData` branches on grammar result
src/index.ts                        — MODIFY: export new types
```

### Rails gem (`sql-chatbot-rails/`)

```
lib/sql_chatbot/grammar/
├── registry.rb                     — Struct-based Registry matching TS shape
├── entity_candidates.rb
├── intent_extractor.rb
├── primitives.rb
├── modifiers.rb
├── template_compiler.rb
├── miss_logger.rb
└── try_grammar_path.rb

lib/sql_chatbot/services/
├── registry_builder.rb             — AR models → Registry (NEW)
└── grammar_pipeline.rb             — wire grammar into existing controller flow (NEW)

spec/sql_chatbot/grammar/           — rspec unit + integration
lib/sql_chatbot/config.rb           — MODIFY: add `grammar_enabled` setting
app/controllers/sql_chatbot/chat_controller.rb — MODIFY: grammar branch
```

---

## Conventions used in this plan

- Every Task has: **Files**, **Steps** (each a checkbox). Steps are 2-5 min each.
- Every test step shows expected pass/fail output.
- Every commit step uses a HEREDOC with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **No merge steps.** Branch stays independent.
- **End of each phase:** update `docs/grammar/README.md` task checklist and `docs/grammar/progress.md` (explicit final task).
- Test baseline: **287 npm + 350 Rails = 637** must still pass end of plan.

---

# Phase 1 — Registry Foundation (~1 week)

## Task 1: Registry types (TypeScript)

**Files:**
- Create: `packages/agent/src/grammar/registry.ts`
- Test: `packages/agent/src/__tests__/grammar/registry.test.ts`

- [ ] **Step 1: Write failing test**

`packages/agent/src/__tests__/grammar/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createRegistry, findEntity, resolveAlias, Registry } from '../../grammar/registry.js';

describe('Registry', () => {
  it('creates an empty registry with expected shape', () => {
    const r = createRegistry({ framework: 'generic' });
    expect(r.entities).toEqual({});
    expect(r.aliases).toEqual({});
    expect(r.version).toBe(1);
    expect(r.framework).toBe('generic');
    expect(typeof r.generatedAt).toBe('string');
  });

  it('findEntity returns entity by canonical name', () => {
    const r: Registry = {
      entities: {
        user: {
          name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
          primaryKey: 'id', timestamps: {}, fields: {}, scopes: {},
          associations: {}, rankingCandidates: [],
        },
      },
      aliases: {}, version: 1, generatedAt: '', framework: 'generic',
    };
    expect(findEntity(r, 'user')?.table).toBe('users');
    expect(findEntity(r, 'nonexistent')).toBeNull();
  });

  it('resolveAlias falls through to entity name when no alias exists', () => {
    const r: Registry = {
      entities: { user: {} as any },
      aliases: { customers: 'user' },
      version: 1, generatedAt: '', framework: 'generic',
    };
    expect(resolveAlias(r, 'customers')).toBe('user');
    expect(resolveAlias(r, 'user')).toBe('user');
    expect(resolveAlias(r, 'unknown')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/registry.test.ts`
Expected: FAIL (`Cannot find module '../../grammar/registry.js'`).

- [ ] **Step 3: Implement registry.ts**

`packages/agent/src/grammar/registry.ts`:
```ts
export interface Registry {
  entities: Record<string, Entity>;
  aliases: Record<string, string>;
  version: number;
  generatedAt: string;
  framework: 'rails' | 'django' | 'generic';
}

export interface Entity {
  name: string;
  table: string;
  displayLabel: string;
  rowCount: number;
  primaryKey: string;
  timestamps: { created?: string; updated?: string; deleted?: string };
  fields: Record<string, Field>;
  scopes: Record<string, Scope>;
  associations: Record<string, Association>;
  rankingCandidates: string[];
}

export type FieldType = 'int' | 'text' | 'bool' | 'timestamp' | 'decimal' | 'enum' | 'jsonb' | 'uuid';

export interface Field {
  column: string;
  type: FieldType;
  nullable: boolean;
  enumValues?: Record<string, number | string>;
  fkTo?: { entity: string; onColumn: string };
  userFacingLabel?: string;
  searchable: boolean;
}

export interface Scope {
  name: string;
  whereClause: string;
  paramSlots: string[];
}

export interface Association {
  name: string;
  kind: 'belongs_to' | 'has_many' | 'has_one' | 'has_many_through';
  targetEntity: string;
  joinClause: string;
  throughEntity?: string;
}

export function createRegistry(opts: { framework: Registry['framework'] }): Registry {
  return {
    entities: {},
    aliases: {},
    version: 1,
    generatedAt: new Date().toISOString(),
    framework: opts.framework,
  };
}

export function findEntity(r: Registry, name: string): Entity | null {
  return r.entities[name] ?? null;
}

export function resolveAlias(r: Registry, term: string): string | null {
  if (r.aliases[term]) return r.aliases[term];
  if (r.entities[term]) return term;
  return null;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/grammar/registry.ts packages/agent/src/__tests__/grammar/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): add Registry types and lookup helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Registry types (Ruby)

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/grammar/registry.rb`
- Test: `sql-chatbot-rails/spec/sql_chatbot/grammar/registry_spec.rb`

- [ ] **Step 1: Write failing test**

`sql-chatbot-rails/spec/sql_chatbot/grammar/registry_spec.rb`:
```ruby
require "spec_helper"
require "sql_chatbot/grammar/registry"

RSpec.describe SqlChatbot::Grammar::Registry do
  it "builds an empty registry" do
    r = described_class.new(framework: "rails")
    expect(r.entities).to eq({})
    expect(r.aliases).to eq({})
    expect(r.framework).to eq("rails")
    expect(r.version).to eq(1)
  end

  it "finds entity by name" do
    entity = SqlChatbot::Grammar::Entity.new(name: "user", table: "users")
    r = described_class.new(framework: "rails", entities: { "user" => entity })
    expect(r.find_entity("user").table).to eq("users")
    expect(r.find_entity("missing")).to be_nil
  end

  it "resolves alias to entity" do
    entity = SqlChatbot::Grammar::Entity.new(name: "user", table: "users")
    r = described_class.new(
      framework: "rails",
      entities: { "user" => entity },
      aliases: { "customer" => "user" }
    )
    expect(r.resolve_alias("customer")).to eq("user")
    expect(r.resolve_alias("user")).to eq("user")
    expect(r.resolve_alias("unknown")).to be_nil
  end
end
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/grammar/registry_spec.rb`
Expected: FAIL (LoadError).

- [ ] **Step 3: Implement Ruby registry**

`sql-chatbot-rails/lib/sql_chatbot/grammar/registry.rb`:
```ruby
# frozen_string_literal: true

module SqlChatbot
  module Grammar
    Entity = Struct.new(:name, :table, :display_label, :row_count, :primary_key,
                        :timestamps, :fields, :scopes, :associations, :ranking_candidates,
                        keyword_init: true) do
      def initialize(**kwargs)
        super(
          name: kwargs[:name],
          table: kwargs[:table],
          display_label: kwargs[:display_label] || kwargs[:name]&.capitalize,
          row_count: kwargs[:row_count] || 0,
          primary_key: kwargs[:primary_key] || "id",
          timestamps: kwargs[:timestamps] || {},
          fields: kwargs[:fields] || {},
          scopes: kwargs[:scopes] || {},
          associations: kwargs[:associations] || {},
          ranking_candidates: kwargs[:ranking_candidates] || []
        )
      end
    end

    Field = Struct.new(:column, :type, :nullable, :enum_values, :fk_to,
                       :user_facing_label, :searchable, keyword_init: true)

    Scope = Struct.new(:name, :where_clause, :param_slots, keyword_init: true)

    Association = Struct.new(:name, :kind, :target_entity, :join_clause,
                             :through_entity, keyword_init: true)

    class Registry
      attr_reader :entities, :aliases, :version, :generated_at, :framework

      def initialize(framework:, entities: {}, aliases: {})
        @framework = framework
        @entities = entities
        @aliases = aliases
        @version = 1
        @generated_at = Time.now.utc.iso8601
      end

      def find_entity(name)
        @entities[name.to_s]
      end

      def resolve_alias(term)
        return @aliases[term.to_s] if @aliases.key?(term.to_s)
        return term.to_s if @entities.key?(term.to_s)
        nil
      end
    end
  end
end
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/grammar/registry_spec.rb`
Expected: 3 examples, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/grammar/registry.rb sql-chatbot-rails/spec/sql_chatbot/grammar/registry_spec.rb
git commit -m "$(cat <<'EOF'
feat(rails/grammar): add Registry types matching TS shape

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Schema-only registry builder (npm)

**Files:**
- Create: `packages/agent/src/grammar/registry-loader.ts`
- Test: `packages/agent/src/__tests__/grammar/registry-loader.test.ts`

For non-Django / non-Rails npm users. Builds a thin registry from `SchemaService` output alone — entities, fields (types + enum values from existing annotations), FKs as associations, no scopes. Enables grammar to still COUNT/LIST/filter on enum values even without code parsing.

- [ ] **Step 1: Write failing test**

`packages/agent/src/__tests__/grammar/registry-loader.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildSchemaOnlyRegistry } from '../../grammar/registry-loader.js';

const fakeSchemaService = {
  getTableList: () => [
    { name: 'users', rowCount: 100, primaryKey: 'id', columns: [
      { name: 'id', type: 'int', nullable: false },
      { name: 'status', type: 'int', nullable: false, enumValues: { active: 1, banned: 2 } },
      { name: 'deleted_at', type: 'timestamp', nullable: true },
    ]},
    { name: 'orders', rowCount: 50, primaryKey: 'id', columns: [
      { name: 'id', type: 'int', nullable: false },
      { name: 'user_id', type: 'int', nullable: false, fkTo: { table: 'users', column: 'id' }},
    ]},
  ],
} as any;

describe('buildSchemaOnlyRegistry', () => {
  it('creates entities for each table', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.table).toBe('users');
    expect(r.entities.order.table).toBe('orders');
  });

  it('singularizes table names as entity canonical names', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(Object.keys(r.entities).sort()).toEqual(['order', 'user']);
  });

  it('maps enum column values into Field.enumValues', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.fields.status.enumValues).toEqual({ active: 1, banned: 2 });
  });

  it('auto-detects soft-delete column as timestamps.deleted', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.user.timestamps.deleted).toBe('deleted_at');
  });

  it('converts FK columns into associations on the source entity', () => {
    const r = buildSchemaOnlyRegistry(fakeSchemaService);
    expect(r.entities.order.associations.user).toEqual({
      name: 'user',
      kind: 'belongs_to',
      targetEntity: 'user',
      joinClause: 'orders.user_id = users.id',
    });
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/registry-loader.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement builder**

`packages/agent/src/grammar/registry-loader.ts`:
```ts
import { createRegistry, Registry, Entity, Field, Association } from './registry.js';

const SOFT_DELETE_COLUMNS = ['deleted_at', 'discarded_at', 'archived_at', 'removed_at'];

interface SchemaTableLike {
  name: string;
  rowCount: number;
  primaryKey: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    enumValues?: Record<string, number | string>;
    fkTo?: { table: string; column: string };
  }>;
}

interface SchemaServiceLike {
  getTableList(): SchemaTableLike[];
}

function singularize(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('sses')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function mapType(pg: string): Field['type'] {
  const t = pg.toLowerCase();
  if (t.includes('int') || t === 'serial' || t === 'bigint') return 'int';
  if (t.includes('char') || t === 'text') return 'text';
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t.includes('timestamp') || t === 'date') return 'timestamp';
  if (t === 'numeric' || t === 'decimal' || t === 'double') return 'decimal';
  if (t === 'jsonb' || t === 'json') return 'jsonb';
  if (t === 'uuid') return 'uuid';
  return 'text';
}

export function buildSchemaOnlyRegistry(schema: SchemaServiceLike): Registry {
  const r = createRegistry({ framework: 'generic' });
  const tables = schema.getTableList();
  const tableToEntity: Record<string, string> = {};

  for (const t of tables) {
    const entityName = singularize(t.name);
    tableToEntity[t.name] = entityName;
    const fields: Record<string, Field> = {};
    const timestamps: Entity['timestamps'] = {};
    const rankingCandidates: string[] = [];

    for (const c of t.columns) {
      const type = c.enumValues ? 'enum' : mapType(c.type);
      fields[c.name] = {
        column: c.name,
        type,
        nullable: c.nullable,
        enumValues: c.enumValues,
        fkTo: c.fkTo ? { entity: singularize(c.fkTo.table), onColumn: c.fkTo.column } : undefined,
        searchable: type === 'text',
      };
      if (c.name === 'created_at') timestamps.created = c.name;
      if (c.name === 'updated_at') timestamps.updated = c.name;
      if (SOFT_DELETE_COLUMNS.includes(c.name)) timestamps.deleted = c.name;
      if (type === 'int' || type === 'decimal' || type === 'timestamp') {
        rankingCandidates.push(c.name);
      }
    }

    r.entities[entityName] = {
      name: entityName,
      table: t.name,
      displayLabel: entityName.charAt(0).toUpperCase() + entityName.slice(1),
      rowCount: t.rowCount,
      primaryKey: t.primaryKey,
      timestamps,
      fields,
      scopes: {},
      associations: {},
      rankingCandidates,
    };
  }

  // Second pass: wire FKs into associations
  for (const t of tables) {
    const sourceEntityName = tableToEntity[t.name];
    const sourceEntity = r.entities[sourceEntityName];
    for (const c of t.columns) {
      if (!c.fkTo) continue;
      const targetEntity = tableToEntity[c.fkTo.table];
      if (!targetEntity) continue;
      const assocName = targetEntity;
      const assoc: Association = {
        name: assocName,
        kind: 'belongs_to',
        targetEntity,
        joinClause: `${t.name}.${c.name} = ${c.fkTo.table}.${c.fkTo.column}`,
      };
      sourceEntity.associations[assocName] = assoc;
    }
  }

  return r;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/registry-loader.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/grammar/registry-loader.ts packages/agent/src/__tests__/grammar/registry-loader.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): add schema-only registry builder for generic framework

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Adapt SchemaService to expose structured table list

`buildSchemaOnlyRegistry` needs a `getTableList()` method on `SchemaService`. Current service exposes text summaries; we need a structured accessor.

**Files:**
- Modify: `packages/agent/src/services/schema.ts` (add `getTableList()` and keep existing string APIs intact)
- Test: `packages/agent/src/__tests__/schema.test.ts` (extend with new test)

- [ ] **Step 1: Write failing test**

Add to `packages/agent/src/__tests__/schema.test.ts`:
```ts
describe('SchemaService.getTableList', () => {
  it('returns structured table data including enum values', async () => {
    const { service } = await setupMockQuery({
      columnsResult: [
        { table_name: 'users', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
        { table_name: 'users', column_name: 'status', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
      ],
      fksResult: [],
      pksResult: [{ table_name: 'users', column_name: 'id' }],
      rowCountResult: { users: 10 },
      checksResult: [{ table_name: 'users', column_name: 'status', check_clause: "status = ANY (ARRAY['active', 'banned'])" }],
    });
    const tables = service.getTableList();
    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe('users');
    expect(tables[0].primaryKey).toBe('id');
    const statusCol = tables[0].columns.find(c => c.name === 'status');
    expect(statusCol?.enumValues).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd packages/agent && npx vitest run src/__tests__/schema.test.ts -t "getTableList"`
Expected: FAIL (method missing).

- [ ] **Step 3: Add `getTableList()` to `SchemaService`**

In `packages/agent/src/services/schema.ts`, add to the `SchemaService` class:

```ts
  // Structured accessor used by the grammar registry loader.
  // Keeps existing string-based APIs untouched.
  getTableList(): Array<{
    name: string;
    rowCount: number;
    primaryKey: string;
    columns: Array<{
      name: string;
      type: string;
      nullable: boolean;
      enumValues?: Record<string, number | string>;
      fkTo?: { table: string; column: string };
    }>;
  }> {
    return this.structuredTables ?? [];
  }
```

At the end of `discover()`, populate `this.structuredTables` by walking the same query results already used to build `summary`:

```ts
    this.structuredTables = tableNames.map((table) => {
      const cols = columnsRes.rows.filter((c: ColumnInfo) => c.table_name === table);
      const pk = pksRes.rows.find((p: any) => p.table_name === table)?.column_name ?? 'id';
      const rowCount = rowCounts.get(table) ?? 0;
      return {
        name: table,
        rowCount,
        primaryKey: pk,
        columns: cols.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          enumValues: this.enumValuesFor(table, c.column_name),
          fkTo: this.fkTargetFor(table, c.column_name),
        })),
      };
    });
```

Add private helpers `enumValuesFor` and `fkTargetFor` that read from the existing enum/check/FK collections already built in `discover()`.

Add private field: `private structuredTables: any[] = [];`

- [ ] **Step 4: Run test, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/schema.test.ts`
Expected: all pre-existing schema tests PASS + new `getTableList` test PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/services/schema.ts packages/agent/src/__tests__/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): add structured getTableList() accessor for grammar registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rails RegistryBuilder (AR introspection)

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/services/registry_builder.rb`
- Test: `sql-chatbot-rails/spec/sql_chatbot/services/registry_builder_spec.rb`

- [ ] **Step 1: Write failing test**

`sql-chatbot-rails/spec/sql_chatbot/services/registry_builder_spec.rb`:
```ruby
require "spec_helper"
require "active_record"
require "sql_chatbot/services/registry_builder"

RSpec.describe SqlChatbot::Services::RegistryBuilder do
  before(:all) do
    ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
    ActiveRecord::Schema.define do
      create_table :users do |t|
        t.string :email
        t.integer :status, default: 0
        t.datetime :deleted_at
        t.timestamps
      end
      create_table :orders do |t|
        t.integer :user_id, null: false
        t.decimal :total, precision: 10, scale: 2
        t.timestamps
      end
    end
    class User < ActiveRecord::Base
      enum status: { active: 0, banned: 1 }
      has_many :orders
    end
    class Order < ActiveRecord::Base
      belongs_to :user
    end
  end

  it "builds registry with entities for each model" do
    r = described_class.new.build
    expect(r.entities.keys).to include("user", "order")
  end

  it "extracts Rails enums into Field.enum_values" do
    r = described_class.new.build
    field = r.entities["user"].fields["status"]
    expect(field.enum_values).to eq({ "active" => 0, "banned" => 1 })
    expect(field.type).to eq(:enum)
  end

  it "records has_many associations" do
    r = described_class.new.build
    assoc = r.entities["user"].associations["orders"]
    expect(assoc.kind).to eq(:has_many)
    expect(assoc.target_entity).to eq("order")
    expect(assoc.join_clause).to eq("users.id = orders.user_id")
  end

  it "records belongs_to associations" do
    r = described_class.new.build
    assoc = r.entities["order"].associations["user"]
    expect(assoc.kind).to eq(:belongs_to)
    expect(assoc.target_entity).to eq("user")
    expect(assoc.join_clause).to eq("orders.user_id = users.id")
  end

  it "auto-detects soft-delete column into timestamps.deleted" do
    r = described_class.new.build
    expect(r.entities["user"].timestamps[:deleted]).to eq("deleted_at")
  end
end
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/registry_builder_spec.rb`
Expected: LoadError or failures.

- [ ] **Step 3: Implement RegistryBuilder**

`sql-chatbot-rails/lib/sql_chatbot/services/registry_builder.rb`:
```ruby
# frozen_string_literal: true

require "sql_chatbot/grammar/registry"

module SqlChatbot
  module Services
    class RegistryBuilder
      SOFT_DELETE_COLS = %w[deleted_at discarded_at archived_at removed_at].freeze

      def build
        entities = {}
        discover_models.each do |model|
          entity_name = model.name.underscore
          entities[entity_name] = build_entity(model, entity_name)
        end
        Grammar::Registry.new(framework: "rails", entities: entities)
      end

      private

      def discover_models
        return [] unless defined?(ActiveRecord::Base)
        eager_load_models!
        ActiveRecord::Base.descendants.select do |m|
          !m.abstract_class? && m.respond_to?(:table_name) && safe_table_exists?(m)
        end
      end

      def eager_load_models!
        return unless defined?(Rails) && Rails.respond_to?(:application) && Rails.application
        return if Rails.application.config.eager_load
        if defined?(Zeitwerk) && Rails.autoloaders.respond_to?(:main)
          Rails.application.paths["app/models"]&.to_a&.each do |p|
            abs = Rails.root.join(p).to_s
            Rails.autoloaders.main.eager_load_dir(abs) if Dir.exist?(abs)
          end
        else
          Rails.application.eager_load!
        end
      rescue => e
        warn "[SqlChatbot] RegistryBuilder eager_load: #{e.message}"
      end

      def safe_table_exists?(model)
        model.table_exists?
      rescue
        false
      end

      def build_entity(model, entity_name)
        Grammar::Entity.new(
          name: entity_name,
          table: model.table_name,
          display_label: model.name,
          row_count: safe_row_count(model),
          primary_key: model.primary_key.to_s,
          timestamps: detect_timestamps(model),
          fields: build_fields(model),
          scopes: {},                           # scope extraction handled in later task
          associations: build_associations(model),
          ranking_candidates: ranking_candidates_for(model)
        )
      end

      def safe_row_count(model)
        model.count
      rescue
        0
      end

      def detect_timestamps(model)
        cols = model.columns_hash.keys
        ts = {}
        ts[:created] = "created_at" if cols.include?("created_at")
        ts[:updated] = "updated_at" if cols.include?("updated_at")
        soft = SOFT_DELETE_COLS.find { |c| cols.include?(c) }
        ts[:deleted] = soft if soft
        ts
      end

      def build_fields(model)
        enums = model.defined_enums
        model.columns_hash.each_with_object({}) do |(col, info), h|
          enum_vals = enums[col]
          type = enum_vals ? :enum : map_type(info.type)
          h[col] = Grammar::Field.new(
            column: col,
            type: type,
            nullable: info.null,
            enum_values: enum_vals,
            fk_to: nil,                         # filled by build_associations
            user_facing_label: col.humanize,
            searchable: type == :text
          )
        end
      end

      def build_associations(model)
        model.reflect_on_all_associations.each_with_object({}) do |refl, h|
          next unless refl.klass rescue next
          target = refl.klass.name.underscore
          h[refl.name.to_s] = Grammar::Association.new(
            name: refl.name.to_s,
            kind: refl.macro,
            target_entity: target,
            join_clause: join_clause_for(refl),
            through_entity: refl.options[:through]&.to_s
          )
        rescue
          # skip associations pointing to missing models
        end
      end

      def join_clause_for(refl)
        owner_table = refl.active_record.table_name
        target_table = refl.klass.table_name
        case refl.macro
        when :belongs_to
          "#{owner_table}.#{refl.foreign_key} = #{target_table}.#{refl.association_primary_key}"
        when :has_many, :has_one
          "#{owner_table}.#{refl.active_record.primary_key} = #{target_table}.#{refl.foreign_key}"
        else
          ""
        end
      end

      def ranking_candidates_for(model)
        model.columns_hash.select { |_, c| [:integer, :decimal, :float, :datetime].include?(c.type) }.keys
      end

      def map_type(ar_type)
        case ar_type
        when :integer, :bigint then :int
        when :string, :text then :text
        when :boolean then :bool
        when :datetime, :date, :time then :timestamp
        when :decimal, :float then :decimal
        when :json, :jsonb then :jsonb
        when :uuid then :uuid
        else :text
        end
      end
    end
  end
end
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/registry_builder_spec.rb`
Expected: 5 examples, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/registry_builder.rb sql-chatbot-rails/spec/sql_chatbot/services/registry_builder_spec.rb
git commit -m "$(cat <<'EOF'
feat(rails/grammar): RegistryBuilder introspects AR models into Registry

Extracts enums, associations, timestamps, ranking candidates. Scopes left
for a follow-up task (separate extraction via method_source or parser gem).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rails RegistryBuilder — scope extraction

Scopes (`scope :active, -> { where(status: 0) }`) are the highest-value semantic metadata after enums. Extract them via `method_source` (already a Rails dep).

**Files:**
- Modify: `sql-chatbot-rails/lib/sql_chatbot/services/registry_builder.rb`
- Modify: `sql-chatbot-rails/spec/sql_chatbot/services/registry_builder_spec.rb`

- [ ] **Step 1: Add failing test**

Append to the spec:
```ruby
  it "extracts simple where-only scopes into Scope objects" do
    class User < ActiveRecord::Base
      scope :active, -> { where(status: 0) }
    end
    r = described_class.new.build
    scope = r.entities["user"].scopes["active"]
    expect(scope).not_to be_nil
    expect(scope.where_clause).to include("status")
  end
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/registry_builder_spec.rb -e "scopes"`
Expected: FAIL (scope nil).

- [ ] **Step 3: Add scope extraction**

Add `require "method_source"` at top and new method in `RegistryBuilder`:

```ruby
      def build_scopes(model)
        scopes = {}
        return scopes unless model.respond_to?(:_scopes) || defined?(ActiveRecord::Scoping)
        # Scopes registered via `scope :name, ->{}` are stored as class methods.
        # Use scope_attributes to discover them when available (Rails 5+).
        model.singleton_methods(false).each do |method_name|
          source = begin
            model.method(method_name).source
          rescue
            next
          end
          next unless source.include?("scope ")
          # Extract the name and body from the scope definition source line.
          match = source.match(/scope\s+:(\w+),?\s*(?:->\s*(\([^)]*\))?\s*\{\s*(.*?)\s*\})/)
          next unless match
          name, _params, body = match.captures
          where_clause = translate_scope_body_to_sql(body, model)
          scopes[name] = Grammar::Scope.new(
            name: name,
            where_clause: where_clause,
            param_slots: []
          )
        end
        scopes
      rescue => e
        warn "[SqlChatbot] scope extraction: #{e.message}"
        scopes || {}
      end

      def translate_scope_body_to_sql(body, model)
        # Best-effort: try to eval the scope on a relation to capture SQL.
        relation = model.instance_exec { eval(body) } rescue nil
        return "" unless relation.respond_to?(:where_values_hash) || relation.respond_to?(:to_sql)
        sql = relation.to_sql
        if sql =~ /WHERE\s+(.+)$/i
          Regexp.last_match(1).strip
        else
          ""
        end
      end
```

Call from `build_entity`:

```ruby
          scopes: build_scopes(model),
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/services/registry_builder_spec.rb`
Expected: 6 examples, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/services/registry_builder.rb sql-chatbot-rails/spec/sql_chatbot/services/registry_builder_spec.rb
git commit -m "$(cat <<'EOF'
feat(rails/grammar): extract Rails scopes into Registry via method_source

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Django AST introspector (Python stdlib)

**Files:**
- Create: `packages/agent/src/grammar/introspectors/scripts/django_introspect.py`
- Create: `packages/agent/src/grammar/introspectors/django.ts`
- Test: `packages/agent/src/__tests__/grammar/introspectors-django.test.ts`
- Create: `packages/agent/src/__tests__/fixtures/django/models.py`

- [ ] **Step 1: Create Django fixture**

`packages/agent/src/__tests__/fixtures/django/models.py`:
```python
from django.db import models

STATUS_CHOICES = [
    (0, 'Active'),
    (1, 'Banned'),
]

class User(models.Model):
    email = models.EmailField()
    status = models.IntegerField(choices=STATUS_CHOICES, default=0)

    class Meta:
        db_table = 'auth_user'

class Order(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    total = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        db_table = 'order_order'
```

- [ ] **Step 2: Write failing test**

`packages/agent/src/__tests__/grammar/introspectors-django.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { introspectDjango } from '../../grammar/introspectors/django.js';
import path from 'path';

describe('introspectDjango', () => {
  const fixtures = path.resolve(__dirname, '../fixtures/django');

  it('extracts User and Order entities', async () => {
    const r = await introspectDjango(fixtures);
    expect(r.framework).toBe('django');
    expect(r.entities.user.table).toBe('auth_user');
    expect(r.entities.order.table).toBe('order_order');
  });

  it('maps IntegerField choices into Field.enumValues', async () => {
    const r = await introspectDjango(fixtures);
    const status = r.entities.user.fields.status;
    expect(status.enumValues).toEqual({ Active: 0, Banned: 1 });
    expect(status.type).toBe('enum');
  });

  it('records ForeignKey as belongs_to association', async () => {
    const r = await introspectDjango(fixtures);
    const assoc = r.entities.order.associations.user;
    expect(assoc.kind).toBe('belongs_to');
    expect(assoc.targetEntity).toBe('user');
    expect(assoc.joinClause).toBe('order_order.user_id = auth_user.id');
  });
});
```

- [ ] **Step 3: Run test, verify failure**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/introspectors-django.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Write Python introspector**

`packages/agent/src/grammar/introspectors/scripts/django_introspect.py`:
```python
#!/usr/bin/env python3
"""Django models.py AST walker. Stdlib only.

Usage: python3 django_introspect.py <path-to-django-project>
Outputs JSON to stdout shaped for sql-chatbot grammar registry.
"""
import ast
import json
import os
import sys


def walk_models_file(path):
    with open(path, 'r') as f:
        tree = ast.parse(f.read())
    entities = []
    module_choices = {}

    # First pass: top-level CHOICES constants
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id.endswith('_CHOICES'):
                    module_choices[t.id] = extract_choices(node.value)

    # Second pass: classes inheriting from models.Model
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and is_django_model(node):
            entities.append(extract_entity(node, module_choices, path))
    return entities


def is_django_model(class_node):
    for base in class_node.bases:
        if isinstance(base, ast.Attribute) and base.attr == 'Model':
            return True
    return False


def extract_choices(list_node):
    result = {}
    for elt in list_node.elts:
        if isinstance(elt, ast.Tuple) and len(elt.elts) >= 2:
            k = elt.elts[0]
            v = elt.elts[1]
            key = k.value if isinstance(k, ast.Constant) else None
            label = v.value if isinstance(v, ast.Constant) else None
            if key is not None and label is not None:
                result[str(label)] = key
    return result


def extract_entity(class_node, module_choices, source_path):
    entity = {
        'name': class_node.name.lower(),
        'class': class_node.name,
        'table': None,
        'fields': {},
        'fks': [],
    }
    for child in class_node.body:
        if isinstance(child, ast.ClassDef) and child.name == 'Meta':
            for m in child.body:
                if isinstance(m, ast.Assign):
                    for t in m.targets:
                        if isinstance(t, ast.Name) and t.id == 'db_table':
                            if isinstance(m.value, ast.Constant):
                                entity['table'] = m.value.value
        elif isinstance(child, ast.Assign) and len(child.targets) == 1 and isinstance(child.targets[0], ast.Name):
            field_name = child.targets[0].id
            if isinstance(child.value, ast.Call):
                entity['fields'][field_name] = extract_field(child.value, module_choices)
                if field_type_name(child.value) == 'ForeignKey':
                    target = fk_target(child.value)
                    if target:
                        entity['fks'].append({'field': field_name, 'target': target})
    if not entity['table']:
        entity['table'] = pluralize_snake(class_node.name)
    return entity


def field_type_name(call_node):
    if isinstance(call_node.func, ast.Attribute):
        return call_node.func.attr
    return ''


def extract_field(call_node, module_choices):
    t = field_type_name(call_node)
    type_map = {
        'IntegerField': 'int', 'BigIntegerField': 'int', 'AutoField': 'int',
        'CharField': 'text', 'TextField': 'text', 'EmailField': 'text',
        'BooleanField': 'bool',
        'DateTimeField': 'timestamp', 'DateField': 'timestamp',
        'DecimalField': 'decimal', 'FloatField': 'decimal',
        'JSONField': 'jsonb', 'UUIDField': 'uuid',
        'ForeignKey': 'int',
    }
    enum_values = None
    for kw in call_node.keywords:
        if kw.arg == 'choices':
            if isinstance(kw.value, ast.Name) and kw.value.id in module_choices:
                enum_values = module_choices[kw.value.id]
            elif isinstance(kw.value, (ast.List, ast.Tuple)):
                enum_values = extract_choices(kw.value)
    return {
        'type': 'enum' if enum_values else type_map.get(t, 'text'),
        'enum_values': enum_values,
    }


def fk_target(call_node):
    if not call_node.args:
        return None
    a = call_node.args[0]
    if isinstance(a, ast.Name):
        return a.id
    if isinstance(a, ast.Constant) and isinstance(a.value, str):
        return a.value
    return None


def pluralize_snake(class_name):
    s = class_name[0].lower()
    for c in class_name[1:]:
        s += ('_' + c.lower()) if c.isupper() else c
    if s.endswith('y'):
        return s[:-1] + 'ies'
    if s.endswith('s'):
        return s + 'es'
    return s + 's'


def walk_project(root):
    all_entities = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f == 'models.py':
                try:
                    all_entities.extend(walk_models_file(os.path.join(dirpath, f)))
                except Exception as e:
                    sys.stderr.write(f"skipping {dirpath}/{f}: {e}\n")
    return all_entities


def main():
    if len(sys.argv) != 2:
        print('usage: django_introspect.py <project-root>', file=sys.stderr)
        sys.exit(2)
    entities = walk_project(sys.argv[1])
    json.dump({'entities': entities}, sys.stdout)


if __name__ == '__main__':
    main()
```

- [ ] **Step 5: Write Node wrapper**

`packages/agent/src/grammar/introspectors/django.ts`:
```ts
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRegistry, Registry, Entity, Field, Association } from '../registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DjangoRawEntity {
  name: string;
  class: string;
  table: string;
  fields: Record<string, { type: string; enum_values?: Record<string, number | string> }>;
  fks: Array<{ field: string; target: string }>;
}

function runPython(projectPath: string): Promise<{ entities: DjangoRawEntity[] }> {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'scripts', 'django_introspect.py');
    const proc = spawn('python3', [script, projectPath]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('error', (e) => reject(new Error(`python3 spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`django_introspect exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`malformed python output: ${(e as Error).message}`)); }
    });
  });
}

export async function introspectDjango(projectPath: string): Promise<Registry> {
  const raw = await runPython(projectPath);
  const r = createRegistry({ framework: 'django' });
  const classToEntityName: Record<string, string> = {};
  const classToTable: Record<string, string> = {};

  for (const e of raw.entities) {
    classToEntityName[e.class] = e.name;
    classToTable[e.class] = e.table;
  }

  for (const e of raw.entities) {
    const fields: Record<string, Field> = {};
    for (const [fieldName, f] of Object.entries(e.fields)) {
      fields[fieldName] = {
        column: fieldName === (e.fks.find(fk => fk.field === fieldName)?.field) ? `${fieldName}_id` : fieldName,
        type: f.type as Field['type'],
        nullable: false,
        enumValues: f.enum_values,
        searchable: f.type === 'text',
      };
    }
    const associations: Record<string, Association> = {};
    for (const fk of e.fks) {
      const targetEntity = classToEntityName[fk.target];
      const targetTable = classToTable[fk.target];
      if (!targetEntity || !targetTable) continue;
      associations[targetEntity] = {
        name: targetEntity,
        kind: 'belongs_to',
        targetEntity,
        joinClause: `${e.table}.${fk.field}_id = ${targetTable}.id`,
      };
    }
    r.entities[e.name] = {
      name: e.name,
      table: e.table,
      displayLabel: e.class,
      rowCount: 0,
      primaryKey: 'id',
      timestamps: {},
      fields,
      scopes: {},
      associations,
      rankingCandidates: Object.entries(fields)
        .filter(([_, f]) => ['int', 'decimal', 'timestamp'].includes(f.type))
        .map(([n]) => n),
    };
  }

  return r;
}
```

- [ ] **Step 6: Run test, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/introspectors-django.test.ts`
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/grammar/introspectors packages/agent/src/__tests__/grammar/introspectors-django.test.ts packages/agent/src/__tests__/fixtures/django
git commit -m "$(cat <<'EOF'
feat(grammar): Django AST introspector via Python stdlib subprocess

Extracts class-based models into Registry entities with enum choices and
ForeignKey associations. Python runs only at dev time via CLI; not a
production runtime dep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: CLI `introspect` subcommand

**Files:**
- Modify: `packages/agent/src/cli.ts`
- Test: `packages/agent/src/__tests__/cli-introspect.test.ts`

- [ ] **Step 1: Write failing test**

`packages/agent/src/__tests__/cli-introspect.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runIntrospectCommand } from '../cli-introspect.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('runIntrospectCommand', () => {
  it('writes sql-chatbot-manifest.json with registry payload', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const fixtures = path.resolve(__dirname, './fixtures/django');
    fs.cpSync(fixtures, path.join(tmp, 'app'), { recursive: true });
    const outPath = path.join(tmp, 'sql-chatbot-manifest.json');
    await runIntrospectCommand({ framework: 'django', code: path.join(tmp, 'app'), out: outPath });
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(parsed.framework).toBe('django');
    expect(parsed.entities.user).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd packages/agent && npx vitest run src/__tests__/cli-introspect.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extract `runIntrospectCommand` into its own file**

`packages/agent/src/cli-introspect.ts`:
```ts
import fs from 'fs';
import path from 'path';
import { introspectDjango } from './grammar/introspectors/django.js';
import { Registry } from './grammar/registry.js';

export interface IntrospectOptions {
  framework: 'django';
  code: string;
  out?: string;
}

export async function runIntrospectCommand(opts: IntrospectOptions): Promise<Registry> {
  let registry: Registry;
  if (opts.framework === 'django') {
    registry = await introspectDjango(opts.code);
  } else {
    throw new Error(`unsupported framework: ${opts.framework}`);
  }
  const outPath = opts.out ?? path.resolve(process.cwd(), 'sql-chatbot-manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
  return registry;
}
```

- [ ] **Step 4: Wire into `cli.ts`**

In `packages/agent/src/cli.ts`, add a subcommand branch that parses `introspect`:

```ts
import { runIntrospectCommand } from './cli-introspect.js';

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'introspect') {
    const framework = (getArg(args, '--framework') ?? 'django') as 'django';
    const code = getArg(args, '--code') ?? process.cwd();
    const out = getArg(args, '--out');
    await runIntrospectCommand({ framework, code, out });
    console.log(`[sql-chatbot] wrote manifest to ${out ?? path.resolve(process.cwd(), 'sql-chatbot-manifest.json')}`);
    process.exit(0);
  }
  // existing CLI flow continues below...
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}
```

- [ ] **Step 5: Run test, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/cli-introspect.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/cli-introspect.ts packages/agent/src/cli.ts packages/agent/src/__tests__/cli-introspect.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add 'introspect' subcommand that writes sql-chatbot-manifest.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manifest load at npm boot + drift detection

**Files:**
- Modify: `packages/agent/src/config.ts` (add grammar config)
- Modify: `packages/agent/src/grammar/registry-loader.ts` (add `loadFromManifestOrSchema`)
- Test: `packages/agent/src/__tests__/grammar/registry-loader.test.ts`

- [ ] **Step 1: Add failing test**

Append to `registry-loader.test.ts`:
```ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadRegistry } from '../../grammar/registry-loader.js';

describe('loadRegistry', () => {
  it('loads manifest when file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const manifestPath = path.join(dir, 'sql-chatbot-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      entities: { user: { table: 'users' } },
      aliases: {}, version: 1, generatedAt: 'x', framework: 'django',
    }));
    const r = loadRegistry({ manifestPath, schemaService: fakeSchemaService });
    expect(r.framework).toBe('django');
    expect(r.entities.user.table).toBe('users');
  });

  it('falls back to schema-only when manifest missing', () => {
    const r = loadRegistry({ manifestPath: '/nonexistent', schemaService: fakeSchemaService });
    expect(r.framework).toBe('generic');
    expect(r.entities.user).toBeDefined();
  });

  it('detects schema drift when manifest tables do not match DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcb-'));
    const manifestPath = path.join(dir, 'sql-chatbot-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      entities: { stale: { table: 'no_such_table' } },
      aliases: {}, version: 1, generatedAt: 'x', framework: 'django',
    }));
    const warnings: string[] = [];
    loadRegistry({ manifestPath, schemaService: fakeSchemaService, onWarn: (m) => warnings.push(m) });
    expect(warnings.some(w => w.includes('schema_drift'))).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `loadRegistry`**

Append to `packages/agent/src/grammar/registry-loader.ts`:
```ts
import fs from 'fs';

export interface LoadOptions {
  manifestPath: string;
  schemaService: SchemaServiceLike;
  onWarn?: (msg: string) => void;
}

export function loadRegistry(opts: LoadOptions): Registry {
  const warn = opts.onWarn ?? ((m) => console.warn(`[sql-chatbot] ${m}`));
  if (!fs.existsSync(opts.manifestPath)) {
    return buildSchemaOnlyRegistry(opts.schemaService);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(opts.manifestPath, 'utf8'));
  } catch (e) {
    warn(`manifest_parse_error: ${(e as Error).message} — falling back to schema-only`);
    return buildSchemaOnlyRegistry(opts.schemaService);
  }
  const liveTables = new Set(opts.schemaService.getTableList().map(t => t.name));
  const manifestTables = Object.values(raw.entities ?? {}).map((e: any) => e.table).filter(Boolean);
  const driftTables = manifestTables.filter(t => !liveTables.has(t));
  if (driftTables.length) {
    warn(`schema_drift_detected: manifest references tables not in DB: ${driftTables.join(', ')}`);
  }
  return raw as Registry;
}
```

- [ ] **Step 3: Add grammar config**

In `packages/agent/src/config.ts`:
```ts
export interface GrammarConfig {
  enabled: boolean;
  manifestPath?: string;
  confidenceThreshold: number;
  missLogPath: string;
}

// in AgentConfig interface:
//   grammar?: Partial<GrammarConfig>;

// in resolveConfig():
//   grammar: {
//     enabled: raw.grammar?.enabled ?? true,
//     manifestPath: raw.grammar?.manifestPath ?? path.resolve(process.cwd(), 'sql-chatbot-manifest.json'),
//     confidenceThreshold: raw.grammar?.confidenceThreshold ?? 0.7,
//     missLogPath: raw.grammar?.missLogPath ?? path.resolve(process.cwd(), 'logs/grammar-misses.ndjson'),
//   }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/registry-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/grammar/registry-loader.ts packages/agent/src/config.ts packages/agent/src/__tests__/grammar/registry-loader.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): loadRegistry with manifest support and schema-drift detection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: End of Phase 1 — update master index

- [ ] **Step 1: Update `docs/grammar/README.md` task checklist**

Tick these under "Implementation phases → P1":
- [x] Shared Registry interface (TS + Ruby)
- [x] Rails `RegistryBuilder` service
- [x] npm Django AST parser (Python stdlib)
- [x] CLI `sql-chatbot-agent introspect` subcommand
- [x] Manifest load path in npm package boot

Update Status block: **Current phase: "P1 complete — Registry foundation done. Starting P2 Template Compiler."**

- [ ] **Step 2: Append to `docs/grammar/progress.md`**

Add a dated entry under new heading:
```
## YYYY-MM-DD — P1 Registry Foundation complete

**Done:**
- Registry types (TS + Ruby)
- Schema-only registry builder + SchemaService.getTableList()
- Rails RegistryBuilder (AR models, enums, associations, scopes)
- Python Django AST introspector + Node wrapper
- CLI `introspect` subcommand
- Manifest load with drift detection
- Grammar config options added

**Tests:** X new npm tests, Y new Rails tests. All baseline tests still pass.

**Next:** P2 Template Compiler (primitives + modifiers).
```

- [ ] **Step 3: Verify baseline tests still pass**

Run: `cd packages/agent && npx vitest run && cd ../../sql-chatbot-rails && bundle exec rspec`
Expected: 287 existing + new tests all pass; 350 existing + new tests all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/grammar/README.md docs/grammar/progress.md
git commit -m "$(cat <<'EOF'
docs(grammar): mark P1 Registry Foundation complete in master index

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 2 — Template Compiler (~3-4 days)

## Task 11: Primitives COUNT and LIST

**Files:**
- Create: `packages/agent/src/grammar/primitives.ts`
- Test: `packages/agent/src/__tests__/grammar/primitives.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildPrimitive } from '../../grammar/primitives.js';
import { Entity } from '../../grammar/registry.js';

const userEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
  primaryKey: 'id', timestamps: {},
  fields: {
    id: { column: 'id', type: 'int', nullable: false, searchable: false },
    name: { column: 'name', type: 'text', nullable: false, searchable: true },
    email: { column: 'email', type: 'text', nullable: false, searchable: true },
  },
  scopes: {}, associations: {}, rankingCandidates: [],
};

describe('primitives', () => {
  it('COUNT emits SELECT COUNT(*)', () => {
    expect(buildPrimitive({ primitive: 'COUNT', entity: userEntity }))
      .toBe('SELECT COUNT(*) FROM users');
  });

  it('LIST picks sensible display fields', () => {
    expect(buildPrimitive({ primitive: 'LIST', entity: userEntity }))
      .toBe('SELECT id, name, email FROM users');
  });
});
```

- [ ] **Step 2: Implement primitives.ts**

```ts
import { Entity } from './registry.js';

export type PrimitiveKind = 'COUNT' | 'LIST' | 'SUM' | 'AVG' | 'MIN_MAX' | 'TOP_N' | 'RANK';

export interface PrimitiveInput {
  primitive: PrimitiveKind;
  entity: Entity;
  field?: string;
  which?: 'MIN' | 'MAX';
  n?: number;
  rankField?: string;
  groupBy?: string;
}

export function buildPrimitive(input: PrimitiveInput): string {
  const { primitive, entity } = input;
  switch (primitive) {
    case 'COUNT':
      return `SELECT COUNT(*) FROM ${entity.table}`;
    case 'LIST':
      return `SELECT ${pickDisplayFields(entity).join(', ')} FROM ${entity.table}`;
    case 'SUM':
      requireField(input, entity, 'SUM');
      return `SELECT SUM(${entity.table}.${input.field}) FROM ${entity.table}`;
    case 'AVG':
      requireField(input, entity, 'AVG');
      return `SELECT ROUND(AVG(${entity.table}.${input.field}), 2) FROM ${entity.table}`;
    case 'MIN_MAX':
      requireField(input, entity, 'MIN_MAX');
      if (input.which !== 'MIN' && input.which !== 'MAX') throw new Error('MIN_MAX requires which');
      return `SELECT ${input.which}(${entity.table}.${input.field}) FROM ${entity.table}`;
    case 'TOP_N': {
      const rank = input.rankField ?? entity.rankingCandidates[0];
      if (!rank) throw new Error('TOP_N requires rankField');
      return `SELECT ${pickDisplayFields(entity).join(', ')}, ${entity.table}.${rank} FROM ${entity.table} ORDER BY ${entity.table}.${rank} DESC LIMIT ${input.n ?? 10}`;
    }
    case 'RANK': {
      const rank = input.rankField;
      const gb = input.groupBy;
      if (!rank || !gb) throw new Error('RANK requires rankField and groupBy');
      return `SELECT ${entity.table}.*, DENSE_RANK() OVER (PARTITION BY ${entity.table}.${gb} ORDER BY ${entity.table}.${rank} DESC) AS rank FROM ${entity.table}`;
    }
  }
}

function pickDisplayFields(entity: Entity): string[] {
  const preferred = ['id', 'name', 'title', 'label', 'email'];
  const present = preferred.filter(p => entity.fields[p]);
  if (present.length) return present.map(p => `${entity.fields[p].column}`);
  return Object.keys(entity.fields).slice(0, 4);
}

function requireField(input: PrimitiveInput, entity: Entity, name: string) {
  if (!input.field) throw new Error(`${name} requires field`);
  if (!entity.fields[input.field]) throw new Error(`${name} field '${input.field}' not in entity`);
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/primitives.test.ts`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/primitives.ts packages/agent/src/__tests__/grammar/primitives.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): primitives — COUNT, LIST, SUM, AVG, MIN_MAX, TOP_N, RANK

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 12: Primitive test coverage (SUM/AVG/MIN_MAX/TOP_N/RANK + error paths)

**Files:**
- Modify: `packages/agent/src/__tests__/grammar/primitives.test.ts`

- [ ] **Step 1: Add tests**

```ts
  it('SUM with field', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, balance: { column: 'balance', type: 'decimal', nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'SUM', entity: e, field: 'balance' }))
      .toBe('SELECT SUM(users.balance) FROM users');
  });
  it('AVG rounds to 2 places', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, score: { column: 'score', type: 'decimal', nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'AVG', entity: e, field: 'score' }))
      .toBe('SELECT ROUND(AVG(users.score), 2) FROM users');
  });
  it('MIN_MAX requires which', () => {
    const e = { ...userEntity, fields: { ...userEntity.fields, score: { column: 'score', type: 'decimal', nullable: false, searchable: false } } };
    expect(() => buildPrimitive({ primitive: 'MIN_MAX', entity: e, field: 'score' }))
      .toThrow(/which/);
  });
  it('TOP_N uses provided rankField', () => {
    const e = { ...userEntity, rankingCandidates: ['created_at'], fields: { ...userEntity.fields, created_at: { column: 'created_at', type: 'timestamp', nullable: false, searchable: false } } };
    expect(buildPrimitive({ primitive: 'TOP_N', entity: e, n: 5 }))
      .toContain('ORDER BY users.created_at DESC LIMIT 5');
  });
  it('throws when SUM field not on entity', () => {
    expect(() => buildPrimitive({ primitive: 'SUM', entity: userEntity, field: 'nope' }))
      .toThrow(/not in entity/);
  });
```

- [ ] **Step 2: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/primitives.test.ts`
Expected: 7 passed.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/__tests__/grammar/primitives.test.ts
git commit -m "$(cat <<'EOF'
test(grammar): cover SUM/AVG/MIN_MAX/TOP_N primitives + validation errors

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Modifiers — where, time

**Files:**
- Create: `packages/agent/src/grammar/modifiers.ts`
- Test: `packages/agent/src/__tests__/grammar/modifiers.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { applyModifier, Modifier } from '../../grammar/modifiers.js';
import { Entity } from '../../grammar/registry.js';

const e: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
  primaryKey: 'id', timestamps: { created: 'created_at', deleted: 'deleted_at' },
  fields: {
    status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1, banned: 2 }, searchable: false },
    created_at: { column: 'created_at', type: 'timestamp', nullable: false, searchable: false },
  },
  scopes: {}, associations: {}, rankingCandidates: [],
};

describe('modifiers', () => {
  it('applies WHERE with enum value resolution', () => {
    const m: Modifier = { kind: 'where', field: 'status', op: 'eq', value: 'active' };
    const out = applyModifier('SELECT COUNT(*) FROM users', m, e);
    expect(out).toBe('SELECT COUNT(*) FROM users WHERE users.status = 1');
  });

  it('rejects unknown enum value', () => {
    const m: Modifier = { kind: 'where', field: 'status', op: 'eq', value: 'pending' };
    expect(() => applyModifier('SELECT COUNT(*) FROM users', m, e))
      .toThrow(/enum value.*not.*registry/);
  });

  it('applies TIME last_30_days', () => {
    const m: Modifier = { kind: 'time', field: 'created_at', window: 'last_30_days' };
    const out = applyModifier('SELECT COUNT(*) FROM users', m, e);
    expect(out).toBe("SELECT COUNT(*) FROM users WHERE users.created_at >= NOW() - INTERVAL '30 days'");
  });

  it('chains multiple modifiers with AND', () => {
    let sql = 'SELECT COUNT(*) FROM users';
    sql = applyModifier(sql, { kind: 'where', field: 'status', op: 'eq', value: 'active' }, e);
    sql = applyModifier(sql, { kind: 'time', field: 'created_at', window: 'last_30_days' }, e);
    expect(sql).toContain('WHERE users.status = 1');
    expect(sql).toContain('AND users.created_at >=');
  });
});
```

- [ ] **Step 2: Implement modifiers.ts**

```ts
import { Entity } from './registry.js';

export type Modifier =
  | { kind: 'where'; field: string; op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'in'; value: any }
  | { kind: 'time'; field: string; window: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month' | 'this_year' }
  | { kind: 'join'; association: string }
  | { kind: 'group_by'; field: string }
  | { kind: 'having'; field: string; op: string; value: any }
  | { kind: 'order_by'; field: string; direction: 'asc' | 'desc' }
  | { kind: 'limit'; value: number }
  | { kind: 'distinct' };

const WINDOWS: Record<string, string> = {
  today: "DATE_TRUNC('day', NOW())",
  yesterday: "DATE_TRUNC('day', NOW() - INTERVAL '1 day')",
  last_7_days: "NOW() - INTERVAL '7 days'",
  last_30_days: "NOW() - INTERVAL '30 days'",
  this_month: "DATE_TRUNC('month', NOW())",
  this_year: "DATE_TRUNC('year', NOW())",
};

const OPS: Record<string, string> = { eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function applyModifier(sql: string, m: Modifier, e: Entity): string {
  switch (m.kind) {
    case 'where':  return applyWhere(sql, m, e);
    case 'time':   return applyTime(sql, m, e);
    case 'join':   return applyJoin(sql, m, e);
    case 'group_by': return applyGroupBy(sql, m, e);
    case 'having': return applyHaving(sql, m, e);
    case 'order_by': return applyOrderBy(sql, m, e);
    case 'limit':  return applyLimit(sql, m);
    case 'distinct': return sql.replace(/^SELECT /, 'SELECT DISTINCT ');
  }
}

function appendClause(sql: string, clause: string): string {
  if (/ WHERE /i.test(sql)) return `${sql} AND ${clause}`;
  return `${sql} WHERE ${clause}`;
}

function applyWhere(sql: string, m: Extract<Modifier, { kind: 'where' }>, e: Entity): string {
  const field = e.fields[m.field];
  if (!field) throw new Error(`field '${m.field}' not on entity ${e.name}`);
  let value = m.value;
  if (field.type === 'enum') {
    if (!field.enumValues || !(String(value) in field.enumValues)) {
      throw new Error(`enum value '${value}' not in registry for ${e.name}.${m.field}`);
    }
    value = field.enumValues[String(value)];
  }
  const op = OPS[m.op] ?? '=';
  const formatted = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value;
  return appendClause(sql, `${e.table}.${m.field} ${op} ${formatted}`);
}

function applyTime(sql: string, m: Extract<Modifier, { kind: 'time' }>, e: Entity): string {
  const expr = WINDOWS[m.window];
  if (!expr) throw new Error(`unknown time window ${m.window}`);
  return appendClause(sql, `${e.table}.${m.field} >= ${expr}`);
}

function applyJoin(sql: string, m: Extract<Modifier, { kind: 'join' }>, e: Entity): string {
  const assoc = e.associations[m.association];
  if (!assoc) throw new Error(`association '${m.association}' not on entity ${e.name}`);
  // insert JOIN before any WHERE
  const matchWhere = sql.match(/ WHERE /i);
  const joinClause = ` JOIN ${assoc.targetEntity === assoc.name ? '' : ''}${assoc.joinClause.split(' = ')[1].split('.')[0]} ON ${assoc.joinClause}`;
  return matchWhere ? sql.replace(/ WHERE /i, `${joinClause} WHERE `) : `${sql}${joinClause}`;
}

function applyGroupBy(sql: string, m: Extract<Modifier, { kind: 'group_by' }>, e: Entity): string {
  if (!e.fields[m.field]) throw new Error(`group_by field '${m.field}' not on entity ${e.name}`);
  return `${sql} GROUP BY ${e.table}.${m.field}`;
}

function applyHaving(sql: string, m: Extract<Modifier, { kind: 'having' }>, e: Entity): string {
  if (!/GROUP BY/i.test(sql)) throw new Error('HAVING requires GROUP BY');
  const op = OPS[m.op] ?? '=';
  return `${sql} HAVING ${m.field} ${op} ${m.value}`;
}

function applyOrderBy(sql: string, m: Extract<Modifier, { kind: 'order_by' }>, e: Entity): string {
  if (!e.fields[m.field]) throw new Error(`order_by field '${m.field}' not on entity ${e.name}`);
  return `${sql} ORDER BY ${e.table}.${m.field} ${m.direction.toUpperCase()}`;
}

function applyLimit(sql: string, m: Extract<Modifier, { kind: 'limit' }>): string {
  if (/LIMIT \d+/i.test(sql)) return sql.replace(/LIMIT \d+/i, `LIMIT ${m.value}`);
  return `${sql} LIMIT ${m.value}`;
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/modifiers.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/modifiers.ts packages/agent/src/__tests__/grammar/modifiers.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): 8 modifier appliers — where, time, join, group_by, having,
order_by, limit, distinct. Enum value resolution + field existence checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Modifier test coverage (join, group_by, having, order_by, limit, distinct)

**Files:**
- Modify: `packages/agent/src/__tests__/grammar/modifiers.test.ts`

- [ ] **Step 1: Add tests covering remaining 6 modifiers**

```ts
  it('applies JOIN using association joinClause', () => {
    const withAssoc: Entity = { ...e, associations: {
      orders: { name: 'orders', kind: 'has_many', targetEntity: 'order', joinClause: 'users.id = orders.user_id' }
    }};
    const out = applyModifier('SELECT COUNT(*) FROM users', { kind: 'join', association: 'orders' }, withAssoc);
    expect(out).toContain('JOIN orders ON users.id = orders.user_id');
  });

  it('applies GROUP BY', () => {
    const e2 = { ...e, fields: { ...e.fields, country: { column: 'country', type: 'text', nullable: false, searchable: true } } };
    const out = applyModifier('SELECT COUNT(*) FROM users', { kind: 'group_by', field: 'country' }, e2);
    expect(out).toContain('GROUP BY users.country');
  });

  it('HAVING requires GROUP BY', () => {
    expect(() => applyModifier('SELECT 1 FROM users', { kind: 'having', field: 'c', op: 'gt', value: 5 }, e))
      .toThrow(/GROUP BY/);
  });

  it('applies ORDER BY', () => {
    const out = applyModifier('SELECT * FROM users', { kind: 'order_by', field: 'created_at', direction: 'desc' }, e);
    expect(out).toContain('ORDER BY users.created_at DESC');
  });

  it('applies LIMIT', () => {
    const out = applyModifier('SELECT * FROM users', { kind: 'limit', value: 25 }, e);
    expect(out).toContain('LIMIT 25');
  });

  it('applies DISTINCT', () => {
    const out = applyModifier('SELECT email FROM users', { kind: 'distinct' }, e);
    expect(out).toBe('SELECT DISTINCT email FROM users');
  });
```

- [ ] **Step 2: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/modifiers.test.ts`
Expected: 10 passed.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/__tests__/grammar/modifiers.test.ts
git commit -m "$(cat <<'EOF'
test(grammar): cover JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/DISTINCT modifiers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Template compiler orchestration

**Files:**
- Create: `packages/agent/src/grammar/template-compiler.ts`
- Test: `packages/agent/src/__tests__/grammar/template-compiler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { compileTemplate, Intent } from '../../grammar/template-compiler.js';
import { Registry } from '../../grammar/registry.js';

const registry: Registry = {
  version: 1, generatedAt: '', framework: 'rails',
  aliases: { customers: 'user' },
  entities: {
    user: {
      name: 'user', table: 'users', displayLabel: 'User', rowCount: 10,
      primaryKey: 'id',
      timestamps: { deleted: 'deleted_at' },
      fields: {
        status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1, banned: 2 }, searchable: false },
        created_at: { column: 'created_at', type: 'timestamp', nullable: false, searchable: false },
        deleted_at: { column: 'deleted_at', type: 'timestamp', nullable: true, searchable: false },
      },
      scopes: {}, associations: {}, rankingCandidates: [],
    },
  },
};

describe('compileTemplate', () => {
  it('compiles COUNT + where + time + auto soft-delete', () => {
    const intent: Intent = {
      status: 'matched',
      primitive: 'COUNT',
      entity: 'user',
      modifiers: [
        { kind: 'where', field: 'status', op: 'eq', value: 'active' },
        { kind: 'time', field: 'created_at', window: 'last_30_days' },
      ],
      confidence: 0.9,
    };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(true);
    expect(out.sql).toContain('SELECT COUNT(*) FROM users');
    expect(out.sql).toContain('users.status = 1');
    expect(out.sql).toContain("users.created_at >= NOW() - INTERVAL '30 days'");
    expect(out.sql).toContain('users.deleted_at IS NULL');
  });

  it('returns {ok:false} when entity not in registry', () => {
    const intent: Intent = { status: 'matched', primitive: 'COUNT', entity: 'ghost', modifiers: [], confidence: 0.9 };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/entity/);
  });

  it('returns {ok:false} when intent is unmatched', () => {
    const intent: Intent = { status: 'unmatched', confidence: 0.2, reason: 'nope' };
    const out = compileTemplate(intent, registry);
    expect(out.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement template-compiler.ts**

```ts
import { Registry, Entity } from './registry.js';
import { buildPrimitive, PrimitiveKind } from './primitives.js';
import { applyModifier, Modifier } from './modifiers.js';

export type Intent =
  | {
      status: 'matched';
      primitive: PrimitiveKind;
      entity: string;
      modifiers: Modifier[];
      field?: string;
      which?: 'MIN' | 'MAX';
      n?: number;
      rankField?: string;
      groupBy?: string;
      confidence: number;
    }
  | { status: 'unmatched'; confidence: number; reason: string };

export type CompileResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

export function compileTemplate(intent: Intent, registry: Registry): CompileResult {
  if (intent.status === 'unmatched') {
    return { ok: false, reason: `unmatched: ${intent.reason}` };
  }

  const entityName = registry.aliases[intent.entity] ?? intent.entity;
  const entity = registry.entities[entityName];
  if (!entity) return { ok: false, reason: `entity '${intent.entity}' not in registry` };

  try {
    let sql = buildPrimitive({
      primitive: intent.primitive,
      entity,
      field: intent.field,
      which: intent.which,
      n: intent.n,
      rankField: intent.rankField,
      groupBy: intent.groupBy,
    });

    for (const m of intent.modifiers) sql = applyModifier(sql, m, entity);

    if (entity.timestamps.deleted) {
      sql = withSoftDelete(sql, entity);
    }

    if (!/LIMIT \d+/i.test(sql) && intent.primitive !== 'COUNT' && !/COUNT\(/i.test(sql)) {
      sql = `${sql} LIMIT 100`;
    }

    return { ok: true, sql };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function withSoftDelete(sql: string, entity: Entity): string {
  const col = entity.timestamps.deleted!;
  const clause = `${entity.table}.${col} IS NULL`;
  if (new RegExp(`${entity.table}\\.${col}`, 'i').test(sql)) return sql;
  if (/ WHERE /i.test(sql)) return sql.replace(/ WHERE /i, ` WHERE ${clause} AND `);
  const beforeGroupOrOrder = sql.match(/ (GROUP BY|ORDER BY|LIMIT) /i);
  if (beforeGroupOrOrder) return sql.replace(beforeGroupOrOrder[0], ` WHERE ${clause}${beforeGroupOrOrder[0]}`);
  return `${sql} WHERE ${clause}`;
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/template-compiler.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/template-compiler.ts packages/agent/src/__tests__/grammar/template-compiler.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): template compiler orchestrates primitives + modifiers + auto
soft-delete injection. Returns discriminated {ok, sql}|{ok:false, reason}.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Ruby mirror of primitives + modifiers + template compiler

Ruby side needs equivalent behavior for the Rails gem path. Since the Ruby grammar pipeline mirrors the TS version, port each module with parallel rspec tests.

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/grammar/primitives.rb`
- Create: `sql-chatbot-rails/lib/sql_chatbot/grammar/modifiers.rb`
- Create: `sql-chatbot-rails/lib/sql_chatbot/grammar/template_compiler.rb`
- Test: `sql-chatbot-rails/spec/sql_chatbot/grammar/primitives_spec.rb`
- Test: `sql-chatbot-rails/spec/sql_chatbot/grammar/modifiers_spec.rb`
- Test: `sql-chatbot-rails/spec/sql_chatbot/grammar/template_compiler_spec.rb`

- [ ] **Step 1: Port primitives.rb — tests first (mirror TS test cases)**
- [ ] **Step 2: Implement primitives.rb**
- [ ] **Step 3: Port modifiers.rb — tests first**
- [ ] **Step 4: Implement modifiers.rb**
- [ ] **Step 5: Port template_compiler.rb — tests first**
- [ ] **Step 6: Implement template_compiler.rb**

Each of these ports uses the same logic as the TS version, translated to Ruby idioms. Implementer should copy test cases from the TS tests verbatim (same inputs → same expected SQL strings), just restructured for rspec.

- [ ] **Step 7: Run full Rails spec suite**

Run: `cd sql-chatbot-rails && bundle exec rspec`
Expected: All existing 350 + new (~30) pass.

- [ ] **Step 8: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/grammar sql-chatbot-rails/spec/sql_chatbot/grammar
git commit -m "$(cat <<'EOF'
feat(rails/grammar): port primitives, modifiers, template compiler to Ruby

Same logic as TS implementation. Tests mirror npm test cases for parity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: End of Phase 2 — update master index

- [ ] **Step 1: Tick checkboxes in `docs/grammar/README.md`** under P2.
- [ ] **Step 2: Append progress entry to `docs/grammar/progress.md`**.
- [ ] **Step 3: Run full test suite, verify no regressions.**

Run: `cd packages/agent && npx vitest run && cd ../../sql-chatbot-rails && bundle exec rspec`

- [ ] **Step 4: Commit docs update**

---

# Phase 3 — Intent Extractor (~3 days)

## Task 18: Entity candidate pre-selection

Pre-select top-5 entities by string match + alias lookup so the LLM prompt stays small.

**Files:**
- Create: `packages/agent/src/grammar/entity-candidates.ts`
- Test: `packages/agent/src/__tests__/grammar/entity-candidates.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { selectEntityCandidates } from '../../grammar/entity-candidates.js';
import { Registry } from '../../grammar/registry.js';

const registry: Registry = {
  version: 1, generatedAt: '', framework: 'rails',
  aliases: { customers: 'user', folks: 'user' },
  entities: {
    user: { name: 'user', table: 'users', displayLabel: 'User', rowCount: 100 } as any,
    order: { name: 'order', table: 'orders', displayLabel: 'Order', rowCount: 500 } as any,
    product: { name: 'product', table: 'products', displayLabel: 'Product', rowCount: 50 } as any,
    account: { name: 'account', table: 'accounts', displayLabel: 'Account', rowCount: 10 } as any,
    setting: { name: 'setting', table: 'settings', displayLabel: 'Setting', rowCount: 5 } as any,
    audit_log: { name: 'audit_log', table: 'audit_logs', displayLabel: 'AuditLog', rowCount: 10000 } as any,
  },
};

describe('selectEntityCandidates', () => {
  it('matches exact entity name in question', () => {
    const c = selectEntityCandidates('how many users', registry, 5);
    expect(c[0].name).toBe('user');
  });

  it('resolves alias', () => {
    const c = selectEntityCandidates('how many customers', registry, 5);
    expect(c[0].name).toBe('user');
  });

  it('returns up to top-N by match strength', () => {
    const c = selectEntityCandidates('orders and products', registry, 3);
    expect(c.slice(0, 2).map(e => e.name).sort()).toEqual(['order', 'product']);
    expect(c.length).toBeLessThanOrEqual(3);
  });

  it('falls back to highest-rowCount entities when no match', () => {
    const c = selectEntityCandidates('hello there', registry, 3);
    expect(c[0].name).toBe('audit_log');
  });
});
```

- [ ] **Step 2: Implement entity-candidates.ts**

```ts
import { Registry, Entity } from './registry.js';

export function selectEntityCandidates(question: string, registry: Registry, topN: number): Entity[] {
  const q = question.toLowerCase();
  const scores: Array<{ entity: Entity; score: number }> = [];

  for (const entity of Object.values(registry.entities)) {
    let score = 0;
    const singular = entity.name.toLowerCase();
    const plural = entity.table.toLowerCase();
    if (q.includes(` ${singular} `) || q.startsWith(`${singular} `) || q.endsWith(` ${singular}`)) score += 10;
    if (q.includes(plural)) score += 10;
    if (q.includes(singular)) score += 5;
    for (const [alias, target] of Object.entries(registry.aliases)) {
      if (target !== entity.name) continue;
      if (q.includes(alias.toLowerCase())) score += 8;
    }
    scores.push({ entity, score });
  }

  const sorted = scores.sort((a, b) => b.score - a.score);
  if (sorted[0]?.score === 0) {
    return Object.values(registry.entities)
      .sort((a, b) => b.rowCount - a.rowCount)
      .slice(0, topN);
  }
  return sorted.slice(0, topN).map(s => s.entity);
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/entity-candidates.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/entity-candidates.ts packages/agent/src/__tests__/grammar/entity-candidates.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): entity candidate pre-selection by name/alias match

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Intent extractor (LLM call + JSON parse + confidence gate)

**Files:**
- Create: `packages/agent/src/grammar/intent-extractor.ts`
- Test: `packages/agent/src/__tests__/grammar/intent-extractor.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { extractIntent } from '../../grammar/intent-extractor.js';
import { Registry, Entity } from '../../grammar/registry.js';

const userEntity: Entity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 100, primaryKey: 'id',
  timestamps: {},
  fields: { status: { column: 'status', type: 'enum', nullable: false, enumValues: { active: 1 }, searchable: false } },
  scopes: {}, associations: {}, rankingCandidates: [],
};
const registry: Registry = { version: 1, generatedAt: '', framework: 'rails', aliases: {}, entities: { user: userEntity } };

describe('extractIntent', () => {
  it('parses matched intent from LLM JSON', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user',
      modifiers: [{ kind: 'where', field: 'status', op: 'eq', value: 'active' }],
      confidence: 0.92,
    }));
    const r = await extractIntent({ question: 'how many active users', registry, history: [], callLLM: fakeLLM });
    expect(r.status).toBe('matched');
    if (r.status === 'matched') expect(r.primitive).toBe('COUNT');
  });

  it('returns unmatched when LLM confidence below threshold', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user', modifiers: [], confidence: 0.3,
    }));
    const r = await extractIntent({ question: 'x', registry, history: [], callLLM: fakeLLM, confidenceThreshold: 0.7 });
    expect(r.status).toBe('unmatched');
  });

  it('returns unmatched when LLM returns malformed JSON', async () => {
    const fakeLLM = vi.fn().mockResolvedValue('not json at all');
    const r = await extractIntent({ question: 'x', registry, history: [], callLLM: fakeLLM });
    expect(r.status).toBe('unmatched');
  });

  it('passes entity candidates into prompt', async () => {
    const fakeLLM = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unmatched', confidence: 0, reason: 'x' }));
    await extractIntent({ question: 'users', registry, history: [], callLLM: fakeLLM });
    const prompt = fakeLLM.mock.calls[0][0];
    const serialized = JSON.stringify(prompt);
    expect(serialized).toContain('user');
    expect(serialized).toContain('COUNT');
  });
});
```

- [ ] **Step 2: Implement intent-extractor.ts**

```ts
import { Registry } from './registry.js';
import { Intent } from './template-compiler.js';
import { selectEntityCandidates } from './entity-candidates.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from '../prompts/classify.js';

export interface ExtractIntentInput {
  question: string;
  registry: Registry;
  history: ChatMessage[];
  callLLM: (messages: ChatCompletionMessageParam[]) => Promise<string>;
  confidenceThreshold?: number;
}

const PRIMITIVE_DESCRIPTIONS = `
COUNT — how many rows of X
LIST — show/list rows of X
SUM — total of numeric field on X
AVG — average of numeric field on X
MIN_MAX — lowest/highest value of field on X
TOP_N — top N rows of X ordered by a ranking field
RANK — window-ranked rows of X within groups
`.trim();

const MODIFIER_DESCRIPTIONS = `
where     — filter by a field value (op: eq/neq/lt/lte/gt/gte/like/in)
time      — filter by time window on a timestamp field (today/yesterday/last_7_days/last_30_days/this_month/this_year)
join      — include a related entity via association
group_by  — group results by field
having    — filter grouped results by aggregate op+value
order_by  — order results by field (asc/desc)
limit     — cap result count
distinct  — deduplicate rows
`.trim();

export async function extractIntent(input: ExtractIntentInput): Promise<Intent> {
  const threshold = input.confidenceThreshold ?? 0.7;
  const candidates = selectEntityCandidates(input.question, input.registry, 5);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input.question, candidates, input.history);
  let raw: string;
  try {
    raw = await input.callLLM([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (e) {
    return { status: 'unmatched', confidence: 0, reason: `llm_error: ${(e as Error).message}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unmatched', confidence: 0, reason: 'malformed_json' };
  }

  if (parsed.status === 'unmatched') {
    return { status: 'unmatched', confidence: parsed.confidence ?? 0, reason: parsed.reason ?? 'unmatched' };
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < threshold) {
    return { status: 'unmatched', confidence: parsed.confidence ?? 0, reason: `low_confidence:${parsed.confidence}` };
  }
  return parsed as Intent;
}

function buildSystemPrompt(): string {
  return `You are an intent classifier for a SQL chatbot. Given a user question and a list of available entities, extract a structured intent.

Primitives:
${PRIMITIVE_DESCRIPTIONS}

Modifiers:
${MODIFIER_DESCRIPTIONS}

You MUST output JSON. If the question doesn't fit any primitive cleanly, set status=unmatched.

Output shape:
{"status":"matched","primitive":"COUNT","entity":"user","modifiers":[{"kind":"where","field":"status","op":"eq","value":"active"}],"confidence":0.92}
or
{"status":"unmatched","confidence":0.3,"reason":"question requires compare-to-average, no primitive covers this"}

Rules:
- Only reference entities from the provided candidates. Never invent.
- Only use fields listed under the chosen entity.
- For enum filters, pass the enum key (e.g. "active"), NOT the underlying integer.
- Set confidence honestly: 0.9+ only when every slot has a clear mapping.
- When in doubt, return unmatched.`;
}

function buildUserPrompt(question: string, candidates: ReturnType<typeof selectEntityCandidates>, history: ChatMessage[]): string {
  const historyText = history.slice(-2).map(m => `${m.role}: ${m.content}`).join('\n');
  const entityBlocks = candidates.map(e => formatEntityBrief(e)).join('\n\n');
  return `History:\n${historyText}\n\nEntity candidates:\n${entityBlocks}\n\nQuestion: ${question}`;
}

function formatEntityBrief(e: any): string {
  const fields = Object.entries(e.fields).slice(0, 15).map(([n, f]: any) => {
    const enumPart = f.enumValues ? ` enum=${JSON.stringify(f.enumValues)}` : '';
    return `  ${n}: ${f.type}${enumPart}`;
  }).join('\n');
  const assocs = Object.keys(e.associations).slice(0, 8).join(', ') || '(none)';
  const scopes = Object.keys(e.scopes).slice(0, 8).join(', ') || '(none)';
  return `Entity: ${e.name} (table=${e.table}, rows=${e.rowCount})\nFields:\n${fields}\nAssociations: ${assocs}\nScopes: ${scopes}`;
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/intent-extractor.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/intent-extractor.ts packages/agent/src/__tests__/grammar/intent-extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): intent extractor — small-LLM call with structured JSON output

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Miss logger (ndjson)

**Files:**
- Create: `packages/agent/src/grammar/miss-logger.ts`
- Test: `packages/agent/src/__tests__/grammar/miss-logger.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logMiss } from '../../grammar/miss-logger.js';

describe('logMiss', () => {
  it('appends ndjson entry with timestamp', () => {
    const f = path.join(os.tmpdir(), `grammar-miss-${Date.now()}.ndjson`);
    logMiss(f, { question: 'x', reason: 'unmatched', extracted: null });
    logMiss(f, { question: 'y', reason: 'unknown_entity', extracted: { entity: 'ghost' } });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.question).toBe('x');
    expect(typeof parsed.ts).toBe('string');
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `grammar-${Date.now()}`);
    const f = path.join(dir, 'nested', 'miss.ndjson');
    logMiss(f, { question: 'z', reason: 'x', extracted: null });
    expect(fs.existsSync(f)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement miss-logger.ts**

```ts
import fs from 'fs';
import path from 'path';

export interface MissEntry {
  question: string;
  reason: string;
  extracted: unknown;
  resultingSql?: string;
}

export function logMiss(logPath: string, entry: MissEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logPath, line);
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/miss-logger.test.ts`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/miss-logger.ts packages/agent/src/__tests__/grammar/miss-logger.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): ndjson miss logger for telemetry-driven primitive additions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Ruby mirrors of entity candidates + intent extractor + miss logger

- [ ] **Step 1-6:** Port each TS module to Ruby with tests first.
- [ ] **Step 7: Run full Rails spec suite**
- [ ] **Step 8: Commit**

---

## Task 22: End of Phase 3 — update master index

Tick P3 boxes, append progress entry, run full suite, commit docs.

---

# Phase 4 — Orchestrator Integration (~3-4 days)

## Task 23: tryGrammarPath entry point

**Files:**
- Create: `packages/agent/src/grammar/try-grammar-path.ts`
- Test: `packages/agent/src/__tests__/grammar/try-grammar-path.test.ts`

- [ ] **Step 1: Write failing test**

Tests the full grammar pipeline: `question + registry + mocked LLM → {ok, sql}|{ok:false, reason}`.

```ts
import { describe, it, expect, vi } from 'vitest';
import { tryGrammarPath } from '../../grammar/try-grammar-path.js';
// ... fixture registry, mocked callLLM ...

describe('tryGrammarPath', () => {
  it('returns {ok:true, sql} for a valid matched intent', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'user',
      modifiers: [{ kind: 'where', field: 'status', op: 'eq', value: 'active' }],
      confidence: 0.9,
    }));
    const r = await tryGrammarPath({ question: 'how many active users', registry, history: [], callLLM });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain('COUNT(*)');
  });

  it('returns {ok:false, reason:"unmatched"} when intent extractor says unmatched', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unmatched', confidence: 0, reason: 'x' }));
    const r = await tryGrammarPath({ question: 'x', registry, history: [], callLLM });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unmatched/);
  });

  it('returns {ok:false} when compile fails due to unknown entity', async () => {
    const callLLM = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'matched', primitive: 'COUNT', entity: 'ghost', modifiers: [], confidence: 0.9,
    }));
    const r = await tryGrammarPath({ question: 'x', registry, history: [], callLLM });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement try-grammar-path.ts**

```ts
import { Registry } from './registry.js';
import { extractIntent } from './intent-extractor.js';
import { compileTemplate, CompileResult } from './template-compiler.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from '../prompts/classify.js';

export interface TryGrammarInput {
  question: string;
  registry: Registry;
  history: ChatMessage[];
  callLLM: (messages: ChatCompletionMessageParam[]) => Promise<string>;
  confidenceThreshold?: number;
}

export type TryGrammarResult = CompileResult & { intent?: unknown };

export async function tryGrammarPath(input: TryGrammarInput): Promise<TryGrammarResult> {
  const intent = await extractIntent({
    question: input.question,
    registry: input.registry,
    history: input.history,
    callLLM: input.callLLM,
    confidenceThreshold: input.confidenceThreshold,
  });
  const result = compileTemplate(intent, input.registry);
  return { ...result, intent };
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd packages/agent && npx vitest run src/__tests__/grammar/try-grammar-path.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/grammar/try-grammar-path.ts packages/agent/src/__tests__/grammar/try-grammar-path.test.ts
git commit -m "$(cat <<'EOF'
feat(grammar): tryGrammarPath top-level entry — extractor + compiler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 24: Orchestrator integration — handleData grammar branch

**Files:**
- Modify: `packages/agent/src/services/orchestrator.ts`
- Test: `packages/agent/src/__tests__/orchestrator-grammar.test.ts`

- [ ] **Step 1: Write failing test**

Integration-style test that mocks LLM + uses real registry/compiler.

```ts
// Test that Orchestrator emits `grammar_matched` SSE then executes compiled SQL
// Test that Orchestrator emits `grammar_fallback` when compile fails, then falls through to existing path
// Test that config.grammar.enabled=false bypasses grammar entirely
```

- [ ] **Step 2: Modify Orchestrator**

In `packages/agent/src/services/orchestrator.ts`, add to `OrchestratorDeps`:
```ts
  registry?: Registry;
  grammarConfig?: { enabled: boolean; confidenceThreshold: number; missLogPath: string };
```

Refactor `handleData` (don't modify `handleDataWithCode` call sites — grammar branches off the same method):

```ts
  private async *handleData(
    input: AskInput,
    history: ChatMessage[],
    schemaSummary: string,
    codeContext?: string,
    codeSnippets?: CodeSnippet[],
  ): AsyncGenerator<SSEEvent> {
    const questionType: QuestionType = codeContext ? 'data_with_code' : 'data';

    // NEW: Try grammar path first when registry is available and enabled
    if (this.registry && this.grammarConfig?.enabled) {
      const grammarResult = await tryGrammarPath({
        question: input.question,
        registry: this.registry,
        history,
        callLLM: (messages) => callLLM(messages, { jsonMode: true }),
        confidenceThreshold: this.grammarConfig.confidenceThreshold,
      });
      if (grammarResult.ok) {
        yield { type: 'grammar_matched' };
        yield { type: 'sql', query: grammarResult.sql, explanation: 'generated by grammar compiler' };
        const validation = validateSql(grammarResult.sql);
        if (!validation.valid) {
          yield { type: 'error', message: validation.reason! };
          return;
        }
        yield { type: 'executing' };
        try {
          const result = await executeSql(this.databaseUrl, validation.sql!);
          const answerMessages = buildAnswerMessages({
            question: input.question, type: questionType, history,
            sqlResult: result.rows, sqlQuery: validation.sql!, codeSnippets, pageContext: input.pageContext,
          });
          for await (const chunk of streamLLM(answerMessages)) yield { type: 'token', content: chunk };
          return;
        } catch (err) {
          // fall through to LLM path
          logMiss(this.grammarConfig.missLogPath, {
            question: input.question, reason: 'grammar_execution_error',
            extracted: grammarResult.intent, resultingSql: grammarResult.sql,
          });
        }
      } else {
        yield { type: 'grammar_fallback', reason: grammarResult.reason };
        logMiss(this.grammarConfig.missLogPath, {
          question: input.question, reason: grammarResult.reason, extracted: grammarResult.intent,
        });
      }
    }

    // EXISTING CODE PATH — unchanged from today
    // ... (rest of current handleData implementation)
  }
```

Also update SSEEvent type to include `'grammar_matched' | 'grammar_fallback'`.

- [ ] **Step 3: Run integration tests**

Run: `cd packages/agent && npx vitest run src/__tests__/orchestrator-grammar.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full test suite, verify no regressions**

Run: `cd packages/agent && npx vitest run`
Expected: All 287 baseline + new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/services/orchestrator.ts packages/agent/src/__tests__/orchestrator-grammar.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): grammar-first branch in handleData with SSE events and
miss logging. Falls through to existing LLM path unchanged on any miss.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 25: Wire registry loading into middleware + CLI

**Files:**
- Modify: `packages/agent/src/middleware.ts` — call `loadRegistry` at startup, pass into `Orchestrator`
- Modify: `packages/agent/src/cli.ts` — same wiring for CLI mode

- [ ] **Step 1: Update middleware to build registry**

Near where `SchemaService` is initialized:
```ts
import { loadRegistry } from './grammar/registry-loader.js';

// after schemaService.discover(config.databaseUrl):
const registry = config.grammar.enabled
  ? loadRegistry({
      manifestPath: config.grammar.manifestPath!,
      schemaService,
      onWarn: (m) => console.warn(`[sql-chatbot] ${m}`),
    })
  : undefined;

const orchestrator = new Orchestrator({
  schemaService,
  codeIndexer,
  databaseUrl: config.databaseUrl,
  registry,
  grammarConfig: config.grammar,
});
```

- [ ] **Step 2: Run middleware tests**

Run: `cd packages/agent && npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS (existing tests; grammar is additive).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/middleware.ts packages/agent/src/cli.ts
git commit -m "$(cat <<'EOF'
feat(middleware): wire registry loading + grammar config into Orchestrator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 26: Rails integration — wire RegistryBuilder + grammar pipeline into controller

**Files:**
- Modify: `sql-chatbot-rails/app/controllers/sql_chatbot/chat_controller.rb`
- Create: `sql-chatbot-rails/lib/sql_chatbot/services/grammar_pipeline.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot/engine.rb` — build registry at engine boot

Mirror of Task 24+25 on the Rails side. `chat_controller.rb`'s data-question branch calls `GrammarPipeline.new(registry: @registry).try(question: ..., history: ...)`. On `:ok` → execute + stream. On `:miss` → existing LLM path.

- [ ] **Step 1-5:** Test, implement, test, verify full spec suite (350 baseline + new), commit.

---

## Task 27: Bit-identical-behavior regression test (grammar disabled)

**Files:**
- Create: `packages/agent/src/__tests__/grammar-disabled-parity.test.ts`

- [ ] **Step 1: Write test**

Fixture: 20 representative questions. With `grammar.enabled=false`, run each through Orchestrator (mocked LLM returning fixed SQL per question). Collect resulting SSE events + generated SQL. Assert they match a golden output file exactly.

```ts
describe('grammar-disabled parity', () => {
  it('produces identical SSE events and SQL when grammar.enabled=false', async () => {
    const fixtures = JSON.parse(fs.readFileSync('src/__tests__/fixtures/grammar-disabled-golden.json', 'utf8'));
    for (const fx of fixtures) {
      const events = await runOrchestrator({ question: fx.question, grammarEnabled: false, mockedLLMSQL: fx.mockSql });
      expect(events).toEqual(fx.expectedEvents);
    }
  });
});
```

- [ ] **Step 2-5:** Fixture file, implementation, test pass, commit.

---

## Task 28: 120-question replay harness

**Files:**
- Create: `packages/agent/src/__tests__/grammar-120-question-replay.test.ts` (skipped by default)
- Create: `packages/agent/src/__tests__/fixtures/realistic-120-questions.json`

The 120-question fixture must be populated from the same realistic question set used in the last accuracy test (4 apps × 30 questions). Each fixture includes: question, app DB URL, expected correctness criteria (DB-verified).

- [ ] **Step 1: Populate fixture**

Each of the 4 apps (Saleor, Chatwoot, Gitea, Redmine) contributes 30 questions with their correctness criteria. Test is skipped by default, enabled via `RUN_120_REPLAY=1`.

- [ ] **Step 2: Write harness**

```ts
const RUN = process.env.RUN_120_REPLAY === '1';
(RUN ? describe : describe.skip)('120-question replay', () => {
  it('reports grammar hit rate and accuracy per app', async () => {
    const fixtures = JSON.parse(fs.readFileSync('src/__tests__/fixtures/realistic-120-questions.json', 'utf8'));
    const results: any[] = [];
    for (const fx of fixtures) {
      const r = await runOneQuestion(fx);
      results.push(r);
    }
    const byApp = groupBy(results, 'app');
    for (const [app, rs] of Object.entries(byApp)) {
      const grammarHits = rs.filter(r => r.grammarMatched).length;
      const correct = rs.filter(r => r.correct).length;
      console.log(`${app}: grammar hit ${grammarHits}/${rs.length}, accuracy ${correct}/${rs.length}`);
    }
    const totalCorrect = results.filter(r => r.correct).length;
    expect(totalCorrect / results.length).toBeGreaterThanOrEqual(0.65);
    const totalHits = results.filter(r => r.grammarMatched).length;
    expect(totalHits / results.length).toBeGreaterThanOrEqual(0.35);
  }, 600000);
});
```

- [ ] **Step 3: Run (manual, on-demand)**

Run: `RUN_120_REPLAY=1 npx vitest run src/__tests__/grammar-120-question-replay.test.ts`
Expected: Accuracy ≥ 65%, hit rate ≥ 35%.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/__tests__/grammar-120-question-replay.test.ts packages/agent/src/__tests__/fixtures/realistic-120-questions.json
git commit -m "$(cat <<'EOF'
test(grammar): 120-question realistic replay harness (opt-in)

Expects >=65% accuracy and >=35% grammar hit rate across 4 apps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 29: End of Phase 4 — final master index update and acceptance check

- [ ] **Step 1: Run full test suite**

```bash
cd packages/agent && npx vitest run
cd ../../sql-chatbot-rails && bundle exec rspec
```

Expected: 287 npm baseline + ~100 new grammar tests all pass. 350 Rails baseline + ~50 new grammar tests all pass.

- [ ] **Step 2: Run 120-question replay**

```bash
cd packages/agent && RUN_120_REPLAY=1 npx vitest run src/__tests__/grammar-120-question-replay.test.ts
```

Expected: ≥65% accuracy, ≥35% hit rate. Record exact numbers.

- [ ] **Step 3: Update `docs/grammar/README.md`**

- Status → "V1 complete — all acceptance criteria met."
- Tick all remaining boxes in task checklist (P4 + acceptance criteria).
- Decision log: add any decisions made during implementation.

- [ ] **Step 4: Update `docs/grammar/progress.md`**

Append final P4 entry with actual numbers: tests added, accuracy achieved, hit rate, any deviations from plan.

- [ ] **Step 5: Commit**

```bash
git add docs/grammar/README.md docs/grammar/progress.md
git commit -m "$(cat <<'EOF'
docs(grammar): V1 complete — accuracy Xx%, hit rate Xx%

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Self-Review Notes

**Spec coverage:** Every section of the spec maps to at least one task:

| Spec section | Task(s) |
|---|---|
| §4 scope decisions | All — decisions baked into implementation |
| §5 architecture | Tasks 23-26 (orchestrator wiring) |
| §6.1 registry shape | Tasks 1-2 |
| §6.2 Rails builder | Tasks 5-6 |
| §6.3 npm Django builder | Tasks 7-8 |
| §6.4 intent extractor | Tasks 18-19 |
| §6.5 template compiler | Tasks 11-15 |
| §7 data flow | Tasks 23-24 (end-to-end in Orchestrator) |
| §8 error handling | Tasks 3, 9, 15, 19, 24 — errors route to fallback silently |
| §9 learning mechanism | Task 20 (miss logger); registry refresh is inherent to Tasks 5, 9 |
| §10 backward compat | Task 27 (parity test) |
| §11 testing | Throughout — tests first in every task |
| §12 acceptance criteria | Task 29 (final verification) |

**Type consistency check:** `Registry`, `Entity`, `Field`, `Scope`, `Association`, `PrimitiveKind`, `Modifier`, `Intent`, `CompileResult` — names consistent across all tasks. Ruby side uses snake_case equivalents per Ruby idiom but same structure.

**Branch discipline:** No task references merging. Every commit stays on `feature/compositional-grammar`.

**Master index discipline:** Tasks 10, 17, 22, 29 (end of each phase) explicitly update `docs/grammar/README.md` and `docs/grammar/progress.md`. No phase ends without the docs update.
