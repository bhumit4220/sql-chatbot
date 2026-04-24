# Compositional Grammar — Master Index

> **SINGLE SOURCE OF TRUTH for this workstream.** Any session that touches grammar work must read this first and update it before ending.

---

## Status

| Field | Value |
|---|---|
| **Current phase** | **LIVE E2E verified on 3 apps across 3 frameworks via Playwright/CDP** — 36 questions, 24 grammar hits = **66.7% hit rate**. Above 35% minimum, approaching 69% stretch target. |
| **Branch** | `feature/compositional-grammar` (independent — never merged back) |
| **Last updated** | 2026-04-24 (cross-framework validation) |
| **Updated by** | session 2026-04-24 |
| **Tests** | 345 npm + 391 Rails = **736 passing**. 5 V1.1 fixes landed: Rails aliasing, TOP_N absorb, fallthrough, Django prefix, order_by default. |
| **Live results by app** | MSP (Rails gem) 75%, Chatwoot (npm schema-only) 67%, Saleor (npm+Django aliases) 58% |

---

## What we're building (1-line)

Replace "LLM generates arbitrary SQL every query" with a compositional grammar (7 primitives + 8 modifiers) auto-derived from schema + code + data. LLM only classifies intent; deterministic code resolves slots and compiles SQL. Target 69%+ accuracy on realistic questions (vs. today's 55%).

---

## Documents

| Doc | Purpose | Path |
|---|---|---|
| Design spec | Architecture, components, decisions | [`docs/superpowers/specs/2026-04-23-compositional-grammar-design.md`](../superpowers/specs/2026-04-23-compositional-grammar-design.md) |
| Implementation plan | Task-by-task breakdown (29 tasks across 4 phases) | [`docs/superpowers/plans/2026-04-23-compositional-grammar-plan.md`](../superpowers/plans/2026-04-23-compositional-grammar-plan.md) |
| Progress log | Session-by-session activity | [`docs/grammar/progress.md`](./progress.md) |

---

## Decision log

Every architecture-affecting decision lands here with date + reason. Do not edit past entries; append new ones.

| # | Date | Decision | Reason |
|---|---|---|---|
| 1 | 2026-04-23 | Grammar first, LLM fallback (not strict grammar, not hybrid) | Never regress vs. today's 55%. Enables incremental coverage rollout. |
| 2 | 2026-04-23 | V1 framework scope: Rails gem + Django via npm AST parser. Other frameworks get schema+data-only registry on npm. | Covers 3 of 4 tested apps. Django is most common non-Rails backend. Other parsers post-V1. |
| 3 | 2026-04-23 | Rails registry built at runtime (extend `ModelIntrospector`). npm registry built at build-time via CLI `sql-chatbot-agent introspect` writing `sql-chatbot-manifest.json`. | No Python dep on production. Deterministic manifest across environments. |
| 4 | 2026-04-23 | Intent extractor uses a small LLM (gpt-5-mini class), not rule-based pattern matcher | Human-phrased questions (typos, casual language) are where pattern matchers fail. LLM extraction is cheap (~$0.0002/call). |
| 5 | 2026-04-23 | No auto-learning from LLM output (no Vanna-style template extraction). Grammar evolves via registry refresh (automatic as app code grows) and manual primitive additions from telemetry review. | Vanna was archived March 2026 for this exact failure mode. Auto-learned templates bake LLM mistakes in permanently. |
| 6 | 2026-04-23 | Branch `feature/compositional-grammar` stays independent. No merge steps in any plan or acceptance criteria. | User preference — see feedback_no_merge_questions memory. |
| 7 | 2026-04-23 | Rails scope extraction does NOT use `method_source` (plan's original approach). Instead, evaluate each singleton method as an AR relation and extract WHERE from `.to_sql`. Filter AR-generated enum helpers (`active?`, `not_active`, `statuses`) via `model.defined_enums`. | `method_source` returns AR's closure wrapper at `named.rb:174` — can't distinguish user scopes from enum helpers via source reading. Discovered during Task 6 implementation. |
| 8 | 2026-04-23 | Rails 8.1 requires positional enum syntax `enum :status, {active: 0}` not `enum status: {...}`. Test fixtures updated. | Rails 8.1 dropped keyword-arg enum form. Plan was written against Rails 7.x. Not a design change — just syntax adaptation. |
| 9 | 2026-04-23 | Build script copies Python introspector to `dist/grammar/introspectors/scripts/django_introspect.py`. `__dirname`-based path resolution works in both src (vitest) and dist (production) contexts. | Python AST script must be present at runtime for the CLI `introspect` subcommand. Not shipped in TS compile output by default. |
| 10 | 2026-04-23 | Ruby Modifiers check `enum_values` with both string and symbol keys (`enum_values[str] || enum_values[sym]`). TS strict-casts to String. | Defensive: Ruby's Hash keys are commonly symbols but Registry from introspection yields strings. Catches both without silent errors. |
| 11 | 2026-04-23 | Ruby TemplateCompiler reads `entity.timestamps` with both string and symbol keys. | Same rationale as #10 — Rails `ModelIntrospector` / `RegistryBuilder` may yield either; avoid fragile coupling. |
| 12 | 2026-04-23 | Rails grammar integration happens at **Orchestrator** (not ChatbotController). Controller delegates entirely to Orchestrator's `handle_question` → `handle_data_with_code`; that's where SSE events are emitted. | Plan originally said "controller integration" — correct integration point proved to be Orchestrator. Less invasive and consistent with npm-side placement. |
| 13 | 2026-04-23 | Grammar activation double-guarded: `grammarConfig.enabled && !!registry`. Even if config says enabled, grammar won't run without a registry. | Defence against misconfiguration — registry load failure silently disables grammar without crashing the process. |
| 14 | 2026-04-23 | 120-question live replay test is scaffolded but the full fixture (120 questions across 4 apps) is not populated. Runs skipped unless `RUN_120_REPLAY=1`. | Requires running Saleor/Chatwoot/Gitea/Redmine DBs + real LLM key — out of scope for this implementation session. Next step: populate fixture during a live testing session. |

---

## Final Code Review (2026-04-23)

Final review of all 36 commits on `feature/compositional-grammar` (SHAs `37affc6..83c5dcf`) ran via the `superpowers:code-reviewer` agent.

**Assessment:** APPROVED with V1.1 follow-up items.

**Critical issues:** None. No data-loss or crash paths. Fallback chain works at every failure mode. LLM-derived input cannot produce SQL injection — registry validates every slot, `validateSql()` runs defense-in-depth.

**Important issues to address before production (V1.1):**

1. **`like` and `in` operators silently fall through to `=`** — both `modifiers.ts` and `modifiers.rb` declare these ops in the type/system prompt but don't map them in `OPS`. LLM may emit them; compiler produces semantically wrong SQL. Not caught by tests (no `like`/`in` coverage). Fix: add `LIKE` and `IN (...)` handling in both languages, or remove the ops from the declared interface.

2. **`grammar_matched` event emitted before validation** (orchestrator.ts:190, orchestrator.rb:437–442). If validation fails, frontend sees inconsistent state. Additionally: TS falls through to LLM on validation failure, Rails emits error — divergent behavior between languages.

3. **SSE event shape divergence**: TS emits `{type: 'grammar_fallback', reason}`; Rails emits `{type: 'grammar_fallback', data: {reason}}`. Consumers must handle both. Standardize on TS shape.

**Minor issues (V1.1):**

4. Intent extractor's `return parsed as Intent` has no runtime validation of `primitive` field. Unknown primitives cause `grammar_exception` in miss log rather than `invalid_primitive:X` — reduces telemetry signal.
5. `registry_builder.rb` uses `Set.new` without `require "set"` (works in Rails via ActiveSupport but inconsistent with `model_introspector.rb`).
6. `GrammarConfig` and `Registry` types not exported from `packages/agent/src/index.ts` — needed for users to type their configuration objects.
7. Rails `try_grammar_path` reads global `SqlChatbot.registry` rather than injected dep — harder to unit-test.
8. Soft-delete WHERE regex differs between TS (` WHERE `) and Ruby (`\bWHERE\b`) — identical output on all fixtures but inconsistent.

**Architectural strengths confirmed:**
- Registry is genuine single contract — introspectors write once, compilers read once, halves never touch.
- Grammar path is cleanly additive — existing LLM pipeline byte-identical when grammar disabled.
- Double-guard (`grammarConfig.enabled && !!registry`) correctly implemented in both languages.
- Zero production runtime Python dep achieved (CLI-only).
- 14 decisions logged with rationale — future maintenance is tractable.

Full review output available in session transcript.

---

## Task checklist

### Brainstorm phase
- [x] Explore project context (memory + current code)
- [x] Clarifying Q1 — fallback strategy → Option B
- [x] Clarifying Q2 — framework scope → Rails + Django
- [x] Clarifying Q3 — registry build timing → Rails runtime, npm manifest (auto-decision)
- [x] Section 1 — architecture
- [x] Section 2 — components
- [x] Section 3 — data flow
- [x] Section 4 — error handling
- [x] Section 5 — testing
- [x] Write design spec doc
- [x] Create master index (this file)
- [x] User reviews spec (approved 2026-04-23)
- [x] Invoke writing-plans skill → plan at `docs/superpowers/plans/2026-04-23-compositional-grammar-plan.md`

### Implementation phases (spec §13) — not started
- [x] **P1. Registry foundation** (~1 week) — **COMPLETE**
  - [x] Shared Registry interface (TS + Ruby) — Tasks 1, 2
  - [x] Schema-only registry builder (generic fallback) — Task 3
  - [x] SchemaService.getTableList() structured accessor — Task 4
  - [x] Rails `RegistryBuilder` service (enums + associations + timestamps + ranking) — Task 5
  - [x] Rails scope extraction (via AR relation evaluation, not method_source) — Task 6
  - [x] npm Django AST parser (Python stdlib subprocess + Node wrapper + fixture) — Task 7
  - [x] CLI `sql-chatbot-agent introspect` subcommand — Task 8
  - [x] Manifest load path + schema-drift detection + grammar config — Task 9
- [x] **P2. Template compiler** (~3-4 days) — **COMPLETE**
  - [x] 7 primitives (TS + Ruby) — Tasks 11, 16a
  - [x] Primitive test coverage (SUM/AVG/MIN_MAX/TOP_N/RANK + error paths) — Task 12
  - [x] 8 modifiers (TS + Ruby) — Tasks 13, 16b
  - [x] Modifier test coverage (JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/DISTINCT) — Task 14
  - [x] Template compiler orchestration with soft-delete auto-injection — Tasks 15, 16c
- [x] **P3. Intent extractor** (~3 days) — **COMPLETE**
  - [x] Entity candidate pre-selection (TS + Ruby) — Tasks 18, 21a
  - [x] LLM intent extractor with confidence gate (TS + Ruby) — Tasks 19, 21c
  - [x] ndjson miss logger (TS + Ruby) — Tasks 20, 21b
- [x] **P4. Orchestrator integration** (~3-4 days) — **COMPLETE**
  - [x] `tryGrammarPath` entry point — Task 23
  - [x] `handleData` grammar-first branch with SSE events (`grammar_matched`, `grammar_fallback`) + miss logging — Task 24
  - [x] Middleware + CLI registry loading wiring — Task 25
  - [x] Rails Orchestrator grammar branch + `GrammarPipeline` service + engine boot registry — Task 26
  - [x] Grammar-disabled parity test (20-question fixture, double-guard verified) — Task 27
  - [x] 120-question replay harness (opt-in, structural tests in CI) — Task 28
  - [x] Final verification + docs — Task 29 (this update)

### Acceptance criteria (from spec §12)
- [x] All existing tests pass (287 npm + 350 Rails = 637 baseline) — **Confirmed: 287+58=345 npm passing +1 skipped, 350+41=391 Rails passing**
- [x] New unit tests pass (~100) — **99 new unit + integration tests added (58 npm + 41 Rails)**
- [x] Integration tests pass — **orchestrator-grammar.test.ts (3), grammar-disabled-parity.test.ts (3), grammar_pipeline_spec.rb (2)**
- [ ] 120-question replay: ≥ 65% accuracy (target 69%+) — **Harness scaffolded (Task 28), skipped by default. Requires manual run with DBs + LLM key. Full fixture needs population.**
- [ ] Grammar hit rate on 120-question set: ≥ 35% — same as above, requires live replay
- [x] Grammar-disabled regression fixture: bit-identical output — **grammar-disabled-parity.test.ts verifies no grammar_matched/grammar_fallback events emitted**
- [x] No new runtime dependency on production npm server — **Python only needed for CLI `introspect` (dev-time); production server runs pure Node**
- [x] This file and decision log up to date

---

## Quick reference

**Grammar primitives (7):** COUNT, LIST, SUM, AVG, MIN_MAX, TOP_N, RANK
**Modifiers (8):** where, time, join, group_by, having, order_by, limit, distinct
**Registry shape:** see spec §6.1
**Fallback trigger points:** intent extractor unmatched / low confidence / registry resolution failure / template compile failure / SQL execution error → fall through to today's pipeline unchanged

---

## How to use this file (for future sessions)

1. **First thing:** read this file completely before touching grammar code.
2. **At decision points:** append a row to the Decision log.
3. **Per task progress:** tick the task checklist.
4. **Before session ends:** update Status block (phase, last-updated, updated-by). Add a dated entry to `progress.md` describing what was done.
5. **Never delete or rewrite past decisions.** If something changes, add a new decision row that supersedes the old one with explicit reasoning.
