# V1 Session Resume Prompt

Copy everything below the line and paste it as your first message in a new session.

---

Read docs/plans/2026-02-27-v1-release-design.md for the full V1 design and implementation plan.

**What this project is:**
This is a GENERIC, REUSABLE AI chatbot product — NOT app-specific. The chatbot works with ANY web app that has a PostgreSQL database. Everything is auto-discovered (schema, code, routes) — NEVER hardcode app-specific things.

**What we're building on this branch:**
An npm package (`@sql-chatbot/agent`) — Express middleware that customers install in their JS app. It:
- Discovers their PostgreSQL schema at boot
- Indexes their code (frontend + backend, multiple `codePaths`)
- Detects routes from code (React Router, Next.js file routing, Express routes, Rails routes.rb)
- Executes SQL queries (read-only, validated)
- Streams answers via an embedded chat widget (Shadow DOM, IIFE bundle)
- Uses Groq free tier as LLM (llama-3.3-70b-versatile, 14,400 req/day free, OpenAI-compatible API)

**Current branch:** v1-development (created from master)
**GitHub:** https://github.com/bhumit4220/sql-chatbot, account: bhumit4220

**What exists already (from V3, on v3-development branch — to copy/adapt):**
- LLM client: `packages/cloud/src/llm/openai.ts` — OpenAI SDK wrapper with `callOpenAI()` and `streamOpenAI()`
- Prompts: `packages/cloud/src/prompts/classify.ts`, `generate-sql.ts`, `answer.ts` — battle-tested prompts for all 5 question types
- Widget: `widget/` — React IIFE bundle with Shadow DOM, extracts page navigation links, streams SSE responses
- Tests: `packages/cloud/src/__tests__/` — unit tests for prompts + integration test for server

**What needs to be built (6 phases in the plan):**
1. **Phase 1:** Project scaffold + LLM client (adapt V3's to point at Groq) + copy prompts
2. **Phase 2:** Schema discovery — PostgreSQL introspection via `information_schema` + `pg_constraint`
3. **Phase 3:** Code indexer + route detection — scan files, detect React Router/Next.js/Express/Rails routes, keyword search
4. **Phase 4:** SQL executor — validate (block dangerous SQL) + execute in READ ONLY transaction
5. **Phase 5:** Ask orchestrator — classify → route to data/code/navigation/unsafe → stream answer
6. **Phase 6:** Express middleware wrapper + widget adaptation (V3 widget calls 3 endpoints, V1 calls 1: `/api/ask`) + E2E test

**Key architecture decisions:**
- Agent is Express middleware (not standalone server) — deploys WITH the customer's app, always has code + DB access
- `codePaths` accepts multiple directories — scans frontend + backend codebases together
- Navigation comes from TWO sources: widget scrapes current page DOM + code indexer detects all routes at boot
- LLM is provider-agnostic: defaults to Groq free tier, switchable via `LLM_BASE_URL` env var
- No RAG/pgvector — simple keyword search for code, PostgreSQL introspection for schema
- No auth — single-tenant middleware, host app handles auth
- PostgreSQL only for V1

**File structure being created:**
```
packages/agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public API: exports sqlChatbot()
│   ├── middleware.ts          # Express middleware factory
│   ├── config.ts             # Config validation
│   ├── llm/client.ts         # LLM client (OpenAI SDK → Groq)
│   ├── prompts/              # classify.ts, generate-sql.ts, answer.ts
│   ├── services/
│   │   ├── schema.ts         # Schema discovery
│   │   ├── code-indexer.ts   # Code scanner + route detection
│   │   ├── sql-executor.ts   # SQL validation + execution
│   │   └── orchestrator.ts   # Ask pipeline
│   └── __tests__/
└── widget/widget.js           # Pre-built IIFE bundle
```

**Task:** Execute the V1 implementation plan phase by phase. Use the superpowers:subagent-driven-development skill. Start from Phase 1 (or wherever we left off — check git log for progress). Follow TDD: write failing tests first, then implement, then commit.

**Also read these for context:**
- docs/plans/2026-02-26-llm-provider-architecture-design.md — LLM provider research and architecture
- docs/research/2026-02-27-llm-provider-research.md — model benchmarks and Groq recommendation
