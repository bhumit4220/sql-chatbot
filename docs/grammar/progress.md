# Compositional Grammar — Progress Log

Reverse-chronological session log. Newest entries at top. Index: [`README.md`](./README.md).

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
