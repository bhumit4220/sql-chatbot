# V1 Release — Design & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a working V1 chatbot that answers data questions (SQL), explains business logic (from code), and provides navigation links — for any web app with a PostgreSQL database.

**Architecture:** An npm package (`@sql-chatbot/agent`) that the customer installs as Express middleware in their JS app. It discovers their database schema, indexes their code (frontend + backend), executes SQL, and streams answers via a chat widget. Uses Groq free tier for LLM (zero cost).

**Tech Stack:** Node.js, TypeScript, Express middleware, OpenAI SDK (pointing at Groq), PostgreSQL (pg), React widget (IIFE bundle with Shadow DOM)

---

## Architecture

```
Customer's JS App (Express / Next / Nest)
│
│  const { sqlChatbot } = require('@sql-chatbot/agent')
│  app.use('/chatbot', sqlChatbot({
│    databaseUrl: process.env.DATABASE_URL,
│    codePaths: ['./backend/src', './frontend/src'],  ← scans both codebases
│  }))
│
│  Their frontend HTML:
│  <script src="http://localhost:4000/chatbot/widget.js"></script>
│
├── /chatbot/widget.js     → serves the chat widget
├── /chatbot/api/ask       → full pipeline: classify → SQL/code → stream answer
├── /chatbot/api/health    → status check
└── /chatbot/api/refresh   → re-discover schema + re-index code

         │
         │ LLM calls (classify, generate-sql, answer)
         ▼
   Groq Free Tier (llama-3.3-70b-versatile)
   https://api.groq.com/openai/v1
```

**Why middleware, not standalone:**
- Agent deploys WITH the customer's app → always has access to code + database
- Works everywhere the app works (VPS, Docker, Heroku, any cloud)
- No separate process to manage
- Code is always on the same disk because they're in the same deployment

**How it handles separate frontend + backend codebases:**
- `codePaths` accepts multiple directories: `['./backend/src', '../frontend/src']`
- Both dirs must be accessible from where the app runs
- For monorepos: just one path. For separate repos on same machine: multiple paths.
- Agent scans ALL paths and builds one unified code index

**Navigation: two sources combined**

| Source | What It Provides | How |
|--------|-----------------|-----|
| **Widget (runtime)** | Current page links — sidebar, nav, menu, breadcrumbs | Scrapes DOM live on every page the admin visits |
| **Code indexer (boot time)** | ALL routes in the app — including pages admin hasn't visited | Scans route files: React Router, Next.js file routing, Express routes |

Both get sent to the LLM. Widget provides "what's on this page right now." Code indexer provides "every page that exists in the app."

---

## V1 Capabilities

### 1. Data Questions (SQL)
```
User: "How many active customers?"
→ Agent sends schema to LLM → LLM generates SQL → Agent executes → LLM streams answer
→ "You have 1,250 active customers."
```

### 2. Code Explanation
```
User: "How is net_sales calculated?"
→ Agent searches code index for "net_sales" → finds relevant file/function
→ Sends code snippet to LLM → LLM explains in plain language
→ "Net sales is calculated by subtracting discounts and refunds from total revenue."
```

### 3. Navigation Links
```
User: "Where can I see user details?"
→ Code indexer knows: Route /admin/users/:id → UserDetail component
→ Widget knows: current page has "Users" link at /admin/users
→ LLM combines: "Go to Users (/admin/users) in the sidebar, then click on a user to see their details."
```

---

## What We Reuse vs Build

| Component | Source | Action |
|-----------|--------|--------|
| LLM client | V3 `packages/cloud/src/llm/openai.ts` | Copy, configure for Groq |
| Prompts (classify, generate-sql, answer) | V3 `packages/cloud/src/prompts/` | Copy as-is |
| Widget (React IIFE bundle) | V3 `widget/` | Copy, update to use single `/api/ask` endpoint |
| Schema discovery | **Build new** | Query PostgreSQL `information_schema` |
| Code indexer + route detection | **Build new** | Scan files, detect routes, keyword search |
| SQL executor + validator | **Build new** | `pg` with read-only transactions |
| Ask orchestrator | **Build new** | classify → route → SQL or code search → answer |
| Express middleware + routes | **Build new** | Middleware wrapper combining everything |

---

## Customer Setup (End Result)

```bash
# 1. Install in their project
npm install @sql-chatbot/agent

# 2. Add to their Express/Next/Nest app (2 lines)
const { sqlChatbot } = require('@sql-chatbot/agent');
app.use('/chatbot', sqlChatbot({
  databaseUrl: process.env.DATABASE_URL,
  codePaths: ['./src'],                    // or ['./backend/src', './frontend/src']
  groqApiKey: process.env.GROQ_API_KEY,    // free from groq.com
}));

# 3. Add widget to their HTML (1 line)
# <script src="http://localhost:3000/chatbot/widget.js"></script>

# Done. Chat widget appears, start asking questions.
```

---

## File Structure

```
packages/agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public API: exports sqlChatbot() middleware
│   ├── middleware.ts          # Express middleware factory
│   ├── config.ts             # Config validation
│   ├── llm/
│   │   └── client.ts         # LLM client (OpenAI SDK → Groq)
│   ├── prompts/
│   │   ├── classify.ts       # Classification prompt
│   │   ├── generate-sql.ts   # SQL generation prompt
│   │   └── answer.ts         # Answer streaming prompt
│   ├── services/
│   │   ├── schema.ts         # Schema discovery (PostgreSQL introspection)
│   │   ├── code-indexer.ts   # Code scanner + route detection + keyword search
│   │   ├── sql-executor.ts   # SQL validation + read-only execution
│   │   └── orchestrator.ts   # Ask pipeline: classify → route → answer
│   └── __tests__/
│       ├── schema.test.ts
│       ├── code-indexer.test.ts
│       ├── sql-executor.test.ts
│       └── orchestrator.test.ts
└── widget/
    └── widget.js              # Pre-built IIFE bundle from V3
```

---

## LLM Configuration

```bash
# Groq free tier (default for V1)
# 14,400 requests/day, no credit card needed
GROQ_API_KEY=gsk-your-groq-key

# Or use any OpenAI-compatible provider:
# LLM_BASE_URL=http://localhost:8080/v1    # llama.cpp local
# LLM_API_KEY=not-needed
# LLM_MODEL=qwen3-4b
```

---

## Phase-Wise Implementation Plan

### Phase 1: Project Scaffold + LLM Client + Prompts

**Goal:** Project structure, LLM talking to Groq, prompts ready.

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/src/config.ts`
- Create: `packages/agent/src/llm/client.ts` (adapted from V3)
- Copy: `packages/agent/src/prompts/classify.ts` (from V3)
- Copy: `packages/agent/src/prompts/generate-sql.ts` (from V3)
- Copy: `packages/agent/src/prompts/answer.ts` (from V3)

**Config (`config.ts`):**
```typescript
export interface AgentConfig {
  databaseUrl: string;
  codePaths: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export function resolveConfig(userConfig: Partial<AgentConfig>): AgentConfig {
  const llmApiKey = userConfig.llmApiKey || process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
  if (!llmApiKey) throw new Error('GROQ_API_KEY or LLM_API_KEY is required');
  if (!userConfig.databaseUrl) throw new Error('databaseUrl is required');

  return {
    databaseUrl: userConfig.databaseUrl,
    codePaths: userConfig.codePaths || ['./src'],
    llmBaseUrl: userConfig.llmBaseUrl || process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    llmApiKey,
    llmModel: userConfig.llmModel || process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
  };
}
```

**LLM Client (`llm/client.ts`):**
```typescript
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

let client: OpenAI;
let defaultModel: string;

export function initLLM(baseUrl: string, apiKey: string, model: string) {
  client = new OpenAI({ apiKey, baseURL: baseUrl });
  defaultModel = model;
}

interface CallOptions {
  jsonMode?: boolean;
  temperature?: number;
  model?: string;
}

export async function callLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): Promise<string> {
  const response = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
  });
  return response.choices[0]?.message?.content || '';
}

export async function* streamLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): AsyncGenerator<string> {
  const stream = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: true,
  });
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
```

**Steps:**
1. Create `packages/agent/` directory with `package.json`, `tsconfig.json`
2. Create `config.ts` with validation
3. Create `llm/client.ts` adapted from V3 (pass config explicitly, not from env)
4. Copy V3 prompts: `classify.ts`, `generate-sql.ts`, `answer.ts`
5. `npm install` to pull dependencies
6. Commit: `feat: scaffold agent package with LLM client and prompts`

---

### Phase 2: Schema Discovery

**Goal:** Inspect the customer's PostgreSQL database and build a schema summary for the LLM.

**Files:**
- Create: `packages/agent/src/services/schema.ts`
- Create: `packages/agent/src/__tests__/schema.test.ts`

**What it does:**
- Connects to PostgreSQL using `pg`
- Queries `information_schema.tables` + `information_schema.columns`
- Queries foreign keys from `pg_constraint` + `pg_attribute`
- Filters out sensitive columns (password, token, secret, ssn, encrypted, etc.)
- Builds a text summary:
  ```
  TABLE customers (id INT PK, name TEXT, email TEXT, status INT, created_at TIMESTAMP)
  TABLE jobs (id INT PK, customer_id INT FK→customers.id, title TEXT, total DECIMAL)
  ```
- Caches in memory, re-discovers on `/api/refresh`

**Steps:**
1. Write failing test (mock pg client, verify output format, verify sensitive column filtering)
2. Implement `discoverSchema()` function
3. Run test — verify pass
4. Commit: `feat: schema discovery via PostgreSQL introspection`

---

### Phase 3: Code Indexer + Route Detection

**Goal:** Scan the customer's codebase (frontend + backend), detect routes, build searchable index.

**Files:**
- Create: `packages/agent/src/services/code-indexer.ts`
- Create: `packages/agent/src/__tests__/code-indexer.test.ts`

**What it does:**

**File scanning:**
- Recursively scans all directories in `codePaths`
- Reads: `.js`, `.ts`, `.jsx`, `.tsx`, `.rb`, `.py`, `.erb`, `.vue` files
- Skips: `node_modules`, `.git`, `dist`, `build`, `vendor`, `tmp`, `__pycache__`
- Caps at 2000 files (warns if exceeded)
- For each file: stores path + content in memory

**Route detection (framework-aware):**
- **React Router:** scans for `<Route path="..." />`, `path:` in route configs
- **Next.js:** reads `pages/` or `app/` directory structure → file paths = routes
- **Express:** scans for `app.get()`, `router.get()`, `app.post()`, etc.
- **Rails:** scans `routes.rb` for `resources`, `get`, `post`, `root`
- Builds a route registry: `[{ method: 'GET', path: '/admin/users/:id', file: 'src/pages/UserDetail.tsx' }]`

**Search:**
- Keyword matching: given search terms, find files/functions that match
- Returns: matching code snippets with file path and ±10 lines surrounding context

**Steps:**
1. Write failing test (temp directory with sample files: Express routes, React routes, plain code)
2. Implement `CodeIndexer` class with `index()`, `search()`, `getRoutes()` methods
3. Run test — verify pass
4. Commit: `feat: code indexer with route detection and keyword search`

---

### Phase 4: SQL Executor

**Goal:** Execute LLM-generated SQL safely against the customer's database.

**Files:**
- Create: `packages/agent/src/services/sql-executor.ts`
- Create: `packages/agent/src/__tests__/sql-executor.test.ts`

**Validation (defense-in-depth):**
1. Must be a single SELECT statement (reject multiple statements via `;`)
2. Keyword blocklist: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT, TRUNCATE, EXECUTE
3. Function blocklist: pg_read_file, dblink, pg_terminate_backend, lo_import, etc.
4. System catalog blocklist: pg_shadow, pg_roles, pg_authid, information_schema (read-only access)
5. Auto-adds `LIMIT 500` if missing

**Execution:**
- Runs inside `SET TRANSACTION READ ONLY`
- 10-second timeout
- Returns: `{ columns: string[], rows: Record<string, any>[], rowCount: number }`

**Steps:**
1. Write failing test (test blocked patterns, allowed patterns, LIMIT injection, timeout)
2. Implement `validateSql()` and `executeSql()` functions
3. Run test — verify pass
4. Commit: `feat: SQL executor with validation and read-only enforcement`

---

### Phase 5: Ask Orchestrator

**Goal:** Wire everything together — classify, route, answer.

**Files:**
- Create: `packages/agent/src/services/orchestrator.ts`
- Create: `packages/agent/src/__tests__/orchestrator.test.ts`

**Pipeline:**

```
Question + pageContext (from widget) + routes (from code indexer)
        │
        ▼
   ┌─────────┐
   │ Classify │ → data | data_with_code | code | navigation | guidance | unsafe
   └─────────┘
        │
        ├── data:
        │     Schema → LLM generates SQL → validate → execute → LLM streams answer
        │
        ├── data_with_code:
        │     Schema + code search → LLM generates SQL → validate → execute → LLM streams answer
        │
        ├── code:
        │     Code search (searchTerms) → send snippets → LLM streams explanation
        │
        ├── navigation / guidance:
        │     Page context (widget links) + route registry (from code) → LLM streams guidance
        │
        └── unsafe:
              Return blocked message immediately (no LLM call)
```

**Steps:**
1. Write failing test (mock all services, test each question type routing)
2. Implement `handleQuestion()` async generator that yields SSE events
3. Run test — verify pass
4. Commit: `feat: ask orchestrator with classify-route-answer pipeline`

---

### Phase 6: Express Middleware + Widget + E2E

**Goal:** Package everything as Express middleware, serve widget, test end-to-end.

**Files:**
- Create: `packages/agent/src/middleware.ts`
- Create: `packages/agent/src/index.ts`
- Copy + modify: `packages/agent/widget/widget.js` (from V3)

**Middleware factory (`index.ts`):**
```typescript
import { sqlChatbot } from './middleware.js';
export { sqlChatbot };
export type { AgentConfig } from './config.js';
```

**Middleware (`middleware.ts`):**
```typescript
import express from 'express';

export function sqlChatbot(userConfig) {
  const router = express.Router();
  const config = resolveConfig(userConfig);

  // Init on first request (or eagerly in background)
  let initialized = false;
  async function ensureInit() {
    if (initialized) return;
    initLLM(config.llmBaseUrl, config.llmApiKey, config.llmModel);
    await schemaService.discover(config.databaseUrl);
    await codeIndexer.index(config.codePaths);
    initialized = true;
  }

  router.get('/widget.js', (req, res) => {
    res.sendFile(path.join(__dirname, '../widget/widget.js'));
  });

  router.get('/api/health', async (req, res) => {
    await ensureInit();
    res.json({ status: 'ok', tables: schemaService.tableCount(), codeFiles: codeIndexer.fileCount() });
  });

  router.post('/api/ask', async (req, res) => {
    await ensureInit();
    // SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for await (const event of orchestrator.handleQuestion(req.body)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write('data: {"type":"done"}\n\n');
    res.end();
  });

  router.post('/api/refresh', async (req, res) => {
    await schemaService.discover(config.databaseUrl);
    await codeIndexer.index(config.codePaths);
    res.json({ status: 'refreshed' });
  });

  return router;
}
```

**Widget changes:**
- V3 widget calls 3 separate endpoints (classify, generate-sql, answer)
- V1 widget calls ONE endpoint: `POST /chatbot/api/ask`
- Widget sends question + pageContext + history
- Receives SSE stream with typed events (classifying, classified, sql, token, done)

**Steps:**
1. Create `middleware.ts` with Express router factory
2. Create `index.ts` that exports `sqlChatbot`
3. Copy V3 widget, modify to call single `/api/ask` endpoint
4. Build widget bundle with Vite
5. Manual E2E test: create a tiny Express app, install the middleware, embed widget, ask questions
6. Commit: `feat: Express middleware with widget serving and SSE streaming`

---

## What V1 Does NOT Include (Deferred)

| Feature | Why Deferred |
|---------|-------------|
| Auth / API key management | V1 is single-tenant middleware. Auth is the host app's job. |
| Knowledge base | Code indexer + schema discovery covers V1 needs. |
| RAG / pgvector embeddings | Simple keyword search is sufficient for V1. |
| Enum discovery / data sampling | LLM handles enums via prompt instructions for now. |
| Multi-tenant cloud hosting | V1 is embedded middleware. Cloud hosting is V2. |
| MySQL / SQLite support | PostgreSQL only for V1. |
| Non-JS frameworks | Agent is Express middleware for V1. Rails gem / Django package are V2. |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Groq free tier rate limits (14,400 req/day) | Enough for V1. Log a clear error when limit hit. |
| Groq free tier disappears | Any OpenAI-compatible provider works. Change one env var. |
| Code indexer slow on large codebases | Cap at 2000 files, skip binaries/images. Warn if exceeded. |
| Route detection misses framework patterns | Falls back to widget-scraped links. Route detection improves over time. |
| PostgreSQL only | Document clearly. MySQL/SQLite are V2 features. |
| Widget CSS conflicts | Shadow DOM isolation (V3 widget already handles this). |
| LLM generates bad SQL | SQL validator blocks dangerous queries. READ ONLY transaction prevents writes. |
| Frontend code not accessible | `codePaths` supports multiple dirs. If truly separate deployment, widget scraping is the fallback for navigation. |
