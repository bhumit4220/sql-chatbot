# SQL Chatbot V3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a middleware-agent-based SQL chatbot: Chrome Extension talks to a Rails gem (mounted in customer's app) which orchestrates with a cloud LLM service — enabling non-technical admins to query databases via natural language.

**Architecture:** Three packages — (1) Cloud LLM service (Node.js/Express, receives schema+questions, returns SQL+answers), (2) Rails middleware gem (mounted in customer's app, auto-discovers schema/enums/code, executes SQL, streams SSE), (3) Chrome Extension (content script with chat widget, DOM crawler, sends questions to middleware). The middleware orchestrates the full flow; the extension is a thin UI+crawler layer.

**Tech Stack:** Node.js + Express + OpenAI SDK (cloud), Ruby + Rails Engine + `pg_query` + SQLite3 (gem), TypeScript + React + Vite + Chrome MV3 (extension)

**Design Doc:** `docs/plans/2026-02-25-v3-research-and-architecture.md` (3 audits, 41 issues resolved)

---

## Build Order

The build order follows the data flow: cloud first (it has no dependencies), then Rails gem (depends on cloud), then extension (depends on middleware). Each phase is independently testable.

```
Phase 1: Project Setup + Shared Types
Phase 2: Cloud LLM Service
Phase 3: Rails Middleware Gem — Core (Engine, Auth, Schema, SQL Execution)
Phase 4: Rails Middleware Gem — Discovery (Enums, Code Analysis, Model Parsing)
Phase 5: Rails Middleware Gem — Orchestration (/chatbot/ask + SSE)
Phase 6: Chrome Extension — Core (Widget, Discovery, Storage)
Phase 7: Chrome Extension — Modes (Data, Code, Navigation/Guidance)
Phase 8: E2E Integration Test on MSP
```

---

## Phase 1: Project Setup + Shared Types

### Task 1.1: Create V3 Branch and Clean Repo Structure

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/cloud/package.json`
- Create: `packages/rails-agent/` (gem scaffold)

**Step 1: Create v3-development branch**

```bash
cd "/home/sotsys-322/Ruby Projects/sql-chatbot"
git checkout v2-development
git checkout -b v3-development
```

**Step 2: Update pnpm workspace to include cloud package**

Add `packages/cloud` to `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

(Already covers `packages/cloud` — verify it does.)

**Step 3: Scaffold cloud package**

```bash
mkdir -p packages/cloud/src/{routes,prompts,middleware}
mkdir -p packages/cloud/src/__tests__
```

Create `packages/cloud/package.json`:

```json
{
  "name": "@chatbot/cloud",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@chatbot/shared": "workspace:*",
    "express": "^4.21.0",
    "openai": "^4.72.0",
    "cors": "^2.8.5",
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.4.0",
    "better-sqlite3": "^11.6.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/express": "^5.0.0",
    "@types/cors": "^2.8.17",
    "@types/better-sqlite3": "^7.6.12"
  }
}
```

Create `packages/cloud/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

**Step 4: Scaffold Rails gem directory**

```bash
mkdir -p packages/rails-agent/lib/chatbot_agent/{discovery,db,code,controllers}
mkdir -p packages/rails-agent/app/controllers/chatbot_agent
mkdir -p packages/rails-agent/config
mkdir -p packages/rails-agent/spec/{db,discovery,code,controllers}
```

Create `packages/rails-agent/chatbot_agent.gemspec`:

```ruby
Gem::Specification.new do |spec|
  spec.name          = "chatbot_agent"
  spec.version       = "0.1.0"
  spec.authors       = ["SQL Chatbot Team"]
  spec.summary       = "AI chatbot middleware for Rails admin panels"
  spec.description   = "Mount in your Rails app to enable natural language database queries via Chrome extension"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 2.7.0"

  spec.files = Dir["lib/**/*", "app/**/*", "config/**/*", "LICENSE", "README.md"]

  spec.add_dependency "rails", ">= 5.2"
  spec.add_dependency "pg_query", ">= 4.0"
  spec.add_dependency "sqlite3", ">= 1.4"
  spec.add_dependency "net-http"

  spec.add_development_dependency "rspec-rails"
  spec.add_development_dependency "webmock"
end
```

**Step 5: Commit**

```bash
git add -A
git commit -m "scaffold V3 project structure: cloud package + rails gem"
```

---

### Task 1.2: Update Shared Types for V3

**Files:**
- Modify: `packages/shared/src/types/llm.ts`
- Modify: `packages/shared/src/types/api.ts`
- Modify: `packages/shared/src/types/messages.ts`
- Modify: `packages/shared/src/constants.ts`

**Step 1: Update QuestionType to include data_with_code (already exists in V2 — verify)**

Read `packages/shared/src/types/llm.ts` and confirm `data_with_code` is in the `QuestionType` union. If not, add it.

**Step 2: Add V3 API types for cloud endpoints**

Add to `packages/shared/src/types/api.ts`:

```typescript
// === V3 Cloud API Types ===

export interface CloudClassifyRequest {
  question: string;
  schemaSummary: string;
  pageContext?: string;
  apiKey: string;
}

export interface CloudClassifyResponse {
  type: QuestionType;
  confidence: number;
  searchTerms?: string[];  // included for code, data_with_code types
}

export interface CloudGenerateSqlRequest {
  question: string;
  schema: string;
  enums: string;
  discoveredContext: string;
  codeContext?: string;
  history: ChatMessage[];
  apiKey: string;
  retryWithContext?: {
    originalSql: string;
    rejectionReason: string;
  };
}

export interface CloudGenerateSqlResponse {
  sql: string;
}

export interface CloudAnswerRequest {
  question: string;
  sqlResult?: string;
  codeSnippets?: string;
  pageContext?: string;
  history: ChatMessage[];
  questionType: QuestionType;
  apiKey: string;
}

// === V3 Middleware API Types ===

export interface MiddlewareAskRequest {
  question: string;
  history: ChatMessage[];
  pageContext?: string;
}

export interface MiddlewareStatusResponse {
  version: string;
  status: 'ready' | 'discovering' | 'error';
  discoveryState: {
    schema: 'pending' | 'running' | 'completed' | 'failed';
    enums: 'pending' | 'running' | 'completed' | 'failed';
    code: 'pending' | 'running' | 'completed' | 'failed';
  };
  authRequired: boolean;
}
```

**Step 3: Update constants for V3**

Add to `packages/shared/src/constants.ts`:

```typescript
// V3 Cloud
export const CLOUD_API_BASE = process.env.CHATBOT_CLOUD_URL || 'https://api.chatbot-agent.com';
export const CLOUD_TIMEOUT_MS = 30_000;
export const CLOUD_RATE_LIMIT = 100; // per minute per key

// V3 Middleware
export const MIDDLEWARE_VERSION = '1.0.0';
export const SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour
export const CODE_INDEX_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
export const ENUM_SAMPLE_TIMEOUT_MS = 5_000;  // 5s per table
export const ENUM_MAX_TABLES = 100;
export const ENUM_MAX_ROW_COUNT = 1_000_000;  // skip tables > 1M rows
```

**Step 4: Run shared package tests**

```bash
cd packages/shared && pnpm test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "update shared types and constants for V3 cloud + middleware APIs"
```

---

## Phase 2: Cloud LLM Service

### Task 2.1: Cloud Server Skeleton + API Key Auth

**Files:**
- Create: `packages/cloud/src/server.ts`
- Create: `packages/cloud/src/middleware/auth.ts`
- Create: `packages/cloud/src/middleware/rate-limit.ts`
- Create: `packages/cloud/src/db/api-keys.ts`
- Test: `packages/cloud/src/__tests__/auth.test.ts`

**Step 1: Write failing test for API key auth middleware**

```typescript
// packages/cloud/src/__tests__/auth.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyAuth } from '../middleware/auth.js';
import { initApiKeyDb, addApiKey } from '../db/api-keys.js';

describe('API Key Auth Middleware', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    initApiKeyDb(':memory:');
    app.use(apiKeyAuth);
    app.get('/test', (req, res) => res.json({ ok: true }));
  });

  it('rejects requests without Authorization header', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing API key');
  });

  it('rejects invalid API keys', async () => {
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer invalid-key');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('allows valid API keys', async () => {
    addApiKey('test-key-123', 'test-customer');
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/cloud && pnpm test -- src/__tests__/auth.test.ts
```

Expected: FAIL (modules don't exist)

**Step 3: Implement API key database + auth middleware**

```typescript
// packages/cloud/src/db/api-keys.ts
import Database from 'better-sqlite3';

let db: Database.Database;

export function initApiKeyDb(path: string = './data/api-keys.sqlite3') {
  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      active INTEGER DEFAULT 1
    )
  `);
}

export function addApiKey(key: string, customerName: string): void {
  db.prepare('INSERT OR REPLACE INTO api_keys (key, customer_name) VALUES (?, ?)').run(key, customerName);
}

export function validateApiKey(key: string): { valid: boolean; customerName?: string } {
  const row = db.prepare('SELECT customer_name FROM api_keys WHERE key = ? AND active = 1').get(key) as { customer_name: string } | undefined;
  return row ? { valid: true, customerName: row.customer_name } : { valid: false };
}
```

```typescript
// packages/cloud/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../db/api-keys.js';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  const key = authHeader.slice(7);
  const result = validateApiKey(key);
  if (!result.valid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  (req as any).customerName = result.customerName;
  next();
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/cloud && pnpm test -- src/__tests__/auth.test.ts
```

Expected: PASS

**Step 5: Create server skeleton**

```typescript
// packages/cloud/src/server.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { apiKeyAuth } from './middleware/auth.js';
import { initApiKeyDb } from './db/api-keys.js';
import { classifyRoute } from './routes/classify.js';
import { generateSqlRoute } from './routes/generate-sql.js';
import { answerRoute } from './routes/answer.js';

const app = express();
const PORT = process.env.PORT || 3100;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.headers.authorization?.slice(7) || req.ip || 'unknown',
});
app.use('/api/', limiter);

// Public health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Authenticated routes
app.use('/api/v1/', apiKeyAuth);
app.post('/api/v1/classify', classifyRoute);
app.post('/api/v1/generate-sql', generateSqlRoute);
app.post('/api/v1/answer', answerRoute);

export function startServer() {
  const dbPath = process.env.API_KEYS_DB || './data/api-keys.sqlite3';
  initApiKeyDb(dbPath);
  app.listen(PORT, () => console.log(`Cloud LLM service listening on :${PORT}`));
}

export { app };
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat(cloud): server skeleton with API key auth + rate limiting"
```

---

### Task 2.2: Cloud Classify Endpoint

**Files:**
- Create: `packages/cloud/src/routes/classify.ts`
- Create: `packages/cloud/src/prompts/classify.ts`
- Test: `packages/cloud/src/__tests__/classify.test.ts`

**Step 1: Write failing test**

```typescript
// packages/cloud/src/__tests__/classify.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildClassifyMessages } from '../prompts/classify.js';

describe('Classify Prompt Builder', () => {
  it('builds classify messages with schema summary', () => {
    const messages = buildClassifyMessages({
      question: 'How many active customers?',
      schemaSummary: 'TABLE customers (id, name, status, created_at)',
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('classify');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('How many active customers?');
    expect(messages[1].content).toContain('TABLE customers');
  });

  it('includes page context when provided', () => {
    const messages = buildClassifyMessages({
      question: 'Where is the settings page?',
      schemaSummary: 'TABLE users (id)',
      pageContext: 'Nav: [Dashboard, Settings, Users]',
    });
    expect(messages[1].content).toContain('Nav: [Dashboard, Settings, Users]');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/cloud && pnpm test -- src/__tests__/classify.test.ts
```

**Step 3: Implement classify prompt builder**

Port from V2's `packages/agent/src/llm/prompts.ts` `buildClassifyPrompt()`, but remove all MSP-specific content. The classify prompt should be generic:

```typescript
// packages/cloud/src/prompts/classify.ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

interface ClassifyInput {
  question: string;
  schemaSummary: string;
  pageContext?: string;
}

export function buildClassifyMessages(input: ClassifyInput): ChatCompletionMessageParam[] {
  const systemPrompt = `You are a question classifier for an admin panel chatbot. Classify the user's question into exactly one type.

TYPES:
- "data": Questions answerable by querying the database (counts, lists, aggregations, lookups)
- "data_with_code": Questions requiring BOTH database query AND understanding of business logic in the codebase (e.g., "show jobs where net sales > $500" needs the net_sales formula from code)
- "code": Questions about how the codebase works, business logic, calculations (no database query needed)
- "navigation": Questions about WHERE something is in the admin panel UI ("where is X?", "how do I find X?")
- "guidance": Questions about HOW to perform an action in the admin panel ("how do I ban a user?", "how do I create a coupon?")

For "code" and "data_with_code" types, also return searchTerms — an array of 2-5 keywords to search the codebase for relevant code.

Respond with JSON only: {"type": "<type>", "confidence": <0.0-1.0>, "searchTerms": ["term1", "term2"]}
searchTerms should only be included for "code" and "data_with_code" types.`;

  let userContent = `Question: ${input.question}\n\nDatabase schema:\n${input.schemaSummary}`;
  if (input.pageContext) {
    userContent += `\n\nCurrent page context:\n${input.pageContext}`;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}
```

**Step 4: Implement classify route**

```typescript
// packages/cloud/src/routes/classify.ts
import { Request, Response } from 'express';
import { callOpenAI } from '../llm/openai.js';
import { buildClassifyMessages } from '../prompts/classify.js';

export async function classifyRoute(req: Request, res: Response): Promise<void> {
  const { question, schemaSummary, pageContext } = req.body;

  if (!question || !schemaSummary) {
    res.status(400).json({ error: 'question and schemaSummary are required' });
    return;
  }

  try {
    const messages = buildClassifyMessages({ question, schemaSummary, pageContext });
    const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
    const parsed = JSON.parse(result);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: `Classification failed: ${err.message}` });
  }
}
```

**Step 5: Create OpenAI wrapper (shared by all routes)**

```typescript
// packages/cloud/src/llm/openai.ts
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

let client: OpenAI;

export function initOpenAI(apiKey?: string) {
  client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
}

interface CallOptions {
  jsonMode?: boolean;
  temperature?: number;
  model?: string;
}

export async function callOpenAI(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): Promise<string> {
  if (!client) initOpenAI();

  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
    messages,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
  });

  return response.choices[0]?.message?.content || '';
}

export async function* streamOpenAI(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): AsyncGenerator<string> {
  if (!client) initOpenAI();

  const stream = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',
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

**Step 6: Run tests**

```bash
cd packages/cloud && pnpm test
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(cloud): classify endpoint with prompt builder + OpenAI wrapper"
```

---

### Task 2.3: Cloud Generate-SQL Endpoint

**Files:**
- Create: `packages/cloud/src/routes/generate-sql.ts`
- Create: `packages/cloud/src/prompts/generate-sql.ts`
- Test: `packages/cloud/src/__tests__/generate-sql.test.ts`

**Step 1: Write failing test for SQL prompt builder**

```typescript
// packages/cloud/src/__tests__/generate-sql.test.ts
import { describe, it, expect } from 'vitest';
import { buildGenerateSqlMessages } from '../prompts/generate-sql.js';

describe('Generate SQL Prompt Builder', () => {
  it('includes schema, enums, and discovered context', () => {
    const messages = buildGenerateSqlMessages({
      question: 'How many active customers?',
      schema: 'TABLE customers (id INT, name TEXT, status INT, created_at TIMESTAMP)',
      enums: 'customers.status: 1=Active, 2=Inactive, 3=Deleted',
      discoveredContext: 'Default scope excludes status=3 (Deleted)',
      history: [],
    });
    expect(messages[0].content).toContain('SELECT');
    expect(messages[0].content).toContain('READ ONLY');
    expect(messages[1].content).toContain('customers.status: 1=Active');
    expect(messages[1].content).toContain('Default scope excludes status=3');
  });

  it('includes code context for data_with_code', () => {
    const messages = buildGenerateSqlMessages({
      question: 'Jobs where net sales > $500',
      schema: 'TABLE jobs (id, total, discount)',
      enums: '',
      discoveredContext: '',
      codeContext: 'def net_sales; total - discount; end',
      history: [],
    });
    expect(messages[1].content).toContain('net_sales');
    expect(messages[1].content).toContain('total - discount');
  });

  it('includes retry context when SQL was rejected', () => {
    const messages = buildGenerateSqlMessages({
      question: 'Show all users',
      schema: 'TABLE users (id, name)',
      enums: '',
      discoveredContext: '',
      history: [],
      retryWithContext: {
        originalSql: 'SELECT * FROM pg_roles',
        rejectionReason: 'Access to system catalog pg_roles is blocked',
      },
    });
    const lastMsg = messages[messages.length - 1].content as string;
    expect(lastMsg).toContain('pg_roles');
    expect(lastMsg).toContain('blocked');
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement generate-sql prompt builder**

Port from V2's `buildSQLPrompt()` — remove all MSP-specific rules, replace with `discoveredContext` parameter:

```typescript
// packages/cloud/src/prompts/generate-sql.ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage } from '@chatbot/shared';

interface GenerateSqlInput {
  question: string;
  schema: string;
  enums: string;
  discoveredContext: string;
  codeContext?: string;
  history: ChatMessage[];
  retryWithContext?: { originalSql: string; rejectionReason: string };
}

export function buildGenerateSqlMessages(input: GenerateSqlInput): ChatCompletionMessageParam[] {
  const systemPrompt = `You are a PostgreSQL SQL generator for an admin panel chatbot. Generate a single SELECT query to answer the user's question.

RULES:
- Generate ONLY SELECT statements. Never INSERT, UPDATE, DELETE, DROP, or any DDL.
- The query will run inside a READ ONLY transaction.
- Always include a LIMIT clause (max 500 rows) unless the query is an aggregate (COUNT, SUM, AVG, etc.).
- Use the provided schema, enum mappings, and discovered context to write accurate SQL.
- If enum values have labels (e.g., status: 1=Active), use the integer value in WHERE clauses, not the label text.
- Trust the discovered context — it contains auto-detected rules about this specific database.

Respond with JSON only: {"sql": "SELECT ..."}`;

  let contextBlock = `DATABASE SCHEMA:\n${input.schema}`;
  if (input.enums) contextBlock += `\n\nENUM MAPPINGS:\n${input.enums}`;
  if (input.discoveredContext) contextBlock += `\n\nDISCOVERED CONTEXT:\n${input.discoveredContext}`;
  if (input.codeContext) contextBlock += `\n\nRELEVANT CODE:\n${input.codeContext}`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: contextBlock },
  ];

  // Add conversation history
  for (const msg of input.history.slice(-10)) {
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }

  // Add current question
  let questionContent = `Question: ${input.question}`;
  if (input.retryWithContext) {
    questionContent += `\n\nPREVIOUS ATTEMPT FAILED:\nSQL: ${input.retryWithContext.originalSql}\nRejection reason: ${input.retryWithContext.rejectionReason}\nPlease generate a corrected query that avoids this issue.`;
  }
  messages.push({ role: 'user', content: questionContent });

  return messages;
}
```

```typescript
// packages/cloud/src/routes/generate-sql.ts
import { Request, Response } from 'express';
import { callOpenAI } from '../llm/openai.js';
import { buildGenerateSqlMessages } from '../prompts/generate-sql.js';

export async function generateSqlRoute(req: Request, res: Response): Promise<void> {
  const { question, schema, enums, discoveredContext, codeContext, history, retryWithContext } = req.body;

  if (!question || !schema) {
    res.status(400).json({ error: 'question and schema are required' });
    return;
  }

  try {
    const messages = buildGenerateSqlMessages({
      question, schema, enums: enums || '', discoveredContext: discoveredContext || '',
      codeContext, history: history || [], retryWithContext,
    });
    const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
    const parsed = JSON.parse(result);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: `SQL generation failed: ${err.message}` });
  }
}
```

**Step 4: Run tests**

```bash
cd packages/cloud && pnpm test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(cloud): generate-sql endpoint with discoveredContext support"
```

---

### Task 2.4: Cloud Answer Endpoint (SSE Streaming)

**Files:**
- Create: `packages/cloud/src/routes/answer.ts`
- Create: `packages/cloud/src/prompts/answer.ts`
- Test: `packages/cloud/src/__tests__/answer.test.ts`

**Step 1: Write failing test for answer prompt builder**

```typescript
// packages/cloud/src/__tests__/answer.test.ts
import { describe, it, expect } from 'vitest';
import { buildAnswerMessages } from '../prompts/answer.js';

describe('Answer Prompt Builder', () => {
  it('builds data answer with SQL result', () => {
    const messages = buildAnswerMessages({
      question: 'How many active customers?',
      questionType: 'data',
      sqlResult: JSON.stringify({ columns: ['count'], rows: [{ count: 342 }] }),
      history: [],
    });
    expect(messages[0].content).toContain('Trust the query results');
    expect(messages[1].content).toContain('342');
  });

  it('builds code answer with snippets', () => {
    const messages = buildAnswerMessages({
      question: 'How is net sales calculated?',
      questionType: 'code',
      codeSnippets: 'File: app/models/job.rb:45\ndef net_sales\n  total - discount\nend',
      history: [],
    });
    expect(messages[0].content).toContain('code');
    expect(messages[1].content).toContain('net_sales');
  });

  it('builds navigation answer with page context', () => {
    const messages = buildAnswerMessages({
      question: 'Where is user management?',
      questionType: 'navigation',
      pageContext: 'Nav: [Dashboard (/), Users (/admin/users), Settings (/admin/settings)]',
      history: [],
    });
    expect(messages[1].content).toContain('/admin/users');
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement answer prompt builder + SSE route**

```typescript
// packages/cloud/src/prompts/answer.ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatMessage, QuestionType } from '@chatbot/shared';

interface AnswerInput {
  question: string;
  questionType: QuestionType;
  sqlResult?: string;
  codeSnippets?: string;
  pageContext?: string;
  history: ChatMessage[];
}

export function buildAnswerMessages(input: AnswerInput): ChatCompletionMessageParam[] {
  let systemPrompt: string;

  switch (input.questionType) {
    case 'data':
    case 'data_with_code':
      systemPrompt = `You are a helpful admin panel assistant. The user asked a data question and a SQL query was executed. Summarize the results in a clear, natural language answer.

RULES:
- Trust the query results completely — do not second-guess them.
- Be concise — one to three sentences for simple queries.
- Format numbers with commas (e.g., 40,238 not 40238).
- If the result is a list, format it as a readable list.
- Do NOT show the SQL query unless the user asked for it.`;
      break;

    case 'code':
      systemPrompt = `You are a helpful admin panel assistant explaining code. The user asked about how something works in the codebase. Explain based on the code snippets provided.

RULES:
- Reference specific files and line numbers when explaining.
- Be concise but thorough — developers need accurate explanations.
- If the code is unclear, say so rather than guessing.`;
      break;

    case 'navigation':
    case 'guidance':
      systemPrompt = `You are a helpful admin panel assistant. The user needs help navigating or using the admin panel. Use the current page context to guide them.

RULES:
- Reference specific menu items, buttons, or links visible on the page.
- For navigation: tell them exactly where to click.
- For guidance: give step-by-step instructions.
- Be concise and actionable.`;
      break;

    default:
      systemPrompt = 'You are a helpful admin panel assistant.';
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Build context message
  let context = `Question: ${input.question}`;
  if (input.sqlResult) context += `\n\nQuery results:\n${input.sqlResult}`;
  if (input.codeSnippets) context += `\n\nCode snippets:\n${input.codeSnippets}`;
  if (input.pageContext) context += `\n\nPage context:\n${input.pageContext}`;

  // Add history
  for (const msg of input.history.slice(-10)) {
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }

  messages.push({ role: 'user', content: context });
  return messages;
}
```

```typescript
// packages/cloud/src/routes/answer.ts
import { Request, Response } from 'express';
import { streamOpenAI } from '../llm/openai.js';
import { buildAnswerMessages } from '../prompts/answer.js';

export async function answerRoute(req: Request, res: Response): Promise<void> {
  const { question, questionType, sqlResult, codeSnippets, pageContext, history } = req.body;

  if (!question || !questionType) {
    res.status(400).json({ error: 'question and questionType are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const messages = buildAnswerMessages({
      question, questionType, sqlResult, codeSnippets, pageContext, history: history || [],
    });

    for await (const token of streamOpenAI(messages)) {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
```

**Step 4: Run tests**

```bash
cd packages/cloud && pnpm test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(cloud): answer endpoint with SSE streaming + prompt builders for all 5 question types"
```

---

### Task 2.5: Cloud Integration Test

**Files:**
- Test: `packages/cloud/src/__tests__/server.integration.test.ts`

**Step 1: Write integration test that validates all 3 endpoints respond correctly**

Test the full request/response cycle with mocked OpenAI responses. Verify:
- `/health` returns 200
- `/api/v1/classify` without API key returns 401
- `/api/v1/classify` with valid key returns classification
- `/api/v1/generate-sql` returns SQL
- `/api/v1/answer` returns SSE stream

**Step 2: Run tests**

```bash
cd packages/cloud && pnpm test
```

**Step 3: Commit**

```bash
git add -A
git commit -m "test(cloud): integration tests for all endpoints"
```

---

## Phase 3: Rails Middleware Gem — Core

### Task 3.1: Rails Engine Skeleton + Configuration

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/engine.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/configuration.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/railtie.rb`
- Create: `packages/rails-agent/config/routes.rb`
- Test: `packages/rails-agent/spec/configuration_spec.rb`

**Step 1: Write failing test for configuration**

```ruby
# packages/rails-agent/spec/configuration_spec.rb
require 'spec_helper'

RSpec.describe ChatbotAgent::Configuration do
  it 'stores api_key' do
    config = ChatbotAgent::Configuration.new
    config.api_key = 'test-key'
    expect(config.api_key).to eq('test-key')
  end

  it 'has default auth_check that returns true in development' do
    config = ChatbotAgent::Configuration.new
    expect(config.auth_check).to be_a(Proc)
  end

  it 'stores optional custom_context with 2000 char limit' do
    config = ChatbotAgent::Configuration.new
    config.custom_context = 'x' * 2001
    expect(config.custom_context.length).to eq(2000)
  end

  it 'defaults codebase_path to nil (resolved at runtime to Rails.root)' do
    config = ChatbotAgent::Configuration.new
    expect(config.codebase_path).to be_nil
  end
end
```

**Step 2: Run test to verify it fails**

```bash
cd packages/rails-agent && bundle exec rspec spec/configuration_spec.rb
```

**Step 3: Implement configuration**

```ruby
# packages/rails-agent/lib/chatbot_agent/configuration.rb
module ChatbotAgent
  class Configuration
    attr_accessor :api_key, :auth_check, :codebase_path, :cloud_url

    def initialize
      @api_key = nil
      @auth_check = ->(request) { true }  # default: allow all (development)
      @codebase_path = nil  # defaults to Rails.root at runtime
      @cloud_url = ENV['CHATBOT_CLOUD_URL'] || 'https://api.chatbot-agent.com'
      @custom_context = nil
    end

    def custom_context=(value)
      @custom_context = value&.to_s&.slice(0, 2000)
    end

    def custom_context
      @custom_context
    end
  end
end
```

```ruby
# packages/rails-agent/lib/chatbot_agent.rb
require 'chatbot_agent/configuration'
require 'chatbot_agent/engine' if defined?(Rails)

module ChatbotAgent
  class << self
    attr_accessor :configuration

    def configure
      self.configuration ||= Configuration.new
      yield(configuration)
    end

    def config
      configuration || Configuration.new
    end
  end
end
```

```ruby
# packages/rails-agent/lib/chatbot_agent/engine.rb
module ChatbotAgent
  class Engine < ::Rails::Engine
    isolate_namespace ChatbotAgent
  end
end
```

```ruby
# packages/rails-agent/config/routes.rb
ChatbotAgent::Engine.routes.draw do
  post 'ask', to: 'ask#create'
  get  'status', to: 'status#show'
  post 'rediscover', to: 'rediscover#create'
end
```

```ruby
# packages/rails-agent/lib/chatbot_agent/railtie.rb
module ChatbotAgent
  class Railtie < ::Rails::Railtie
    initializer 'chatbot_agent.meta_tag_injection' do |app|
      app.middleware.use ChatbotAgent::MetaTagMiddleware
    end
  end
end
```

**Step 4: Run tests**

```bash
cd packages/rails-agent && bundle exec rspec
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(rails-agent): engine skeleton with configuration + routes + railtie"
```

---

### Task 3.2: Auth Middleware + CORS

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/middleware/auth.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/middleware/cors.rb`
- Create: `packages/rails-agent/app/controllers/chatbot_agent/application_controller.rb`
- Test: `packages/rails-agent/spec/middleware/auth_spec.rb`

Implement the auth callback check as a `before_action` in `ChatbotAgent::ApplicationController`. All chatbot controllers inherit from this. CORS middleware validates `chrome-extension://` scheme prefix or app's own domain, sets `Access-Control-Allow-Credentials: true`.

**Step 1-5: TDD cycle** (test → fail → implement → pass → commit)

---

### Task 3.3: Schema Inspector (Ruby Port)

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/db/schema_inspector.rb`
- Test: `packages/rails-agent/spec/db/schema_inspector_spec.rb`

Port the SQL queries from V2's `packages/agent/src/db/schema-inspector.ts`. Use `ActiveRecord::Base.connection.execute()` for all queries. Filter sensitive columns using both `SENSITIVE_COLUMN_PATTERNS` and `PII_COLUMN_PATTERNS`.

Key methods:
- `ChatbotAgent::Db::SchemaInspector.inspect` → returns hash of tables with columns, PKs, FKs, comments
- `ChatbotAgent::Db::SchemaInspector.format_for_prompt(tables)` → returns `TABLE tablename (col1, col2, ...)` string

**Step 1-5: TDD cycle**

---

### Task 3.4: SQL Executor (Ruby Port)

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/db/sql_executor.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/db/sql_validator.rb`
- Test: `packages/rails-agent/spec/db/sql_executor_spec.rb`
- Test: `packages/rails-agent/spec/db/sql_validator_spec.rb`

SQL Validator: Port the 8-layer validation from V2's `@chatbot/shared` using `pg_query` gem for parsing. Key validations:
1. Parse SQL (syntax check)
2. Single statement only
3. Must be SELECT (block INSERT/UPDATE/DELETE/DDL)
4. Block SELECT INTO
5. Block CTEs with mutations
6. Block dangerous functions (`pg_read_file`, `dblink`, `pg_sleep`, etc.)
7. Block system catalog access (`pg_stat_activity`, `pg_roles`, etc.)
8. Add LIMIT 500 if missing

SQL Executor: Use raw `connection.execute` with explicit `BEGIN; SET TRANSACTION READ ONLY; ...; COMMIT;` block.

**Step 1-5: TDD cycle**

---

### Task 3.5: Cloud Client (HTTP Client for Cloud Service)

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/cloud_client.rb`
- Test: `packages/rails-agent/spec/cloud_client_spec.rb`

HTTP client using `Net::HTTP` with:
- 5s connect timeout, 30s read timeout
- Bearer token auth with `config.api_key`
- JSON request/response for classify + generate-sql
- SSE streaming for answer endpoint (`response.read_body { |chunk| ... }`)
- Error handling per Decision 10

Methods:
- `classify(question:, schema_summary:, page_context:)`
- `generate_sql(question:, schema:, enums:, context:, history:, code_context:, retry_context:)`
- `stream_answer(question:, type:, result:, history:, &block)` — yields tokens

**Step 1-5: TDD cycle** (use WebMock for HTTP stubbing)

---

## Phase 4: Rails Middleware Gem — Discovery

### Task 4.1: Enum Sampler

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/discovery/enum_sampler.rb`
- Test: `packages/rails-agent/spec/discovery/enum_sampler_spec.rb`

Port from V2's `data-sampler.ts`. Use `connection_pool.with_connection` for thread safety. Add performance guards:
- `SET statement_timeout = '5000'` before each sample query
- Skip tables with > 1M rows (check via `pg_class.reltuples`)
- Cap at 100 tables

**Step 1-5: TDD cycle**

---

### Task 4.2: Label Inference from Code

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/discovery/label_inference.rb`
- Test: `packages/rails-agent/spec/discovery/label_inference_spec.rb`

Port V2's `label-inference.ts` regex patterns. Framework-agnostic — works on any code text. Three patterns:
1. Ruby/Rails: `'Active': 1` or `"Active": 1`
2. JS/TS/Python: `Active = 1` or `Active: 1`
3. Fallback: numeric labels

**Step 1-5: TDD cycle**

---

### Task 4.3: Model File Parser (Rails-Specific)

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/discovery/model_parser.rb`
- Test: `packages/rails-agent/spec/discovery/model_parser_spec.rb`

NEW for V3 — parses Rails model files to extract:
- `belongs_to :customer, foreign_key: :created_by` → FK mapping
- `has_many :jobs` → association info
- `default_scope { where.not(status: 3) }` → default scope rules
- `acts_as_paranoid` / `include Paranoia` → soft delete detection
- `enum status: { ... }` → enum definitions

Walks `app/models/**/*.rb`, parses with regex (not AST — simple and sufficient for these patterns).

**Step 1-5: TDD cycle**

---

### Task 4.4: Code Indexer + BM25 Search (Ruby Port)

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/code/indexer.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/code/search.rb`
- Test: `packages/rails-agent/spec/code/indexer_spec.rb`
- Test: `packages/rails-agent/spec/code/search_spec.rb`

Port V2's `indexer.ts` and `search.ts` to Ruby:
- Walk directory tree, apply exclusion filters, check extensions
- Split files into 50-150 line chunks at code boundaries
- Store in SQLite `code_chunks` table
- BM25 search with k1=1.5, b=0.75

Background indexing via `Thread.new` (writes to SQLite only — no PG connection needed).

**Step 1-5: TDD cycle**

---

### Task 4.5: Discovery Pipeline

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/discovery/pipeline.rb`
- Create: `packages/rails-agent/lib/chatbot_agent/discovery/cache.rb`
- Test: `packages/rails-agent/spec/discovery/pipeline_spec.rb`

Orchestrates all discovery components. Three phases:
1. Schema inspection (sync, 1-3s)
2. Enum detection + label inference + model parsing (sync, 5-15s)
3. Code indexing (async via Thread.new, 10-30s)

Caches results in SQLite at `Rails.root.join('tmp/chatbot_agent/cache.sqlite3')`. Cache TTL: schema = 1 hour, code index = 24 hours.

State tracking: `{ schema: 'completed', enums: 'running', code: 'pending' }`

**Step 1-5: TDD cycle**

---

## Phase 5: Rails Middleware Gem — Orchestration

### Task 5.1: Ask Controller (Main Orchestration Endpoint)

**Files:**
- Create: `packages/rails-agent/app/controllers/chatbot_agent/ask_controller.rb`
- Test: `packages/rails-agent/spec/controllers/ask_controller_spec.rb`

The heart of the middleware. `POST /chatbot/ask` flow:
1. Validate auth (from ApplicationController `before_action`)
2. Ensure discovery is ready (if not, return "Still learning...")
3. Build schema summary + enum string + discovered context
4. Call cloud `/api/v1/classify`
5. Branch by type:
   - `data`: call cloud generate-sql → validate SQL → execute locally → stream answer
   - `data_with_code`: search code index → call cloud generate-sql with code context → validate → execute → stream answer
   - `code`: search code index → stream answer with code snippets
   - `navigation`/`guidance`: stream answer with page context
6. If SQL validation fails: retry once with rejection reason
7. Stream SSE response using `ActionController::Live`

**Step 1-5: TDD cycle**

---

### Task 5.2: Status + Rediscover Controllers

**Files:**
- Create: `packages/rails-agent/app/controllers/chatbot_agent/status_controller.rb`
- Create: `packages/rails-agent/app/controllers/chatbot_agent/rediscover_controller.rb`
- Test: `packages/rails-agent/spec/controllers/status_controller_spec.rb`

`GET /chatbot/status` returns:
```json
{"version": "1.0.0", "status": "ready", "discoveryState": {...}, "authRequired": true}
```

`POST /chatbot/rediscover` triggers a full re-run of the discovery pipeline.

**Step 1-5: TDD cycle**

---

### Task 5.3: Meta Tag Injection Middleware

**Files:**
- Create: `packages/rails-agent/lib/chatbot_agent/middleware/meta_tag.rb`
- Test: `packages/rails-agent/spec/middleware/meta_tag_spec.rb`

Rack middleware that injects `<meta name="chatbot-agent" content="/chatbot">` into HTML responses just before `</head>`. Only injects if the response content-type is `text/html`.

**Step 1-5: TDD cycle**

---

### Task 5.4: Rails Gem Integration Test with MSP

**Files:**
- Test: `packages/rails-agent/spec/integration/msp_spec.rb`

Mount the engine in a test Rails app (or use MSP directly in development). Verify:
- Schema inspection discovers MSP's tables
- Enum sampling finds `status`, `service_type`, etc.
- Model parsing finds `belongs_to :customer, foreign_key: :created_by`
- The full ask flow works with a mocked cloud service

**Step 1-5: TDD cycle**

---

## Phase 6: Chrome Extension — Core

### Task 6.1: Update IndexedDB Schema (Origin-Based)

**Files:**
- Modify: `packages/extension/src/storage/schema.ts`
- Modify: `packages/extension/src/storage/index.ts`
- Test: `packages/extension/src/storage/__tests__/storage.test.ts`

Breaking change from V2: replace `projectId` keying with `origin` keying. Remove `projects` store. Add `origin` field to `chat_history`. Use `chrome.storage.local` for site configs.

**Step 1-5: TDD cycle**

---

### Task 6.2: Middleware Discovery (Meta Tag + .well-known + Manual)

**Files:**
- Create: `packages/extension/src/content/discovery/index.ts`
- Test: `packages/extension/src/content/discovery/__tests__/discovery.test.ts`

On page load:
1. Check `chrome.storage.local` for current origin
2. If found → return cached endpoint
3. If not → check for `<meta name="chatbot-agent" content="...">` in DOM
4. If not → fetch `/.well-known/chatbot-agent.json`
5. If found → store in `chrome.storage.local`, return endpoint
6. If not → no chatbot on this page

**Step 1-5: TDD cycle**

---

### Task 6.3: Content Script HTTP Client (Replaces Background Worker Requests)

**Files:**
- Create: `packages/extension/src/content/api/client.ts`
- Test: `packages/extension/src/content/api/__tests__/client.test.ts`

Key change from V2: content script makes `fetch()` calls directly (not background worker). All requests include `credentials: 'include'` for session cookies.

Methods:
- `askQuestion(endpoint, request)` → returns ReadableStream for SSE
- `getStatus(endpoint)` → returns MiddlewareStatusResponse
- `parseSSE(stream, onToken, onDone, onError)` → SSE parser

**Step 1-5: TDD cycle**

---

### Task 6.4: Update Chat Widget for V3

**Files:**
- Modify: `packages/extension/src/content/widget/ChatWidget.tsx` (V2 reference: `packages/extension/src/content/widget/`)
- Modify: `packages/extension/src/content/widget/mount.ts`

Changes from V2:
- On send: content script calls middleware directly via `askQuestion()` (not `chrome.runtime.sendMessage`)
- SSE parsing happens in content script
- Discovery runs on mount to find middleware endpoint
- Show loading state when discovery is `"discovering"`
- Show "Please log in" when auth returns 401

**Step 1-5: TDD cycle**

---

### Task 6.5: Simplified Background Worker

**Files:**
- Modify: `packages/extension/src/background/index.ts`
- Remove orchestration logic from: `packages/extension/src/background/message-router.ts`

V3 background worker is minimal:
- Manages `chrome.storage.local` for site configs
- Handles extension lifecycle events
- NO HTTP requests to middleware (that's the content script's job now)

**Step 1-5: TDD cycle**

---

### Task 6.6: Redesigned Popup

**Files:**
- Modify: `packages/extension/src/popup/App.tsx`
- Modify/Remove: `packages/extension/src/popup/components/`

V3 popup shows:
- List of detected sites with status (green dot = ready, yellow = discovering, red = error)
- "Add site manually" button for fallback configuration
- No vault unlock (removed in V3)

**Step 1-5: TDD cycle**

---

## Phase 7: Chrome Extension — Modes

### Task 7.1: Data Mode Flow

Content script sends question → middleware orchestrates classify + SQL + answer → SSE stream back. Test with MSP: "How many active customers?"

---

### Task 7.2: Data+Code Mode Flow

Content script sends question → middleware classifies as data_with_code → searches code → generates SQL with code context → executes → streams answer. Test: "Show jobs where net sales exceed $500"

---

### Task 7.3: Code Mode Flow

Test: "How is net sales calculated?" → middleware searches code → streams explanation.

---

### Task 7.4: Navigation/Guidance Mode Flow

Test: "Where do I manage contractors?" → extension sends page context with nav links → middleware streams navigation guidance.

---

## Phase 8: E2E Integration on MSP

### Task 8.1: Mount Gem in MSP Admin Panel

**Files:**
- Modify: MSP's `Gemfile` (add `gem 'chatbot_agent', path: '../sql-chatbot/packages/rails-agent'`)
- Modify: MSP's `config/routes.rb` (add `mount ChatbotAgent::Engine => '/chatbot'`)
- Create: MSP's `config/initializers/chatbot_agent.rb`

**Step 1: Add gem to MSP Gemfile**

```ruby
gem 'chatbot_agent', path: '/home/sotsys-322/Ruby Projects/sql-chatbot/packages/rails-agent'
```

**Step 2: Mount routes**

```ruby
# In MSP's config/routes.rb, inside the admin subdomain block:
mount ChatbotAgent::Engine => '/chatbot'
```

**Step 3: Configure**

```ruby
# config/initializers/chatbot_agent.rb
ChatbotAgent.configure do |config|
  config.api_key = ENV['CHATBOT_API_KEY']
  config.cloud_url = 'http://localhost:3100'  # local cloud service for testing
  config.auth_check = ->(request) {
    request.env['warden']&.user(:admin)&.present?
  }
end
```

**Step 4: Start all services**

```bash
# Terminal 1: Cloud service
cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/cloud" && pnpm dev

# Terminal 2: MSP Rails server
cd "/home/sotsys-322/Ruby Projects/msp-web-copy" && rails server

# Terminal 3: Build extension
cd "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/extension" && pnpm build
```

**Step 5: Load extension in Chrome, open MSP admin panel, test all 4 modes**

---

### Task 8.2: E2E Test Suite (20 Questions)

Test the same 20 "dumb admin" questions from V1/V2:
1. "How many active customers?" → data mode
2. "How many active contractors?" → data mode
3. "How many of them are active?" (follow-up) → data mode with history
4. "How is net sales calculated?" → code mode
5. "Where do I manage contractors?" → navigation mode
6. "How do I ban a user?" → guidance mode
7. (etc. — full list from V2 test suite)

Verify:
- Correct answers
- Conversation history works (follow-ups understand context)
- Enums are correctly discovered (status=1 is Active, not just "1")
- Navigation mode finds actual sidebar links
- SSE streaming works (tokens appear progressively)

---

## Dependency Graph

```
Phase 1 (Setup) ──→ Phase 2 (Cloud) ──→ Phase 3 (Rails Core) ──→ Phase 4 (Rails Discovery) ──→ Phase 5 (Rails Orchestration) ──→ Phase 8 (E2E)
                                                                                                                                        ↑
Phase 1 (Setup) ──→ Phase 6 (Extension Core) ──→ Phase 7 (Extension Modes) ─────────────────────────────────────────────────────────────┘
```

Phases 2 and 6 can run **in parallel** (cloud service and extension have no code dependencies on each other). Phases 3-5 depend on Phase 2. Phase 7 depends on Phase 5 + 6. Phase 8 depends on everything.

---

## Estimated Task Count

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 2 | Setup + shared types |
| 2 | 5 | Cloud service (3 endpoints + auth + integration test) |
| 3 | 5 | Rails core (config, auth, schema, SQL, cloud client) |
| 4 | 5 | Rails discovery (enums, labels, model parser, code index, pipeline) |
| 5 | 4 | Rails orchestration (ask controller, status, meta tag, integration) |
| 6 | 6 | Extension core (storage, discovery, client, widget, background, popup) |
| 7 | 4 | Extension modes (data, data+code, code, nav/guidance) |
| 8 | 2 | E2E (mount in MSP + 20-question test) |
| **Total** | **33** | |
