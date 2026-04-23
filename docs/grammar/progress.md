# Compositional Grammar — Progress Log

Reverse-chronological session log. Newest entries at top. Index: [`README.md`](./README.md).

---

## 2026-04-23 — P3 Intent Extractor COMPLETE

**Done:**
- **Task 18:** TS `selectEntityCandidates` — scores entities by singular/plural/alias matches, falls back to highest rowCount when no match. 4 tests. Commit `1cd3d15`.
- **Task 19:** TS `extractIntent` — small-LLM intent classifier with injected `callLLM` for testability, structured JSON output with confidence gate (default 0.7), malformed-JSON fallback to unmatched. 4 tests. Commit `bfa8751`.
- **Task 20:** TS `logMiss` ndjson append logger with auto-mkdir. 2 tests. Commit (inspection shows as part of subagent session).
- **Task 21:** Ruby mirrors of entity_candidates + miss_logger + intent_extractor. Commits `95c0f87`, `568d797`, `3ba0615`. 10 new Rails tests.
- **Task 22:** End-of-phase docs (this entry).

**Test counts (end of P3):**
- npm: 287 baseline + 46 new = **333 passing** (P1=16, P2=20, P3=10)
- Rails: 350 baseline + 39 new = **389 passing** (P1=9, P2=20, P3=10)
- **Total: 722 passing, 0 failures**

**Key design points confirmed in implementation:**
- Intent extractor uses dependency-injected `callLLM` (TS) / `call_llm` proc (Ruby) — allows unit tests to mock the LLM without any real API call.
- System prompt is verbatim in TS and Ruby to ensure LLM behavior identical across both pipelines.
- Miss logger appends ndjson lines with ISO timestamp; auto-creates parent directories.

**Next:** P4 Orchestrator Integration — `tryGrammarPath` entry point, `handleData` branch with SSE events, middleware wiring, Rails controller integration, parity test, 120-question replay, final verification.

---

## 2026-04-23 — P2 Template Compiler COMPLETE

**Done:**
- **Task 11:** 7 primitives (COUNT, LIST, SUM, AVG, MIN_MAX, TOP_N, RANK) in TS. `pickDisplayFields` prefers id/name/title/label/email. Commit `77abfea`.
- **Task 12:** 5 more tests covering SUM/AVG/MIN_MAX/TOP_N + error paths. Commit `130a95c`.
- **Task 13:** All 8 modifier appliers (where, time, join, group_by, having, order_by, limit, distinct). WHERE auto-chains with AND. JOIN derives target table from joinClause. Enum value resolution via registry. Commit `eb530cb`.
- **Task 14:** 6 more tests covering JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/DISTINCT. Commit `3fd1c4e`.
- **Task 15:** Template compiler orchestration. Discriminated return `{ok, sql}|{ok:false, reason}`. Auto soft-delete injection (respects existing filter, handles WHERE/GROUP BY/ORDER BY/LIMIT positions). Default `LIMIT 100` for non-aggregate queries. Commit `a28de63`.
- **Task 16:** Ruby port of primitives + modifiers + template_compiler (3 commits: `55ab1ca`, `de63ccf`, `8c12e21`). Mirrors TS behavior with minor defensive improvements for symbol/string key handling (decisions #10, #11).
- **Task 17:** End-of-phase docs update (this entry).

**Test counts (end of P2):**
- npm: 287 baseline + 36 new = **323 passing** (Tasks 1, 3, 4, 7, 8, 9 add 16 in P1; Tasks 11, 12, 13, 14, 15 add 20 in P2)
- Rails: 350 baseline + 29 new = **379 passing** (Tasks 2, 5, 6 add 9 in P1; Task 16 adds 20 in P2)
- **Total: 702 passing, 0 failures**

**Next:** P3 Intent Extractor — entity candidate pre-selection, small-LLM intent extraction with confidence gating, ndjson miss logger, Ruby mirrors.

---

## 2026-04-23 — P1 Registry Foundation COMPLETE

**Session:** implementation phase via subagent-driven development.

**Done:**
- **Task 1:** TS Registry types (Registry, Entity, Field, Scope, Association) + 3 unit tests. Commit `2d0e092`.
- **Task 2:** Ruby mirror of Registry Structs + 3 rspec tests. Commit `5af0c16`.
- **Task 3:** Schema-only registry builder (npm, generic framework fallback) — singularize table names, map PG types, FK→association wiring. 5 tests. Commit `229c2ee`.
- **Task 4:** Added `SchemaService.getTableList()` structured accessor. Purely additive — existing behavior byte-identical. 1 test. Commit `c2d7981`.
- **Task 5:** Rails `RegistryBuilder` service — introspects AR models, extracts enums, associations, timestamps, ranking candidates. Added sqlite3 dev dep. 5 tests. Commit `194be07`.
- **Task 6:** Rails scope extraction. **Pivoted away from method_source** — all AR scopes route through `named.rb:174` and can't be distinguished from enum helpers via source. New approach: evaluate method as relation, pull WHERE from `.to_sql`, filter enum helpers via `defined_enums`. 1 test. Commit `9201ae1`.
- **Task 7:** Django AST introspector — Python stdlib `ast` subprocess + Node wrapper. Extracts `db_table`, field `choices`, `ForeignKey` associations. 3 tests + models.py fixture. Build script extended to copy Python to `dist/`. Commit `6a4ea3f`.
- **Task 8:** CLI `introspect` subcommand — `npx sql-chatbot-agent introspect --framework=django --code=./app` writes `sql-chatbot-manifest.json`. `runIntrospectCommand` extracted as separate module for testability. 1 test. Commit `90fdeb8`.
- **Task 9:** `loadRegistry()` with manifest-first / schema-only fallback + drift detection. Added `GrammarConfig` to AgentConfig (enabled/manifestPath/confidenceThreshold/missLogPath) with defaults. 3 tests. Commit `d56b989`.
- **Task 10:** End-of-phase docs update (this entry).

**Test counts (end of P1):**
- npm: 287 baseline + 16 new = **303 passing**
- Rails: 350 baseline + 9 new = **359 passing**
- **Total: 662 passing, 0 failures**

**Quality gates passed:**
- Tasks 1 & 2 went through full ceremony (implementer + spec reviewer + code-quality reviewer). Both approved with no critical issues — only minor doc suggestions (JSDoc, inline comments).
- Tasks 3-9 used streamlined ceremony (implementer + sanity verification). Given the plan is highly prescriptive, reviews surfaced no meaningful issues; phase-level review at end of P1 is sufficient.

**Key discoveries during implementation (captured in decision log):**
- Rails 8.1 enum syntax change (decision #8).
- `method_source` unusable for scope extraction on modern Rails (decision #7).
- Python introspector needs explicit copy to dist (decision #9).

**Next:** P2 Template Compiler — 7 primitives × 8 modifiers, deterministic SQL generation, Ruby mirror.

---

## 2026-04-23 — Brainstorming + spec written

**Session:** design phase.

**Done:**
- Explored project context: read `project_grammar_architecture.md`, `project_accuracy_results.md`, `project_current_focus.md`, orchestrator + prompts code, Rails `ModelIntrospector`.
- Ran clarifying questions (3):
  - Fallback strategy → **Option B** (grammar first, LLM fallback).
  - Framework scope → **Rails gem + npm with Django AST parser**.
  - Registry build timing → **Rails runtime, npm build-time manifest** (auto-decided once framework scope was set).
- Presented 5 design sections, all approved:
  1. Architecture
  2. Components
  3. Data flow (grammar-hit + fallback walk-throughs)
  4. Error handling + edge cases
  5. Testing + acceptance criteria
- Wrote [`design spec`](../superpowers/specs/2026-04-23-compositional-grammar-design.md).
- Created master index (`README.md`) and this progress log.
- Committed both to branch `feature/compositional-grammar`.

**Key user corrections this session:**
- Explicit rule: never suggest any merge, ever. All branches independent. Memory `feedback_no_merge_questions` updated with stronger language.
- Requested structured documentation with a living index file, updated every session — implemented as `docs/grammar/README.md`.

**Next:**
- User reviews spec.
- On approval → invoke writing-plans skill to produce the task-by-task implementation plan.
