# Compositional Grammar Architecture — Design Spec

> **Status:** Design approved by user 2026-04-23. Implementation not started. Planning next.
> **Branch:** `feature/compositional-grammar`
> **Master index:** [`docs/grammar/README.md`](../../grammar/README.md)

---

## 1. Problem

The chatbot currently sends the full schema and prompt rules to an LLM on every question, asking the LLM to generate arbitrary SQL. DB-verified testing across 4 apps (Saleor, Chatwoot, Gitea, Redmine) × 30 realistic human-phrased questions each showed **55% accuracy**.

Failure patterns cluster around:

1. Name hallucinations (columns/tables that don't exist).
2. Multi-hop JOIN failures (polymorphic enums, lookup tables like Redmine `enumerations`).
3. Enum/filter value guessing (e.g., `status = 'active'` instead of `status = 1`).
4. Dropped filters on compound questions.

Adding more prompt rules or annotation types is patchwork. The user rejected this path and approved a structural replacement.

---

## 2. Goal

Replace "LLM generates arbitrary SQL" with **compositional grammar**: a small, closed set of primitives + modifiers that compose into thousands of SQL shapes. The LLM's job shrinks from "write SQL" to "classify the question into a structured intent JSON." Deterministic code does slot resolution and template compilation.

**Targets:**

- Accuracy on 120-question realistic test set: **≥ 65%** V1 minimum (target 69%+).
- Grammar hit rate: **≥ 35%** of questions handled without the full LLM SQL generator.
- Token cost per hit: **~55% of current** (smaller prompts, smaller model).
- Zero regression: fallback path is byte-identical to today's pipeline.

**Non-goals (explicitly punted to later):**

- Multi-database backends (PostgreSQL only, same as today).
- Hot-reload of the metadata registry.
- Auto-learned templates from LLM output (Vanna trap; explicitly rejected).
- Cross-session result caching (masks wrong answers).
- UI for reviewing miss logs (ndjson + grep is sufficient).

---

## 3. High-level approach

Grammar path runs **first**. If it matches → deterministic SQL. If it misses → fall through to **today's existing LLM pipeline unchanged**. No path is removed.

```
                                          ┌─ hit  → execute → answer
 question → Orchestrator → grammar path  ─┤
                                 │        └─ miss → (fallback) ──┐
                                 └────────────────────────────────→ existing LLM path (today's code, byte-identical)
```

Four new subsystems are added. None of today's code is deleted.

---

## 4. Scope decisions

Locked in by user during brainstorming (2026-04-23):

| Decision | Choice | Reasoning |
|---|---|---|
| Fallback strategy | Grammar first → existing LLM fallback | Never regress vs. today's 55%. Incremental rollout. |
| Framework scope V1 | Rails gem (runtime AR introspection) + npm package (Django AST parser). Other frameworks on npm get schema+data-only registry. | Covers 3 of 4 tested apps. Django is most common non-Rails. Other framework parsers added post-V1. |
| Registry build — Rails | Runtime (at boot, via `ModelIntrospector` extension) | Rails process already has AR loaded; re-using same infra. |
| Registry build — npm | Build-time CLI: `sql-chatbot-agent introspect --framework=django` writes `sql-chatbot-manifest.json` | No Python runtime dep on production server. Deterministic across dev/staging/prod. |
| Intent extraction | LLM-based (`gpt-5-mini` or equivalent small model) with structured JSON output | Handles human phrasings, typos, casual language. Avoids flat-pattern-list antipattern. |
| Learning mechanism | Registry refresh on boot + manual primitive additions from telemetry review. **No auto-learning from LLM output.** | Vanna-style template extraction bakes LLM errors in permanently. |

---

## 5. Architecture

Two layers bolted onto today's pipeline:

**Layer 1 — Metadata Registry**
A single in-memory object holding entities, fields (with enum values, FKs, types), scopes (named filters from code), associations (precomputed JOINs), and aliases. Shared format between Rails and npm. The framework-specific part is just *construction*; everything downstream is framework-agnostic.

**Layer 2 — Grammar pipeline**
Intent Extractor (LLM) → Template Compiler (deterministic) → existing `validateSql` → existing executor.

### New subsystems

1. **Metadata Registry** — data contract between framework-specific builders and framework-agnostic grammar code.
2. **Registry Builder** — two implementations:
   - Rails: `SqlChatbot::Services::RegistryBuilder` (extends `ModelIntrospector`).
   - npm: `grammar/introspectors/django.ts` + bundled Python AST script `scripts/django_introspect.py`, invoked via `sql-chatbot-agent introspect` CLI.
3. **Intent Extractor** — small-LLM call that takes question + 7 primitives + top-5 candidate entities, returns JSON `{status, primitive, entity, modifiers, confidence}`.
4. **Template Compiler** — pure code. Validates every slot against the registry, emits SQL. Never calls an LLM.

### Code locations

```
packages/agent/src/grammar/
├── registry.ts              — type definitions + lookup helpers
├── intent-extractor.ts      — LLM call + JSON parsing
├── template-compiler.ts     — primitive + modifier templates
├── primitives.ts            — 7 primitive definitions
├── modifiers.ts             — 8 modifier appliers
└── introspectors/
    ├── django.ts            — Node wrapper around Python subprocess
    └── scripts/django_introspect.py   — stdlib-only Python AST walker

sql-chatbot-rails/lib/sql_chatbot/
├── services/
│   ├── registry_builder.rb  — extends ModelIntrospector with registry output
│   └── grammar_pipeline.rb  — Ruby mirror of the grammar path
├── grammar/
│   ├── registry.rb          — matches TS Registry shape
│   ├── intent_extractor.rb
│   ├── template_compiler.rb
│   ├── primitives.rb
│   └── modifiers.rb

packages/agent/src/services/orchestrator.ts   — modified: handleData tries grammar path first
```

---

## 6. Components in detail

### 6.1 Registry (shared shape)

```ts
interface Registry {
  entities: Record<string, Entity>;
  aliases: Record<string, string>;
  version: number;
  generatedAt: string;
  framework: "rails" | "django" | "generic";
}

interface Entity {
  name: string;              // canonical singular, e.g. "user"
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

interface Field {
  column: string;
  type: "int" | "text" | "bool" | "timestamp" | "decimal" | "enum" | "jsonb" | "uuid";
  nullable: boolean;
  enumValues?: Record<string, number | string>;
  fkTo?: { entity: string; onColumn: string };
  userFacingLabel?: string;
  searchable: boolean;
}

interface Scope {
  name: string;              // "active"
  whereClause: string;       // "status = 1 AND deleted_at IS NULL"
  paramSlots: string[];
}

interface Association {
  name: string;
  kind: "belongs_to" | "has_many" | "has_one" | "has_many_through";
  targetEntity: string;
  joinClause: string;
  throughEntity?: string;
}
```

### 6.2 Registry Builder — Rails

- Reuses the Zeitwerk eager-load logic already in `ModelIntrospector`.
- For each AR model: `defined_enums`, `reflect_on_all_associations`, `columns_hash`, existing Paranoia/Discard detection, scope source via `method_source` or `parser` gem (decision at plan-writing time).
- Output: one `Registry` hash. Serialized via `JSON.dump` internally for the Ruby grammar pipeline.
- Existing annotation-string output stays intact (used as LLM fallback context).

### 6.3 Registry Builder — npm

- CLI: `sql-chatbot-agent introspect --framework=django --code=./myapp`.
- Spawns Python subprocess running bundled `django_introspect.py` (stdlib only, no pip).
- Python walks `models.py` files with `ast` module, extracts: `class X(models.Model)`, `Meta.db_table`, field assignments with `choices=`, Manager/QuerySet methods returning `self.filter(...)`, `ForeignKey`, `ManyToManyField`.
- Writes `sql-chatbot-manifest.json` at project root.
- At npm package boot, `resolveConfig` loads the manifest into the registry.
- For non-Django npm users: registry is built from schema + data profiler alone (thinner but still enables COUNT/LIST/basic WHERE/JOIN).

### 6.4 Intent Extractor

**Inputs to the LLM:**
```
Question: <user question>
History: last 2 turns
Available primitives: COUNT, LIST, SUM, AVG, MIN_MAX, TOP_N, RANK (with brief signatures)
Entity candidates: top 5 by string/alias match (selected in TS, no LLM) — full detail of just those 5.
```

Entity candidate pre-selection is purely local: string match + alias dict lookup. Keeps the prompt small.

**Output JSON:**
```json
{
  "status": "matched" | "unmatched",
  "primitive": "COUNT",
  "entity": "user",
  "modifiers": [
    { "kind": "where",    "field": "status",     "op": "eq", "value": "active" },
    { "kind": "time",     "field": "created_at", "window": "last_30_days" },
    { "kind": "join",     "association": "orders" },
    { "kind": "group_by", "field": "country" },
    { "kind": "order_by", "field": "created_at", "direction": "desc" },
    { "kind": "limit",    "value": 10 }
  ],
  "confidence": 0.92,
  "reason": "if status=unmatched, why"
}
```

**Model:** `gpt-5-mini` (or configurable smaller model). System prompt cache-friendly — primitives + shapes rarely change per session.

### 6.5 Template Compiler

Pure code. Given intent JSON + registry → SQL string.

**7 primitives:**

| Primitive | Shape |
|---|---|
| COUNT | `SELECT COUNT(*) FROM <entity.table>` |
| LIST | `SELECT <display_fields> FROM <entity.table>` |
| SUM | `SELECT SUM(<field>) FROM <entity.table>` |
| AVG | `SELECT ROUND(AVG(<field>), 2) FROM <entity.table>` |
| MIN_MAX | `SELECT <MIN\|MAX>(<field>) FROM <entity.table>` |
| TOP_N | `SELECT <display_fields> FROM <entity.table> ORDER BY <rank> DESC LIMIT <n>` |
| RANK | `... DENSE_RANK() OVER (PARTITION BY <group> ORDER BY <rank>)` |

**8 modifier kinds:** `where`, `time`, `join`, `group_by`, `having`, `order_by`, `limit`, `distinct`. Each has an `apply(sql, modifier, registry, entity)` function.

**Validation per slot:**
- Field must exist on entity.
- Type must be compatible (no SUM on text).
- Enum value must be in registry (no guessing).
- JOIN target must be an association defined in the registry.
- Invalid composition (TOP_N without rank field, HAVING without GROUP BY) rejected.

Compiled SQL still passes through existing `validateSql()` (SELECT-only defense).

---

## 7. Data flow

### Grammar-hit path (example: "how many active users signed up last month")

1. Orchestrator `handleData` enters grammar path.
2. Entity candidate selection (TS, ~1ms): top-5 includes `user`.
3. Intent extractor prompt built (~300 input tokens).
4. LLM call (~200ms, gpt-5-mini): returns `{primitive: COUNT, entity: user, modifiers: [where status=active, time created_at last_30_days], confidence: 0.94}`.
5. Template compiler:
   - COUNT + user → `SELECT COUNT(*) FROM users`
   - `where status=active` → registry resolves `active → 1` → `WHERE users.status = 1`
   - Soft-delete auto-injected from entity.timestamps.deleted → `AND users.deleted_at IS NULL`
   - `time created_at last_30_days` → `AND users.created_at >= NOW() - INTERVAL '30 days'`
6. `validateSql()` passes.
7. PG execute (~30ms) → `[{count: 127}]`.
8. Existing answer-stream LLM (unchanged).

Total: 2 LLM calls (intent + answer). Prompts ~3-4x smaller than today → ~55-70% token savings on hits.

### Fallback path (example: "which agents are overworked compared to team average")

1. Steps 1-3 same.
2. LLM returns `{status: unmatched, reason: "question requires compare-to-aggregate-subquery, no primitive covers this", confidence: 0.2}`.
3. Orchestrator logs event to `logs/grammar-misses.ndjson`. Emits SSE `{type: "grammar_fallback", reason: "unmatched"}`.
4. Falls through to today's `buildGenerateSqlMessages` → LLM → validate → execute → answer. **Byte-identical to current code.**

Overhead of fallback: one cheap intent extractor call (~$0.0002). Negligible.

### Follow-up pronoun handling

When history contains `[SQL: ...]` and question has "those"/"them"/"it":
- Intent extractor sees history in prompt, emits modifier with `filterFromPrevious: true`.
- Template compiler wraps prior SQL as subquery: `... WHERE id IN (SELECT id FROM (<prior_sql>) prev)`.
- If extractor can't resolve pronoun → `status: unmatched` → fallback handles it via existing rule 20 logic.

---

## 8. Error handling & edge cases

### Error classes

| Source | Response |
|---|---|
| Intent extractor malformed JSON | Treat as `unmatched`, fallback |
| Unknown primitive | Rejected, fallback |
| Hallucinated entity | Registry lookup null → fallback, log `unknown_entity:<name>` |
| Non-existent field | Compiler rejects → fallback |
| Enum value not in registry | Rejected (no guessing) → fallback |
| Type mismatch (SUM on text) | Rejected → fallback |
| Compiled SQL PG error | Rare. Log as `grammar_execution_error`, fall back |
| Fallback LLM path errors | Current behavior unchanged — surface `error` SSE |

**Invariant:** grammar path never surfaces its own errors to the user. Every failure is silent → fallback.

### Registry freshness

- Rails: rebuild on process boot. `db:migrate` + restart picks up schema changes.
- npm: manifest has `generatedAt`. On load, compare entity tables against live `pg_class`. Mismatch → warning-once, skip grammar for affected entities (use LLM path). Never crash.

### Registry builder failures

- Rails: per-model `rescue`, bad model excluded from entities, logs `registry_entity_skipped`.
- npm CLI: Python subprocess failure → CLI exits non-zero, no corrupt manifest written. Package runs as if no manifest (schema-only registry).
- Empty registry: grammar path is a no-op — every question goes to LLM fallback. No crash.

### Concurrency

Registry is immutable per boot. No locks needed. Intent extractor calls are stateless.

### Prompt injection

User input → intent extractor LLM. Template compiler validates every slot against registry + `validateSql()` enforces SELECT-only. Worst case: weird COUNT result. No data loss. Unsafe classification (existing logic) still runs before intent extraction.

### Cost control

- Small model ~200 input + ~100 output tokens per call. Est. ~$0.0002/call on gpt-5-mini pricing.
- 10k questions/day ≈ $2/day intent extractor cost.
- Hits skip the full SQL generator (expensive); total per-query cost drops on hits. Misses cost slightly more than today (~$0.0002 intent + today's full pipeline).
- Provider-switchable: OpenRouter, Groq, Ollama, OpenAI (same config as today).

---

## 9. Learning without Vanna trap

Grammar doesn't auto-learn from LLM output. Three explicit evolution mechanisms:

1. **Registry refresh (automatic, zero code change):** Rebuilds on boot. Developers adding `scope :popular` or `STATUS_CHOICES` → next boot, intent extractor can match "popular things" → scope, no code change from us.
2. **Telemetry-driven primitive additions (manual, us):** `logs/grammar-misses.ndjson` is the review queue. Cluster analysis on misses drives new primitive/modifier additions. Always human-reviewed.
3. **In-session SQL reuse (optional):** Same question re-asked in same conversation → reuse prior result. Not learning — just not calling LLM twice in one session.

Projected accuracy curve (assumes steady telemetry-driven improvements):

| Time | Grammar coverage | Weighted accuracy |
|---|---|---|
| Week 1 (V1 ship) | ~40% | 40% × 90% + 60% × 55% = **69%** |
| Month 3 | ~60% | 60% × 90% + 40% × 55% = **76%** |
| Year 1 | ~80% | 80% × 90% + 20% × 55% = **83%** |

---

## 10. Integration with existing pipeline

### Orchestrator change (one branch, `handleData` method)

```
handleData(input, history, schemaSummary, ...) {
  if (grammarEnabled && registry.isReady()) {
    const result = tryGrammarPath(input, history, registry);
    if (result.ok) {
      yield* executeAndStream(result.sql, ...);
      return;
    }
    emitSSE({type: "grammar_fallback", reason: result.reason});
    logMiss(input.question, result.reason);
  }
  // fallback: today's code unchanged
  yield* existingLLMPath(input, history, schemaSummary, ...);
}
```

### Unchanged

- SSE protocol: adds two new event types (`grammar_matched`, `grammar_fallback`) but doesn't modify existing ones.
- `validateSql()` still runs on everything.
- Code/navigation/guidance/greeting paths untouched. Grammar only affects `data` and `data_with_code`.
- Fallback SQL path is byte-identical to today.
- `AgentConfig` shape unchanged. New optional `config.grammar = { enabled: boolean }`, defaulting to `true`.

### Backward compatibility

- Zero-config users get grammar automatically (with whatever registry their schema + data profiler produces).
- `config.grammar.enabled = false` → disables grammar entirely. Escape hatch for emergency rollback.
- Every existing test must still pass with grammar enabled. A broken test = inadvertent touch of the fallback path.

---

## 11. Testing

### Unit tests (fast, pure, no DB, no live LLM)

- `grammar/registry.test.ts` — construction, validation, alias resolution.
- `grammar/template-compiler.test.ts` — every primitive × modifier combination. Edge cases (type mismatches, missing fields, invalid compositions).
- `grammar/intent-extractor.test.ts` — JSON parsing, malformed input, confidence thresholding. **LLM mocked.**
- `grammar/introspectors/django.test.ts` — Python AST parser fixtures.
- `sql_chatbot/services/registry_builder_spec.rb` — in-memory SQLite AR models.

Target: **~100 new unit tests**, all fast (<2s total).

### Integration tests (real PG, mocked LLM)

- End-to-end: fixture DB with known data → registry build → intent extraction (mocked) → compile → execute → assert result.
- Both npm and Rails pipelines.

Target: **~40 new integration tests**.

### Live LLM regression tests (on-demand)

- `packages/agent/src/__tests__/grammar-regression.test.ts`, skipped by default, enabled with `RUN_LIVE_LLM_TESTS=1`.
- 30-50 realistic questions with expected grammar hit/miss + SQL shape.
- Covers the 4 tested apps.
- Measures: hit rate, accuracy on hits, fallback rate, latency.
- Not in CI. Run before cutting releases.

### 120-question realistic replay

Reuse the same 120 questions validated at 55% today. Target ≥ 65% (V1 minimum, 69% aspirational).

### Specific guarantees

- **Zero regression.** All existing tests pass with grammar enabled.
- **Grammar-disabled parity.** `config.grammar.enabled = false` produces bit-identical output on a 20-question fixture.
- **Registry mismatch handling.** Test: server starts, migration adds column, manifest not regenerated → warning logged, no crash, LLM path used for affected entity.

---

## 12. Acceptance criteria (done state on branch)

Before work on `feature/compositional-grammar` is considered complete:

1. All existing tests pass (287 npm + 350 Rails = 637 baseline).
2. New unit tests all pass (target ~100).
3. Integration tests all pass (target ~40).
4. 120-question replay: ≥ 65% accuracy (min), target 69%+.
5. Grammar hit rate on 120-question set: ≥ 35%.
6. Grammar-disabled regression fixture: bit-identical output vs. today.
7. No new runtime dependency on the production npm server (Python is dev/CI only).
8. `docs/grammar/README.md` up to date, decision log complete.

Branch stays independent. No merge steps — branch is the deliverable state.

---

## 13. Implementation phasing

V1 breaks into 4 phases (finer plan produced by writing-plans skill next):

| Phase | Work | Est. duration |
|---|---|---|
| **P1. Registry foundation** | Shared Registry interface. Rails `RegistryBuilder` (AR models → Registry). npm Django AST parser + CLI `introspect` subcommand. Manifest load. | ~1 week |
| **P2. Template compiler** | 7 primitives + 8 modifiers. Deterministic SQL generation. Full unit coverage. | ~3-4 days |
| **P3. Intent extractor** | LLM call, entity candidate pre-selection, JSON parsing, confidence gating. Mocked tests + live regression fixtures. | ~3 days |
| **P4. Orchestrator integration** | Wire grammar path into `handleData`. SSE events. Miss logging. Grammar-disabled mode. 120-question replay. | ~3-4 days |

Total V1: **2-3 weeks** as stated by user upfront.

---

## 14. Rejected alternatives

Captured here so future-us doesn't re-litigate:

- **Flat pattern list (15-70 hand-crafted patterns)** — Memory explicitly rejects. Doesn't handle human phrasings, doesn't scale.
- **Rule-based intent matcher before LLM** — Pattern-explosion risk. Deferred to post-V1 optimization if telemetry shows benefit.
- **Pure LLM with structured output (skip grammar entirely)** — Just structured prompting on top of today. Marginal token savings. Misses the architectural leverage.
- **Runtime Django introspection (Python on production)** — Rejected: adds deploy complexity, startup latency, runtime dep. Build-time manifest covers it.
- **Auto-learned templates from LLM SQL (Vanna-style)** — Bakes errors permanently. Market-verified failure mode (Vanna archived March 2026).
- **Cross-session result cache keyed by question hash** — Masks wrong answers; one user gets wrong answer, next user gets it faster.

---

## 15. Open items (resolved during plan writing)

- `method_source` vs. `parser` gem for Ruby scope extraction — decision at plan-writing time based on fidelity vs. dependency weight.
- Exact gpt-5-mini-equivalent model identifier per provider (OpenRouter, Groq, Ollama, OpenAI) — config wiring in P3.
- Entity candidate pre-selection algorithm: pure string match vs. light fuzzy (Levenshtein). Pick simplest that passes tests.

---

**End of spec.** Implementation plan produced next by writing-plans skill.
