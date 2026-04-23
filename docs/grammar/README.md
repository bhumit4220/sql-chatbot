# Compositional Grammar — Master Index

> **SINGLE SOURCE OF TRUTH for this workstream.** Any session that touches grammar work must read this first and update it before ending.

---

## Status

| Field | Value |
|---|---|
| **Current phase** | **P1 Registry Foundation COMPLETE.** Starting P2 Template Compiler. |
| **Branch** | `feature/compositional-grammar` (independent — never merged back) |
| **Last updated** | 2026-04-23 (end of P1) |
| **Updated by** | session 2026-04-23 |
| **Tests** | 303 npm + 359 Rails = 662 total passing (287+16 npm new, 350+9 Rails new) |

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
- [ ] **P2. Template compiler** (~3-4 days)
  - [ ] 7 primitives
  - [ ] 8 modifiers
  - [ ] Full unit tests
- [ ] **P3. Intent extractor** (~3 days)
  - [ ] Entity candidate pre-selection
  - [ ] LLM call + JSON parse
  - [ ] Confidence gating + miss logging
- [ ] **P4. Orchestrator integration** (~3-4 days)
  - [ ] `handleData` branch
  - [ ] SSE events (`grammar_matched`, `grammar_fallback`)
  - [ ] `config.grammar.enabled` toggle
  - [ ] 120-question replay

### Acceptance criteria (from spec §12)
- [ ] All existing tests pass (287 npm + 350 Rails = 637 baseline)
- [ ] New unit tests pass (~100)
- [ ] Integration tests pass (~40)
- [ ] 120-question replay: ≥ 65% accuracy (target 69%+)
- [ ] Grammar hit rate on 120-question set: ≥ 35%
- [ ] Grammar-disabled regression fixture: bit-identical output
- [ ] No new runtime dependency on production npm server
- [ ] This file and decision log up to date

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
