# SQL Chatbot V2 — Chrome Extension + Local Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Chrome Extension + Local Node.js Agent that lets admins ask natural language questions about their database, codebase, and admin panel. Agent runs locally; LLM via OpenAI API (swappable).

**Architecture:** pnpm monorepo with 3 packages (shared, agent, extension). Agent is a Fastify server on `http://127.0.0.1:9876` with encrypted vault, PostgreSQL read-only access, git code indexing (BM25), and OpenAI LLM proxy. Extension is Manifest V3 with React popup, content script (widget/crawler/actions), and background service worker (message router).

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, pg, better-sqlite3, natural (BM25), argon2, hash-wasm, openai (npm), React 19, Vite, Manifest V3

**Design Doc:** `docs/plans/2026-02-24-chrome-extension-v2-design.md` (v4 — Ollama removed, OpenAI API via agent proxy)

**V1 Source (porting reference):** Python/FastAPI codebase in project root (master branch)

---

## Phase 0: REMOVED (v4)

> **Removed in v4:** Ollama POC was eliminated because the 4.7GB model download (~30-40 min) was terrible UX. GPT-4o-mini is already proven in V1 (20/20 questions passing). Proceed directly to Phase 1.

### Task 0.1: Install Ollama + Pull Model

**Files:** None (system setup)

**Step 1: Install Ollama**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Step 2: Pull the default model**
```bash
ollama pull qwen2.5-coder:7b
```

**Step 3: Verify Ollama is running**
```bash
ollama list
# Expected: qwen2.5-coder:7b listed
curl http://localhost:11434/api/tags
# Expected: JSON with model info
```

**Step 4: Quick test**
```bash
curl http://localhost:11434/api/generate -d '{
  "model": "qwen2.5-coder:7b",
  "prompt": "Write a PostgreSQL SELECT to count active contractors where status = 1",
  "stream": false
}'
```
Expected: Valid SQL response.

---

### Task 0.2: Write POC Test Script

**Files:**
- Create: `poc/ollama-sql-test.ts`
- Create: `poc/package.json`
- Create: `poc/tsconfig.json`
- Reference: `scripts/msp_semantic_context.json` (V1 test questions)

**Step 1: Create poc directory and package.json**

```json
// poc/package.json
{
  "name": "ollama-poc",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "tsx ollama-sql-test.ts"
  },
  "dependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.7.0"
  }
}
```

```json
// poc/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true
  }
}
```

**Step 2: Write the test script**

The script sends each of the 20 test questions to Ollama with the same system prompt structure as V1 (`app/services/llm_service.py` lines 16-123), but adapted for Ollama's API format. It uses the MSP schema and semantic context from `scripts/msp_semantic_context.json`.

```typescript
// poc/ollama-sql-test.ts
// Test 20 dumb-admin questions against Ollama + Qwen2.5-Coder-7B
// Compare with V1 GPT-4o-mini expected SQL

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'qwen2.5-coder:7b';

// Load MSP semantic context from V1
import { readFileSync } from 'fs';
import { resolve } from 'path';

const semanticContext = JSON.parse(
  readFileSync(resolve('..', 'scripts', 'msp_semantic_context.json'), 'utf-8')
);

// The 20 test questions (8 verified + 12 from V1 system prompt examples)
const TEST_QUESTIONS = [
  // 8 verified queries from semantic context
  { q: "How many active contractors are there?", expectedPattern: /SELECT COUNT\(\*\).*contractors.*status\s*=\s*1/i },
  { q: "How many total customers are there?", expectedPattern: /SELECT COUNT\(\*\).*customers.*status\s*!=\s*3/i },
  { q: "How many completed snow shovelling jobs are there?", expectedPattern: /status\s+IN\s*\(11.*28.*29\)/i },
  { q: "How many jobs are currently in progress?", expectedPattern: /status\s+IN\s*\(8.*9.*10.*18\)/i },
  { q: "How many recurring jobs are there?", expectedPattern: /delivery_type\s*=\s*2/i },
  { q: "Which contractor has the most completed jobs?", expectedPattern: /JOIN\s+jobs/i },
  { q: "Show me the last 5 cancelled jobs", expectedPattern: /status\s*=\s*12/i },
  { q: "Which area has the most jobs?", expectedPattern: /JOIN\s+properties/i },
  // 12 additional from V1 prompt examples
  { q: "Show me suspended contractors", expectedPattern: /status\s*=\s*13/i },
  { q: "Who is our best worker?", expectedPattern: /contractors.*JOIN.*jobs/i },
  { q: "What types of jobs do we offer?", expectedPattern: /job_types/i },
  { q: "What's the most popular service?", expectedPattern: /job_types.*COUNT/i },
  { q: "How many people signed up?", expectedPattern: /COUNT\(\*\)/i },
  { q: "Any disputed jobs?", expectedPattern: /status\s*=\s*15/i },
  { q: "Show me the last 10 completed jobs", expectedPattern: /status\s+IN\s*\(11.*28.*29\)/i },
  { q: "How much revenue did we make this month?", expectedPattern: /SUM.*bid_amount/i },
  { q: "Which customer has the most jobs?", expectedPattern: /created_by/i },
  { q: "How many jobs per job type?", expectedPattern: /GROUP BY/i },
  { q: "Show me expired jobs", expectedPattern: /status\s*=\s*24/i },
  { q: "How many contractors are in each status?", expectedPattern: /GROUP BY.*status/i },
];

// Build system prompt (adapted from V1 llm_service.py)
function buildSystemPrompt(): string {
  // Format enum mappings
  const enumText = semanticContext.enum_mappings
    .map((e: any) => {
      const mappings = Object.entries(e.mappings)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return `${e.table}.${e.column}: ${mappings}`;
    })
    .join('\n');

  // Format business rules
  const rulesText = semanticContext.business_rules
    .map((r: any) => `- ${r.title}: ${r.rule}`)
    .join('\n');

  // Format column descriptions
  const colsText = semanticContext.column_descriptions
    .map((c: any) => `- ${c.table}.${c.column}: ${c.description}`)
    .join('\n');

  return `You are an SQL assistant. Generate a PostgreSQL SELECT query for the given question.

## Enum Mappings
${enumText}

## Business Rules
${rulesText}

## Column Descriptions
${colsText}

## Database Schema (key tables)
TABLE contractors (id, first_name, last_name, email, status, login_type, created_at, ...)
TABLE customers (id, first_name, last_name, email, status, login_type, created_at, ...)
TABLE jobs (id, job_type_id, property_id, contractor_id, created_by, status, delivery_type, serv_type, bid_amount, created_at, updated_at, ...)
TABLE job_types (id, title, ...)
TABLE properties (id, customer_id, service_area_id, address_line_1, city, state, zip_code, lat, lng, ...)
TABLE service_areas (id, title, ...)

## Rules
- ALWAYS use CASE expressions for enum labels in SELECT
- ALWAYS JOIN for names (never return raw IDs)
- NEVER use stale cache columns (completed_jobs, completed_jobs_count, total_earned)
- Exclude status=3 (Deleted) by default
- jobs.created_by is the FK to customers (NOT customer_id)
- Return ONLY a valid SQL query, nothing else. No explanation, no markdown.`;
}

async function queryOllama(question: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `${buildSystemPrompt()}\n\nQuestion: ${question}\n\nSQL:`,
      stream: false,
      options: { temperature: 0.1 }
    }),
  });
  const data = await response.json() as { response: string };
  // Extract SQL from response (strip markdown fences if present)
  let sql = data.response.trim();
  sql = sql.replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
  return sql;
}

async function main() {
  console.log(`Testing ${TEST_QUESTIONS.length} questions against ${MODEL}...\n`);

  let passed = 0;
  let failed = 0;
  const failures: { q: string; sql: string; reason: string }[] = [];

  for (const { q, expectedPattern } of TEST_QUESTIONS) {
    const sql = await queryOllama(q);
    const isSelect = /^\s*SELECT/i.test(sql);
    const matchesPattern = expectedPattern.test(sql);

    if (isSelect && matchesPattern) {
      console.log(`✅ ${q}`);
      console.log(`   ${sql.substring(0, 120)}...\n`);
      passed++;
    } else {
      console.log(`❌ ${q}`);
      console.log(`   SQL: ${sql.substring(0, 200)}`);
      console.log(`   Expected pattern: ${expectedPattern}\n`);
      failed++;
      failures.push({ q, sql, reason: !isSelect ? 'Not a SELECT' : 'Pattern mismatch' });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${TEST_QUESTIONS.length} passed (${Math.round(passed/TEST_QUESTIONS.length*100)}%)`);
  console.log(`Failures: ${failed}`);

  if (failures.length > 0) {
    console.log('\nFailed questions:');
    failures.forEach(f => console.log(`  - ${f.q} (${f.reason})`));
  }

  // POC criteria: must pass >= 80% (16/20)
  const passRate = passed / TEST_QUESTIONS.length;
  if (passRate >= 0.8) {
    console.log(`\n🎉 POC PASSED — ${MODEL} is viable for V2`);
  } else {
    console.log(`\n⚠️ POC FAILED — ${MODEL} pass rate ${Math.round(passRate*100)}% < 80%`);
    console.log('Consider: qwen2.5-coder:14b or deepseek-coder-v2:16b');
  }
}

main().catch(console.error);
```

**Step 3: Run the POC**
```bash
cd poc && npm install && npm test
```
Expected: >= 16/20 questions pass (80% threshold).

**Step 4: If POC fails, try 14B model**
```bash
ollama pull qwen2.5-coder:14b
# Edit MODEL constant in script, re-run
```

**Step 5: Commit POC results**
```bash
git add poc/
git commit -m "poc: validate Ollama SQL quality with 20 test questions"
```

**GATE: Do NOT proceed to Phase 1 until POC passes >= 80%. If no model passes, reassess the LLM strategy.**

---

## Phase 1: Monorepo Scaffold + Shared Package

> Set up the pnpm workspace and shared types/constants.

### Task 1.1: Initialize pnpm Monorepo

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`

**Step 1: Create workspace config**

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
```

```json
// package.json (root)
{
  "name": "sql-chatbot-v2",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "build:shared": "pnpm --filter @chatbot/shared build",
    "build:agent": "pnpm --filter @chatbot/agent build",
    "build:extension": "pnpm --filter @chatbot/extension build",
    "dev:agent": "pnpm --filter @chatbot/agent dev",
    "dev:extension": "pnpm --filter @chatbot/extension dev",
    "test": "pnpm -r test",
    "test:agent": "pnpm --filter @chatbot/agent test",
    "test:extension": "pnpm --filter @chatbot/extension test",
    "clean": "pnpm -r exec rm -rf dist node_modules"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

**Step 2: Create shared package**

```json
// packages/shared/package.json
{
  "name": "@chatbot/shared",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/shared/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create agent package skeleton**

```json
// packages/agent/package.json
{
  "name": "@chatbot/agent",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@chatbot/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.7.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/agent/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 4: Create extension package skeleton**

```json
// packages/extension/package.json
{
  "name": "@chatbot/extension",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "test": "vitest run"
  },
  "dependencies": {
    "@chatbot/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/extension/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

**Step 5: Install and verify**
```bash
pnpm install
pnpm build:shared  # Should succeed (empty, no src yet)
```

**Step 6: Commit**
```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json packages/
git commit -m "feat: initialize pnpm monorepo with shared/agent/extension packages"
```

---

### Task 1.2: Shared Types

**Files:**
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/api.ts`
- Create: `packages/shared/src/types/llm.ts`
- Create: `packages/shared/src/types/db.ts`
- Create: `packages/shared/src/types/messages.ts`
- Create: `packages/shared/src/index.ts`

**Step 1: Write type definitions**

```typescript
// packages/shared/src/types/llm.ts
// Question types from classifier (6 types — see design doc N7 fix)
export type QuestionType =
  | 'data'           // Simple SQL — schema is enough
  | 'data_with_code' // SQL but needs business logic from code first
  | 'code'           // Answer directly from code, no SQL needed
  | 'navigation'     // Where to find a page/feature
  | 'action'         // Fill form, click, navigate DOM
  | 'guidance';      // How-to, help, capabilities

export interface ClassifyResult {
  type: QuestionType;
  confidence: number;
}

export interface SQLResult {
  sql: string;
  explanation: string;
  confidence: number;
  needsExploration: boolean;
  explorationQuery?: string;
}

export interface LLMEngine {
  classify(question: string, context: ClassifyContext): Promise<ClassifyResult>;
  generateSQL(question: string, context: SQLContext): Promise<SQLResult>;
  streamAnswer(question: string, context: AnswerContext): AsyncIterable<string>;
  streamAnswerFromCode(question: string, context: CodeAnswerContext): AsyncIterable<string>;
  isReady(): Promise<boolean>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ClassifyContext {
  schemaSummary: string;
  pageContext?: string;
  history: ChatMessage[];
}

export interface SQLContext {
  schema: string;
  codeContext?: string;
  enums?: string;
  history: ChatMessage[];
  pageContext?: string;
}

export interface AnswerContext {
  question: string;
  sqlResults: string;
  questionType: QuestionType;
  history: ChatMessage[];
  pageContext?: string;
}

export interface CodeAnswerContext {
  question: string;
  codeChunks: CodeChunk[];
  history: ChatMessage[];
  pageContext?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CodeChunk {
  file: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}
```

```typescript
// packages/shared/src/types/api.ts
// Agent REST API request/response types

// Auth
export interface UnlockRequest {
  passphrase: string;
}

export interface UnlockResponse {
  sessionToken: string;
  expiresAt: string;
  extensionId: string;
}

export interface AuthStatusResponse {
  locked: boolean;
  configured: boolean;
  agentVersion: string;
}

// Setup
export interface ConfigureRequest {
  passphraseHash: string;
  encryptedDbUrl: string;
  encryptedGitToken?: string;
  salt: string;
  iv: string;
}

export interface RegisterExtensionRequest {
  extensionId: string;
}

// Database
export interface SchemaResponse {
  tables: TableSchema[];
  newSessionToken: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

export interface ForeignKeyInfo {
  column: string;
  referredTable: string;
  referredColumn: string;
}

export interface QueryRequest {
  sql: string;
}

export interface QueryResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  totalCount: number;
  executionTimeMs: number;
  newSessionToken: string;
}

// LLM
export interface ClassifyRequest {
  question: string;
  schemaSummary: string;
  pageContext?: string;
  history: { role: string; content: string }[];
}

export interface GenerateSQLRequest {
  question: string;
  schema: string;
  codeContext?: string;
  enums?: string;
  history: { role: string; content: string }[];
}

export interface AnswerRequest {
  question: string;
  sqlResults?: string;
  questionType: string;
  history: { role: string; content: string }[];
  pageContext?: string;
}

export interface AnswerFromCodeRequest {
  question: string;
  codeChunks: CodeChunk[];
  history: { role: string; content: string }[];
  pageContext?: string;
}

// Code
export interface CodeSearchRequest {
  query: string;
  limit?: number;
}

export interface CodeSearchResponse {
  results: CodeChunk[];
  newSessionToken: string;
}

// Discovery
export interface DiscoveryStatusResponse {
  schema: 'pending' | 'running' | 'completed' | 'failed';
  enums: 'pending' | 'running' | 'completed' | 'failed';
  code: 'pending' | 'running' | 'completed' | 'failed';
  tablesFound: number;
  enumsDetected: number;
  filesIndexed: number;
  newSessionToken: string;
}

export interface DiscoveryResultsResponse {
  schema: TableSchema[];
  enums: EnumMapping[];
  relationships: ForeignKeyInfo[];
  staleColumns: string[];
  businessTerms: BusinessTerm[];
  newSessionToken: string;
}

export interface EnumMapping {
  table: string;
  column: string;
  mappings: Record<string, string>;
  description?: string;
}

export interface BusinessTerm {
  term: string;
  meaning: string;
  tables: string[];
}

export interface DiscoveryOverrideRequest {
  type: 'enum' | 'relationship' | 'business_term';
  table: string;
  column?: string;
  corrections: Record<string, string>;
}
```

```typescript
// packages/shared/src/types/db.ts
export interface SqlValidationResult {
  isValid: boolean;
  modifiedSql: string;
  rejectionReason: string;
}

export interface SqlExecutionResult {
  success: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRowCount: number;
  executionTimeMs: number;
  error?: string;
}
```

```typescript
// packages/shared/src/types/messages.ts
// Chrome extension message types (content script <-> background worker)

export type MessageType =
  | 'CHAT_QUESTION'
  | 'CHAT_RESPONSE_CHUNK'
  | 'CHAT_RESPONSE_DONE'
  | 'CHAT_ERROR'
  | 'AGENT_STATUS'
  | 'CRAWL_START'
  | 'CRAWL_PROGRESS'
  | 'CRAWL_DONE'
  | 'ACTION_EXECUTE'
  | 'ACTION_RESULT'
  | 'PAGE_CONTEXT';

export interface ExtensionMessage {
  type: MessageType;
  payload: unknown;
}

export interface ChatQuestionPayload {
  question: string;
  conversationId: string;
  pageContext: PageContext;
}

export interface PageContext {
  url: string;
  title: string;
  heading?: string;
  navigation: NavItem[];
  breadcrumbs?: string[];
}

export interface NavItem {
  text: string;
  href: string;
  selector?: string;
  children?: NavItem[];
}

export interface CrawlProgressPayload {
  current: number;
  total: number;
  currentUrl: string;
}

export interface CrawledPage {
  url: string;
  title: string;
  navigation: NavItem[];
  forms: FormInfo[];
  buttons: ButtonInfo[];
  tables: TableInfo[];
  crawledAt: number;
  expiresAt: number;
}

export interface FormInfo {
  action?: string;
  fields: FormField[];
}

export interface FormField {
  label: string;
  selector: string;
  type: string;
  options?: string[];
  required: boolean;
}

export interface ButtonInfo {
  text: string;
  selector: string;
  actionType: 'read' | 'create' | 'destructive' | 'unknown';
}

export interface TableInfo {
  headers: string[];
  selector: string;
}
```

```typescript
// packages/shared/src/types/index.ts
export * from './llm.js';
export * from './api.js';
export * from './db.js';
export * from './messages.js';
```

```typescript
// packages/shared/src/index.ts
export * from './types/index.js';
```

**Step 2: Build and verify**
```bash
pnpm build:shared
# Expected: dist/ folder with .js and .d.ts files
```

**Step 3: Commit**
```bash
git add packages/shared/
git commit -m "feat(shared): add TypeScript types for API, LLM, DB, and extension messages"
```

---

### Task 1.3: Shared SQL Validator (Allowlist — Port from V1)

**Files:**
- Create: `packages/shared/src/sql-validator/index.ts`
- Create: `packages/shared/src/sql-validator/__tests__/sql-validator.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Modify: `packages/shared/package.json` (add dependency)
- Reference: `app/services/sql_validator.py` (V1 implementation)

This is the most security-critical shared code. V2 upgrades from V1's denylist to an **allowlist** approach using a SQL parser.

**Step 1: Add dependency**

Add to `packages/shared/package.json` dependencies:
```json
"node-sql-parser": "^5.3.0"
```

> Note: We use `node-sql-parser` (pure JS, PostgreSQL dialect, actively maintained) instead of `pg-query-parser` (N3 fix — verify during POC if a better option exists). `node-sql-parser` can parse PostgreSQL and give us an AST to walk.

**Step 2: Write the failing tests**

```typescript
// packages/shared/src/sql-validator/__tests__/sql-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateSQL } from '../index.js';

const SCHEMA = {
  contractors: ['id', 'first_name', 'last_name', 'status', 'email', 'created_at'],
  customers: ['id', 'first_name', 'last_name', 'status', 'email', 'created_at'],
  jobs: ['id', 'job_type_id', 'contractor_id', 'created_by', 'status', 'bid_amount', 'created_at'],
  job_types: ['id', 'title'],
  properties: ['id', 'service_area_id', 'address_line_1'],
  service_areas: ['id', 'title'],
};

describe('SQL Validator — Allowlist', () => {
  // Valid queries
  it('allows simple SELECT', () => {
    const result = validateSQL('SELECT COUNT(*) FROM contractors WHERE status = 1', SCHEMA);
    expect(result.isValid).toBe(true);
  });

  it('allows SELECT with JOIN', () => {
    const result = validateSQL(
      'SELECT c.first_name, COUNT(j.id) FROM contractors c JOIN jobs j ON c.id = j.contractor_id GROUP BY c.first_name',
      SCHEMA
    );
    expect(result.isValid).toBe(true);
  });

  it('allows SELECT with subquery', () => {
    const result = validateSQL(
      'SELECT * FROM contractors WHERE id IN (SELECT contractor_id FROM jobs WHERE status = 11)',
      SCHEMA
    );
    expect(result.isValid).toBe(true);
  });

  it('adds LIMIT 500 when no LIMIT present', () => {
    const result = validateSQL('SELECT * FROM contractors', SCHEMA);
    expect(result.isValid).toBe(true);
    expect(result.modifiedSql).toContain('LIMIT 500');
  });

  it('preserves existing LIMIT', () => {
    const result = validateSQL('SELECT * FROM contractors LIMIT 10', SCHEMA);
    expect(result.isValid).toBe(true);
    expect(result.modifiedSql).not.toContain('LIMIT 500');
  });

  // Blocked mutations
  it('rejects INSERT', () => {
    const result = validateSQL('INSERT INTO contractors (first_name) VALUES (\'hack\')', SCHEMA);
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toContain('Only SELECT');
  });

  it('rejects UPDATE', () => {
    const result = validateSQL('UPDATE contractors SET status = 3', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects DELETE', () => {
    const result = validateSQL('DELETE FROM contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects DROP', () => {
    const result = validateSQL('DROP TABLE contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects TRUNCATE', () => {
    const result = validateSQL('TRUNCATE contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Blocked via CTE mutation
  it('rejects CTE with INSERT', () => {
    const result = validateSQL(
      'WITH deleted AS (DELETE FROM contractors RETURNING *) SELECT * FROM deleted',
      SCHEMA
    );
    expect(result.isValid).toBe(false);
  });

  // Blocked SELECT INTO
  it('rejects SELECT INTO', () => {
    const result = validateSQL('SELECT * INTO new_table FROM contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Multiple statements
  it('rejects multiple statements', () => {
    const result = validateSQL('SELECT 1; DROP TABLE contractors;', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Dangerous functions
  it('rejects pg_read_file', () => {
    const result = validateSQL("SELECT pg_read_file('/etc/passwd')", SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects pg_sleep', () => {
    const result = validateSQL('SELECT pg_sleep(10)', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects dblink', () => {
    const result = validateSQL("SELECT * FROM dblink('host=evil', 'SELECT 1')", SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // System catalog access
  it('rejects pg_stat_activity', () => {
    const result = validateSQL('SELECT * FROM pg_stat_activity', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects information_schema', () => {
    const result = validateSQL('SELECT * FROM information_schema.tables', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Excluded tables
  it('rejects queries on excluded tables', () => {
    const result = validateSQL('SELECT * FROM contractors', SCHEMA, { excludeTables: ['contractors'] });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toContain('excluded');
  });
});
```

**Step 3: Run tests to verify they fail**
```bash
cd packages/shared && pnpm test
# Expected: all tests fail (module not found)
```

**Step 4: Implement the validator**

```typescript
// packages/shared/src/sql-validator/index.ts
import { Parser } from 'node-sql-parser';
import type { SqlValidationResult } from '../types/db.js';

const MAX_LIMIT = 500;

const BLOCKED_FUNCTIONS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export',
  'dblink', 'dblink_exec',
  'pg_sleep', 'pg_sleep_for',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'current_setting',
]);

const BLOCKED_SYSTEM_TABLES = new Set([
  'pg_stat_activity', 'pg_roles', 'pg_shadow', 'pg_authid',
  'pg_user', 'pg_group',
]);

interface ValidateOptions {
  excludeTables?: string[];
}

export function validateSQL(
  sql: string,
  schema: Record<string, string[]>,
  options: ValidateOptions = {}
): SqlValidationResult {
  const result: SqlValidationResult = { isValid: false, modifiedSql: '', rejectionReason: '' };
  const sqlTrimmed = sql.trim().replace(/;+$/, '');

  // Layer 1: Parse with node-sql-parser (PostgreSQL dialect)
  const parser = new Parser();
  let ast;
  try {
    ast = parser.astify(sqlTrimmed, { database: 'PostgresQL' });
  } catch (e: any) {
    result.rejectionReason = `SQL parse error: ${e.message}`;
    return result;
  }

  // Layer 2: Must be a single statement
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    result.rejectionReason = 'Multiple statements detected. Only single SELECT allowed.';
    return result;
  }

  const stmt = statements[0];

  // Layer 3: ALLOWLIST — must be SELECT (not insert/update/delete/create/drop/alter/truncate)
  if (stmt.type !== 'select') {
    result.rejectionReason = `Only SELECT statements allowed. Got: ${stmt.type?.toUpperCase()}`;
    return result;
  }

  // Layer 4: Walk AST to check for blocked patterns
  const sqlLower = sqlTrimmed.toLowerCase();

  // Check for SELECT INTO
  if (/\binto\s+\w+/i.test(sqlTrimmed) && /\bselect\b.*\binto\b/i.test(sqlTrimmed)) {
    result.rejectionReason = 'SELECT INTO not allowed';
    return result;
  }

  // Check for CTE mutations (WITH ... DELETE/INSERT/UPDATE)
  if (/\bwith\b/i.test(sqlTrimmed)) {
    if (/\b(insert|update|delete|truncate|drop|create|alter)\b/i.test(sqlTrimmed)) {
      result.rejectionReason = 'CTE with mutation (INSERT/UPDATE/DELETE) not allowed';
      return result;
    }
  }

  // Layer 5: Blocked functions
  for (const func of BLOCKED_FUNCTIONS) {
    if (sqlLower.includes(func)) {
      result.rejectionReason = `Blocked function: ${func}`;
      return result;
    }
  }

  // Layer 6: System catalog access
  for (const table of BLOCKED_SYSTEM_TABLES) {
    if (sqlLower.includes(table)) {
      result.rejectionReason = `Blocked system catalog: ${table}`;
      return result;
    }
  }
  if (sqlLower.includes('information_schema')) {
    result.rejectionReason = 'Blocked system catalog: information_schema';
    return result;
  }

  // Layer 7: Excluded tables
  const excludeSet = new Set((options.excludeTables || []).map(t => t.toLowerCase()));
  if (excludeSet.size > 0) {
    // Extract table names from the SQL (simple regex approach for FROM/JOIN)
    const tablePattern = /(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
    let match;
    while ((match = tablePattern.exec(sqlTrimmed)) !== null) {
      if (excludeSet.has(match[1].toLowerCase())) {
        result.rejectionReason = `Table '${match[1]}' is excluded from queries`;
        return result;
      }
    }
  }

  // Layer 8: Add LIMIT if missing
  let modifiedSql = sqlTrimmed;
  if (!/\blimit\b/i.test(sqlTrimmed)) {
    modifiedSql = `${sqlTrimmed} LIMIT ${MAX_LIMIT}`;
  }

  result.isValid = true;
  result.modifiedSql = modifiedSql;
  return result;
}
```

**Step 5: Update shared index to re-export**

```typescript
// packages/shared/src/index.ts
export * from './types/index.js';
export { validateSQL } from './sql-validator/index.js';
```

**Step 6: Run tests**
```bash
cd packages/shared && pnpm test
# Expected: all tests pass
```

**Step 7: Commit**
```bash
git add packages/shared/
git commit -m "feat(shared): add SQL allowlist validator with 19 tests (port from V1 denylist)"
```

---

### Task 1.4: Shared Constants

**Files:**
- Create: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

**Step 1: Write constants**

```typescript
// packages/shared/src/constants.ts
export const AGENT_PORT = 9876;
export const AGENT_HOST = '127.0.0.1';
export const AGENT_BASE_URL = `http://${AGENT_HOST}:${AGENT_PORT}`;

export const SESSION_TOKEN_EXPIRY_HOURS = 4;
export const SESSION_TOKEN_GRACE_SECONDS = 5; // N1 fix: parallel request support
export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_REQUEST_BODY_KB = 10;
export const MAX_SQL_ROWS = 500;
export const MAX_HISTORY_MESSAGES = 10;

export const CHAT_HISTORY_RETENTION_DAYS = 7;
export const CRAWL_EXPIRY_DAYS = 30;

export const DEFAULT_LLM_PROVIDER = 'openai';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const AGENT_DATA_DIR = '.chatbot-agent';
export const VAULT_FILE = 'vault.enc';
export const CODE_INDEX_DB = 'code-index.db';
export const DISCOVERY_DB = 'discovery.db';
export const LOG_FILE = 'agent.log';
export const LOG_MAX_SIZE_MB = 50;

// Indexed file types (code understanding)
export const INDEXED_EXTENSIONS = new Set([
  '.rb', '.py', '.js', '.ts', '.go', '.java', '.php', '.ex', '.rs', '.cs',
  '.erb', '.html', '.jsx', '.tsx', '.vue', '.blade.php', '.ejs', '.hbs',
  '.sql', '.graphql',
  '.md',
]);

// Never index these files/dirs
export const EXCLUDED_PATHS = [
  '.env', '.env.*', '*.env',
  'credentials.*', 'secrets.*', 'master.key', 'config/master.key',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.cert', '*.crt',
  'id_rsa', 'id_ed25519', 'authorized_keys', 'known_hosts',
  '.git/', 'node_modules/', 'vendor/', 'venv/', '__pycache__/', '.bundle/',
  '*.log', '*.lock', 'package-lock.json', 'yarn.lock',
  'docker-compose*.yml',
  'database.yml', 'database.yml.enc',
  '*.sqlite3', '*.db',
];

// Content patterns that indicate secrets (reject files containing these)
export const SECRET_PATTERNS = [
  /password\s*=/i, /api_key\s*=/i, /secret_key\s*=/i,
  /private_key\s*=/i, /access_token\s*=/i,
  /AWS_SECRET/i, /STRIPE_SECRET/i, /GITHUB_TOKEN/i,
  /BEGIN RSA PRIVATE KEY/, /BEGIN OPENSSH PRIVATE KEY/,
  /connection_string\s*=/i, /DATABASE_URL\s*=/i,
];

// PII column patterns (never sample values from these)
export const PII_COLUMN_PATTERNS = [
  'email', 'phone', 'address', 'first_name', 'last_name', 'name',
  'dob', 'date_of_birth', 'ssn', 'ip_address', 'password', 'token',
  'secret', 'salt', 'bank', 'card', 'stripe',
];
```

**Step 2: Re-export**
```typescript
// packages/shared/src/index.ts — add line:
export * from './constants.js';
```

**Step 3: Build and commit**
```bash
pnpm build:shared
git add packages/shared/
git commit -m "feat(shared): add constants for agent config, file indexing, and security patterns"
```

---

## Phase 2: Agent Core — Vault + Auth + Server

> Build the agent's security foundation: encrypted vault, session tokens, Fastify server.

### Task 2.1: Encrypted Vault (Argon2id + AES-256-GCM)

**Files:**
- Create: `packages/agent/src/vault/index.ts`
- Create: `packages/agent/src/vault/__tests__/vault.test.ts`
- Modify: `packages/agent/package.json` (add argon2 dependency)

**Step 1: Add dependencies**

Add to `packages/agent/package.json`:
```json
"dependencies": {
  "@chatbot/shared": "workspace:*",
  "argon2": "^0.41.0"
}
```

**Step 2: Write failing tests**

```typescript
// packages/agent/src/vault/__tests__/vault.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../index.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Vault', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('configure stores encrypted vault and unlock decrypts it', async () => {
    const vault = new Vault(dataDir);

    // Configure with passphrase and secrets
    await vault.configure('test-passphrase-123', {
      dbUrl: 'postgresql://reader:pass@localhost/mydb',
      gitToken: 'ghp_abc123',
    });

    expect(vault.isConfigured()).toBe(true);
    expect(vault.isUnlocked()).toBe(false);

    // Unlock with correct passphrase
    await vault.unlock('test-passphrase-123');
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.getSecret('dbUrl')).toBe('postgresql://reader:pass@localhost/mydb');
    expect(vault.getSecret('gitToken')).toBe('ghp_abc123');
  });

  it('rejects wrong passphrase on unlock', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('correct-pass', { dbUrl: 'postgresql://a:b@c/d' });

    await expect(vault.unlock('wrong-pass')).rejects.toThrow();
    expect(vault.isUnlocked()).toBe(false);
  });

  it('lock wipes secrets from memory', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('pass123', { dbUrl: 'postgresql://a:b@c/d' });
    await vault.unlock('pass123');
    expect(vault.getSecret('dbUrl')).toBe('postgresql://a:b@c/d');

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.getSecret('dbUrl')).toThrow();
  });

  it('persists across instances', async () => {
    const vault1 = new Vault(dataDir);
    await vault1.configure('persist-test', { dbUrl: 'postgresql://x:y@z/db' });

    // New instance, same dir
    const vault2 = new Vault(dataDir);
    expect(vault2.isConfigured()).toBe(true);
    await vault2.unlock('persist-test');
    expect(vault2.getSecret('dbUrl')).toBe('postgresql://x:y@z/db');
  });

  it('handles optional gitToken', async () => {
    const vault = new Vault(dataDir);
    await vault.configure('pass', { dbUrl: 'postgresql://a:b@c/d' });
    await vault.unlock('pass');
    expect(vault.getSecret('gitToken')).toBeUndefined();
  });
});
```

**Step 3: Run tests to verify they fail**
```bash
cd packages/agent && pnpm test
```

**Step 4: Implement vault**

```typescript
// packages/agent/src/vault/index.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import { VAULT_FILE } from '@chatbot/shared';

interface VaultData {
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encrypted: Buffer;
  passphraseHash: string;
}

interface Secrets {
  dbUrl: string;
  gitToken?: string;
}

export class Vault {
  private dataDir: string;
  private vaultPath: string;
  private secrets: Secrets | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.vaultPath = join(dataDir, VAULT_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  isConfigured(): boolean {
    return existsSync(this.vaultPath);
  }

  isUnlocked(): boolean {
    return this.secrets !== null;
  }

  async configure(passphrase: string, secrets: Secrets): Promise<void> {
    // Derive encryption key via Argon2id
    const salt = randomBytes(32);
    const key = await this.deriveKey(passphrase, salt);

    // Also store passphrase hash for verification on unlock
    const passphraseHash = await argon2.hash(passphrase, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // Encrypt secrets with AES-256-GCM
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(secrets);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Store vault
    const vaultData: VaultData = { salt, iv, authTag, encrypted, passphraseHash };
    writeFileSync(this.vaultPath, JSON.stringify({
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encrypted: encrypted.toString('base64'),
      passphraseHash,
    }));
  }

  async unlock(passphrase: string): Promise<void> {
    if (!this.isConfigured()) throw new Error('Vault not configured');

    const raw = JSON.parse(readFileSync(this.vaultPath, 'utf8'));
    const salt = Buffer.from(raw.salt, 'base64');
    const iv = Buffer.from(raw.iv, 'base64');
    const authTag = Buffer.from(raw.authTag, 'base64');
    const encrypted = Buffer.from(raw.encrypted, 'base64');

    // Verify passphrase
    const valid = await argon2.verify(raw.passphraseHash, passphrase);
    if (!valid) throw new Error('Invalid passphrase');

    // Derive key and decrypt
    const key = await this.deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

    this.secrets = JSON.parse(plaintext);
  }

  lock(): void {
    this.secrets = null;
  }

  getSecret(key: keyof Secrets): string | undefined {
    if (!this.secrets) throw new Error('Vault is locked');
    return this.secrets[key];
  }

  private async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    // Use Argon2id raw hash as AES key (32 bytes = 256 bits)
    return argon2.hash(passphrase, {
      type: argon2.argon2id,
      salt,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      raw: true,
      hashLength: 32,
    }) as unknown as Buffer;
  }
}
```

**Step 5: Run tests**
```bash
cd packages/agent && pnpm test
# Expected: all 5 tests pass
```

**Step 6: Commit**
```bash
git add packages/agent/
git commit -m "feat(agent): add encrypted vault with Argon2id + AES-256-GCM"
```

---

### Task 2.2: Session Token Manager

**Files:**
- Create: `packages/agent/src/auth/session.ts`
- Create: `packages/agent/src/auth/__tests__/session.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/agent/src/auth/__tests__/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('creates a session token', () => {
    const session = manager.createSession('chrome-extension://abc123');
    expect(session.token).toHaveLength(64); // hex string
    expect(session.extensionId).toBe('chrome-extension://abc123');
    expect(session.expiresAt).toBeInstanceOf(Date);
  });

  it('validates a valid token', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(true);
  });

  it('rotates token on validate, old token valid for grace period', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const oldToken = session.token;

    const result = manager.validate(oldToken, 'chrome-extension://abc123');
    expect(result.valid).toBe(true);
    expect(result.newToken).toBeDefined();
    expect(result.newToken).not.toBe(oldToken);

    // Old token still valid within grace period (5s)
    const graceResult = manager.validate(oldToken, 'chrome-extension://abc123');
    expect(graceResult.valid).toBe(true);
  });

  it('rejects wrong origin', () => {
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://wrong');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('origin');
  });

  it('rejects expired token', () => {
    const manager = new SessionManager(0); // 0 hours = immediate expiry
    const session = manager.createSession('chrome-extension://abc123');
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('invalidateAll clears all sessions', () => {
    const session = manager.createSession('chrome-extension://abc123');
    manager.invalidateAll();
    const result = manager.validate(session.token, 'chrome-extension://abc123');
    expect(result.valid).toBe(false);
  });
});
```

**Step 3: Implement**

```typescript
// packages/agent/src/auth/session.ts
import { randomBytes } from 'node:crypto';
import { SESSION_TOKEN_EXPIRY_HOURS, SESSION_TOKEN_GRACE_SECONDS } from '@chatbot/shared';

interface Session {
  token: string;
  extensionId: string;
  expiresAt: Date;
  createdAt: Date;
}

interface GracedToken {
  token: string;
  expiresAt: Date; // grace window expiry
}

interface ValidateResult {
  valid: boolean;
  newToken?: string;
  reason?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>(); // token -> session
  private gracedTokens = new Map<string, GracedToken>(); // old token -> grace info
  private expiryHours: number;

  constructor(expiryHours: number = SESSION_TOKEN_EXPIRY_HOURS) {
    this.expiryHours = expiryHours;
  }

  createSession(extensionId: string): Session {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.expiryHours * 3600_000);
    const session: Session = { token, extensionId, expiresAt, createdAt: now };
    this.sessions.set(token, session);
    return session;
  }

  validate(token: string, origin: string): ValidateResult {
    // Check active sessions first
    let session = this.sessions.get(token);
    let fromGrace = false;

    // If not in active, check graced tokens
    if (!session) {
      const graced = this.gracedTokens.get(token);
      if (graced && graced.expiresAt > new Date()) {
        // Find the session that replaced this token
        // The graced token maps to the same extension, find any active session for that extension
        for (const s of this.sessions.values()) {
          if (s.extensionId === origin) {
            session = s;
            fromGrace = true;
            break;
          }
        }
      }
      if (!session) {
        return { valid: false, reason: 'Invalid or expired token' };
      }
    }

    // Verify origin
    if (session.extensionId !== origin) {
      return { valid: false, reason: 'Invalid origin — token bound to different extension' };
    }

    // Check expiry
    if (session.expiresAt <= new Date()) {
      this.sessions.delete(session.token);
      return { valid: false, reason: 'Token expired' };
    }

    // Rotate: issue new token, grace the old one
    if (!fromGrace) {
      const oldToken = session.token;
      const newToken = randomBytes(32).toString('hex');

      // Remove old, add new
      this.sessions.delete(oldToken);
      const newSession: Session = {
        token: newToken,
        extensionId: session.extensionId,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      };
      this.sessions.set(newToken, newSession);

      // Grace the old token
      this.gracedTokens.set(oldToken, {
        token: oldToken,
        expiresAt: new Date(Date.now() + SESSION_TOKEN_GRACE_SECONDS * 1000),
      });

      // Cleanup expired graced tokens
      this.cleanupGraced();

      return { valid: true, newToken };
    }

    // From grace — return current active token
    return { valid: true, newToken: session.token };
  }

  invalidateAll(): void {
    this.sessions.clear();
    this.gracedTokens.clear();
  }

  private cleanupGraced(): void {
    const now = new Date();
    for (const [token, graced] of this.gracedTokens) {
      if (graced.expiresAt <= now) {
        this.gracedTokens.delete(token);
      }
    }
  }
}
```

**Step 4: Run tests, commit**
```bash
cd packages/agent && pnpm test
git add packages/agent/src/auth/
git commit -m "feat(agent): add session token manager with rotation and 5s grace window"
```

---

### Task 2.3: Fastify Server Skeleton + Auth Middleware

**Files:**
- Create: `packages/agent/src/server.ts`
- Create: `packages/agent/src/routes/auth.ts`
- Create: `packages/agent/src/routes/setup.ts`
- Create: `packages/agent/src/middleware/auth.ts`
- Create: `packages/agent/src/middleware/rate-limit.ts`
- Modify: `packages/agent/package.json` (add fastify)

**Step 1: Add dependencies**
```json
// packages/agent/package.json dependencies:
"fastify": "^5.2.0",
"@fastify/cors": "^10.0.0",
"@fastify/rate-limit": "^10.0.0"
```

**Step 2: Create server entry point**

```typescript
// packages/agent/src/server.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AGENT_HOST, AGENT_PORT, RATE_LIMIT_PER_MINUTE } from '@chatbot/shared';
import { Vault } from './vault/index.js';
import { SessionManager } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { authMiddleware } from './middleware/auth.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.chatbot-agent');

export async function buildServer() {
  const vault = new Vault(DATA_DIR);
  const sessionManager = new SessionManager();

  const server = Fastify({ logger: true });

  // CORS: only allow chrome-extension:// origins
  await server.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin.startsWith('chrome-extension://')) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed'), false);
      }
    },
  });

  // Rate limiting
  await server.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
  });

  // Decorate with shared state
  server.decorate('vault', vault);
  server.decorate('sessionManager', sessionManager);

  // Public routes (no auth required)
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(setupRoutes, { prefix: '/setup' });

  // Protected routes (added in later tasks)
  // server.register(dbRoutes, { prefix: '/db' });
  // server.register(llmRoutes, { prefix: '/llm' });
  // server.register(codeRoutes, { prefix: '/code' });
  // server.register(discoveryRoutes, { prefix: '/discovery' });

  return server;
}

// Start server if run directly
const server = await buildServer();
server.listen({ host: AGENT_HOST, port: AGENT_PORT }, (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  console.log(`Agent listening on ${address}`);
});
```

**Step 3: Create auth routes**

```typescript
// packages/agent/src/routes/auth.ts
import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (server) => {
  // GET /auth/status — no auth required
  server.get('/status', async () => {
    const vault = (server as any).vault;
    return {
      locked: !vault.isUnlocked(),
      configured: vault.isConfigured(),
      agentVersion: '2.0.0',
    };
  });

  // POST /auth/unlock
  server.post<{ Body: { passphrase: string } }>('/unlock', async (request, reply) => {
    const vault = (server as any).vault;
    const sessionManager = (server as any).sessionManager;
    const { passphrase } = request.body;

    if (!vault.isConfigured()) {
      return reply.status(400).send({ error: 'Agent not configured. Visit /setup first.' });
    }

    try {
      await vault.unlock(passphrase);
    } catch {
      return reply.status(401).send({ error: 'Invalid passphrase' });
    }

    const origin = request.headers.origin || '';
    const session = sessionManager.createSession(origin);

    return {
      sessionToken: session.token,
      expiresAt: session.expiresAt.toISOString(),
      extensionId: origin,
    };
  });

  // POST /auth/lock
  server.post('/lock', async (request, reply) => {
    const vault = (server as any).vault;
    const sessionManager = (server as any).sessionManager;
    vault.lock();
    sessionManager.invalidateAll();
    return { locked: true };
  });
};
```

**Step 4: Create auth middleware**

```typescript
// packages/agent/src/middleware/auth.ts
import type { FastifyRequest, FastifyReply } from 'fastify';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const sessionManager = (request.server as any).sessionManager;
  const token = request.headers['x-session-token'] as string;
  const origin = request.headers.origin || '';

  if (!token) {
    return reply.status(401).send({ error: 'Missing X-Session-Token header' });
  }

  const result = sessionManager.validate(token, origin);
  if (!result.valid) {
    return reply.status(401).send({ error: result.reason });
  }

  // Attach new token to response
  (request as any).newSessionToken = result.newToken;
}
```

**Step 5: Build and test server starts**
```bash
cd packages/agent && pnpm build
# Start briefly to verify
timeout 3 pnpm start || true
# Expected: "Agent listening on http://127.0.0.1:9876"
```

**Step 6: Commit**
```bash
git add packages/agent/
git commit -m "feat(agent): add Fastify server with auth routes, CORS, and rate limiting"
```

---

## Phase 3: Agent — Database Module

### Task 3.1: PostgreSQL Connection + Schema Inspector

**Files:**
- Create: `packages/agent/src/db/connection.ts`
- Create: `packages/agent/src/db/schema-inspector.ts`
- Create: `packages/agent/src/db/sql-executor.ts`
- Create: `packages/agent/src/db/__tests__/sql-executor.test.ts`
- Create: `packages/agent/src/routes/db.ts`
- Modify: `packages/agent/package.json` (add pg)
- Reference: `app/services/schema_inspector.py`, `app/services/sql_executor.py` (V1)

Port V1's schema inspection and SQL execution to Node.js with `pg`.

**Step 1: Add dependency**
```json
"pg": "^8.13.0",
"@types/pg": "^8.11.0"
```

**Step 2: Implement DB connection**

```typescript
// packages/agent/src/db/connection.ts
import pg from 'pg';

let pool: pg.Pool | null = null;

export function createPool(connectionString: string): pg.Pool {
  pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialized');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

**Step 3: Implement schema inspector**

```typescript
// packages/agent/src/db/schema-inspector.ts
// Port of V1: app/services/schema_inspector.py
import type pg from 'pg';
import type { TableSchema, ColumnInfo, ForeignKeyInfo } from '@chatbot/shared';
import { PII_COLUMN_PATTERNS } from '@chatbot/shared';

const SENSITIVE_COLUMN_PATTERNS = [
  'password', 'pwd', 'token', 'secret', 'ssn', 'api_key', 'salt',
  'encr_', 'stripe_', 'bank_',
];

function isSensitiveColumn(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_COLUMN_PATTERNS.some(p => lower.includes(p));
}

export async function inspectSchema(pool: pg.Pool): Promise<TableSchema[]> {
  const client = await pool.connect();
  try {
    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name, obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass) as comment
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables: TableSchema[] = [];

    for (const tableRow of tablesResult.rows) {
      const tableName = tableRow.table_name;

      // Get columns
      const colsResult = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default,
          col_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, ordinal_position) as comment
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      const columns: ColumnInfo[] = colsResult.rows
        .filter(c => !isSensitiveColumn(c.column_name))
        .map(c => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: false, // filled below
          comment: c.comment || undefined,
        }));

      // Get primary keys
      const pkResult = await client.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
      `, [tableName]);
      const pkColumns = new Set(pkResult.rows.map(r => r.attname));
      for (const col of columns) {
        col.isPrimaryKey = pkColumns.has(col.name);
      }

      // Get foreign keys
      const fkResult = await client.query(`
        SELECT
          kcu.column_name,
          ccu.table_name AS referred_table,
          ccu.column_name AS referred_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
      `, [tableName]);

      const foreignKeys: ForeignKeyInfo[] = fkResult.rows.map(r => ({
        column: r.column_name,
        referredTable: r.referred_table,
        referredColumn: r.referred_column,
      }));

      tables.push({
        name: tableName,
        columns,
        primaryKeys: Array.from(pkColumns),
        foreignKeys,
        comment: tableRow.comment || undefined,
      });
    }

    return tables;
  } finally {
    client.release();
  }
}

export function formatSchemaForPrompt(tables: TableSchema[]): string {
  return tables.map(t => {
    const cols = t.columns.map(c => c.name).join(', ');
    return `TABLE ${t.name} (${cols})`;
  }).join('\n');
}
```

**Step 4: Implement SQL executor**

```typescript
// packages/agent/src/db/sql-executor.ts
// Port of V1: app/services/sql_executor.py
import type pg from 'pg';
import type { SqlExecutionResult } from '@chatbot/shared';
import { validateSQL } from '@chatbot/shared';
import { MAX_SQL_ROWS } from '@chatbot/shared';

export async function executeSQL(
  pool: pg.Pool,
  sql: string,
  schema: Record<string, string[]>
): Promise<SqlExecutionResult> {
  // Validate first (agent is authoritative)
  const validation = validateSQL(sql, schema);
  if (!validation.isValid) {
    return {
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: 0,
      error: `SQL validation failed: ${validation.rejectionReason}`,
    };
  }

  const start = performance.now();
  const client = await pool.connect();
  try {
    // Defense-in-depth: read-only transaction
    await client.query('SET TRANSACTION READ ONLY');
    const result = await client.query(validation.modifiedSql);
    const elapsed = performance.now() - start;

    const columns = result.fields.map(f => f.name);
    const rows = result.rows.slice(0, MAX_SQL_ROWS);

    return {
      success: true,
      columns,
      rows,
      totalRowCount: result.rowCount || 0,
      executionTimeMs: Math.round(elapsed * 100) / 100,
    };
  } catch (e: any) {
    const elapsed = performance.now() - start;
    return {
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: Math.round(elapsed * 100) / 100,
      error: e.message,
    };
  } finally {
    client.release();
  }
}
```

**Step 5: Create DB routes**

```typescript
// packages/agent/src/routes/db.ts
import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { inspectSchema, formatSchemaForPrompt } from '../db/schema-inspector.js';
import { executeSQL } from '../db/sql-executor.js';
import { getPool } from '../db/connection.js';

export const dbRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  server.get('/schema', async (request) => {
    const pool = getPool();
    const tables = await inspectSchema(pool);
    return { tables, newSessionToken: (request as any).newSessionToken };
  });

  server.post<{ Body: { sql: string } }>('/query', async (request) => {
    const pool = getPool();
    // Build schema map for validation
    const tables = await inspectSchema(pool);
    const schemaMap: Record<string, string[]> = {};
    for (const t of tables) {
      schemaMap[t.name] = t.columns.map(c => c.name);
    }
    const result = await executeSQL(pool, request.body.sql, schemaMap);
    return { ...result, newSessionToken: (request as any).newSessionToken };
  });

  server.get('/health', async (request) => {
    const pool = getPool();
    const start = performance.now();
    try {
      await pool.query('SELECT 1');
      return {
        connected: true,
        latencyMs: Math.round(performance.now() - start),
        newSessionToken: (request as any).newSessionToken,
      };
    } catch {
      return { connected: false, latencyMs: 0, newSessionToken: (request as any).newSessionToken };
    }
  });
};
```

**Step 6: Commit**
```bash
git add packages/agent/src/db/ packages/agent/src/routes/db.ts
git commit -m "feat(agent): add PostgreSQL connection, schema inspector, and SQL executor"
```

---

## Phase 4: Agent — OpenAI LLM Proxy Module

### Task 4.1: OpenAI Client + LLM Routes

**Files:**
- Create: `packages/agent/src/llm/openai-engine.ts`
- Create: `packages/agent/src/llm/prompts.ts`
- Create: `packages/agent/src/routes/llm.ts`
- Reference: `app/services/llm_service.py` (V1 system prompts)

Port V1 system prompts to work with OpenAI's API via the `openai` npm package. The agent decrypts the API key from the vault and proxies all LLM calls. Extension never sees the key.

**Step 1: Port system prompts**

```typescript
// packages/agent/src/llm/prompts.ts
// Ported from V1: app/services/llm_service.py lines 16-248
// Uses OpenAI GPT-4o-mini via agent proxy (key from encrypted vault)

export function buildClassifyPrompt(params: {
  question: string;
  schemaSummary: string;
  pageContext: string;
  history: { role: string; content: string }[];
}): string {
  return `You are a question classifier for an admin panel chatbot.
Classify the following question into exactly one type.

Types:
- "data": Question answerable by querying the database (counts, lists, reports, lookups)
- "data_with_code": Question that needs both database AND business logic from code (e.g., "what is net sales?" needs the formula)
- "code": Question about how the app works, business logic, architecture — answered from code, NO SQL needed
- "navigation": Question about where to find a page/feature in the admin panel
- "action": Request to fill forms, click buttons, navigate the UI
- "guidance": How-to, help, what can you do

DEFAULT TO "data" when unsure. Most admin questions want real answers from the database.

## Database Schema Summary
${params.schemaSummary}

## Current Page Context
${params.pageContext || '(none)'}

Respond with ONLY a JSON object: {"type": "<type>", "confidence": <0.0-1.0>}

Question: ${params.question}`;
}

export function buildSQLPrompt(params: {
  question: string;
  schema: string;
  codeContext: string;
  enums: string;
  knowledgeText: string;
  currentDatetime: string;
}): string {
  // Adapted from V1 SYSTEM_PROMPT_TEMPLATE (lines 16-123)
  return `You are a SQL assistant for an admin panel. Generate a safe, read-only PostgreSQL SELECT query.
Current date and time: ${params.currentDatetime}

## Database Schema
${params.schema}

## Enum Mappings
${params.enums || '(none discovered yet)'}

## Business Logic from Code
${params.codeContext || '(no code context)'}

## Knowledge Base
${params.knowledgeText || '(no knowledge base)'}

## CRITICAL SQL Rules:
- Generate ONLY a single SELECT statement
- ALWAYS JOIN related tables for names (never return raw IDs)
- ALWAYS use CASE expressions to convert integer enums to labels
- NEVER use stale cache columns (completed_jobs, completed_jobs_count, total_earned) — JOIN and COUNT/SUM instead
- Exclude status=3 (Deleted) by default unless explicitly asked
- jobs.created_by is the FK to customers (NOT customer_id)
- For date queries, use the current datetime above

Respond with ONLY a JSON object:
{"sql": "<the SQL query>", "explanation": "<brief explanation>", "confidence": <0.0-1.0>}

Question: ${params.question}`;
}

export function buildAnswerPrompt(params: {
  question: string;
  sqlResults: string;
  currentDatetime: string;
  pageContext: string;
}): string {
  // Adapted from V1 stream_answer data prompt (lines 187-204)
  return `You are a helpful admin assistant. The user asked a data question.
Below are the SQL query results. Summarize them clearly and concisely.
Current date and time: ${params.currentDatetime}

## Current Page Context
${params.pageContext || '(none)'}

## Query Results
${params.sqlResults}

## Rules:
- CRITICAL: Trust the query results. If rows > 0, data EXISTS. NEVER say "there are none" when rows were returned.
- Give a direct, human-friendly answer — e.g. "There are 40,379 customers"
- NEVER mention SQL queries, column names, table names, or database internals
- Use business language: say "active" not "status = 1"
- Keep answers to 1-3 sentences unless data warrants more detail

Answer the question:`;
}

export function buildCodeAnswerPrompt(params: {
  question: string;
  codeChunks: { file: string; content: string }[];
  currentDatetime: string;
  pageContext: string;
}): string {
  const codeText = params.codeChunks
    .map(c => `### ${c.file}\n\`\`\`\n${c.content}\n\`\`\``)
    .join('\n\n');

  return `You are a helpful admin assistant. The user asked a question about how the application works.
Below are relevant code snippets from the codebase. Explain the logic clearly.
Current date and time: ${params.currentDatetime}

## Current Page Context
${params.pageContext || '(none)'}

## Relevant Code
${codeText || '(no code found)'}

## Rules:
- Explain in plain business language the admin understands
- Reference the source files for transparency
- If the code doesn't answer the question, say so
- NEVER expose credentials, secrets, or internal server paths
- Keep the explanation concise but complete

Question: ${params.question}`;
}

export function buildGuidancePrompt(params: {
  question: string;
  pageContext: string;
  knowledgeText: string;
}): string {
  // Adapted from V1 stream_answer guidance prompt (lines 207-232)
  return `You are a helpful admin assistant embedded in an admin panel.
The user asked a guidance question. Help them navigate or understand the system.

## Your Capabilities
- Search the database — "how many active contractors?", "show me cancelled jobs"
- Generate reports — "top 10 contractors", "jobs by type"
- Help navigate — "where do I add a new job?"
- Troubleshoot — "why is this contractor suspended?"
- READ-ONLY — cannot create, update, or delete anything

## Current Page Context
${params.pageContext || '(none)'}

## Knowledge Base
${params.knowledgeText || '(none)'}

## Rules:
- Reference SPECIFIC pages and URLs from the page context navigation
- NEVER hallucinate pages that don't exist
- NEVER mention database internals (column names, status codes, SQL)
- Speak in plain business language
- If you don't know, say so

Question: ${params.question}`;
}
```

**Step 2: Implement OpenAI engine**

```typescript
// packages/agent/src/llm/openai-engine.ts
import OpenAI from 'openai';
import { DEFAULT_OPENAI_MODEL } from '@chatbot/shared';
import type { ClassifyResult, SQLResult, QuestionType } from '@chatbot/shared';
import {
  buildClassifyPrompt,
  buildSQLPrompt,
  buildAnswerPrompt,
  buildCodeAnswerPrompt,
  buildGuidancePrompt,
} from './prompts.js';

export class OpenAIEngine {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = DEFAULT_OPENAI_MODEL) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.models.retrieve(this.model);
      return true;
    } catch {
      return false;
    }
  }

  async classify(question: string, context: {
    schemaSummary: string;
    pageContext?: string;
    history: { role: string; content: string }[];
  }): Promise<ClassifyResult> {
    const prompt = buildClassifyPrompt({
      question,
      schemaSummary: context.schemaSummary,
      pageContext: context.pageContext || '',
      history: context.history,
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    try {
      const json = JSON.parse(response.choices[0].message.content || '{}');
      return {
        type: json.type as QuestionType,
        confidence: json.confidence || 0.8,
      };
    } catch {
      return { type: 'data', confidence: 0.5 };
    }
  }

  async generateSQL(question: string, context: {
    schema: string;
    codeContext?: string;
    enums?: string;
    knowledgeText?: string;
    history: { role: string; content: string }[];
  }): Promise<SQLResult> {
    const prompt = buildSQLPrompt({
      question,
      schema: context.schema,
      codeContext: context.codeContext || '',
      enums: context.enums || '',
      knowledgeText: context.knowledgeText || '',
      currentDatetime: new Date().toISOString(),
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    try {
      const json = JSON.parse(response.choices[0].message.content || '{}');
      return {
        sql: json.sql,
        explanation: json.explanation || '',
        confidence: json.confidence || 0.8,
        needsExploration: false,
      };
    } catch {
      return {
        sql: '',
        explanation: 'Failed to parse response',
        confidence: 0.3,
        needsExploration: false,
      };
    }
  }

  async *streamAnswer(question: string, context: {
    sqlResults?: string;
    questionType: string;
    pageContext?: string;
    knowledgeText?: string;
    codeChunks?: { file: string; content: string }[];
  }): AsyncIterable<string> {
    let prompt: string;

    if (context.questionType === 'code' && context.codeChunks) {
      prompt = buildCodeAnswerPrompt({
        question,
        codeChunks: context.codeChunks,
        currentDatetime: new Date().toISOString(),
        pageContext: context.pageContext || '',
      });
    } else if (context.questionType === 'guidance' || context.questionType === 'navigation') {
      prompt = buildGuidancePrompt({
        question,
        pageContext: context.pageContext || '',
        knowledgeText: context.knowledgeText || '',
      });
    } else {
      prompt = buildAnswerPrompt({
        question,
        sqlResults: context.sqlResults || '(no results)',
        currentDatetime: new Date().toISOString(),
        pageContext: context.pageContext || '',
      });
    }

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}
```

**Step 3: Create LLM routes (SSE streaming)**

```typescript
// packages/agent/src/routes/llm.ts
import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { OpenAIEngine } from '../llm/openai-engine.js';

// API key decrypted from vault at server startup
let llm: OpenAIEngine;

export const llmRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  // POST /llm/classify
  server.post<{ Body: { question: string; schemaSummary: string; pageContext?: string; history: any[] } }>(
    '/classify',
    async (request) => {
      const { question, schemaSummary, pageContext, history } = request.body;
      const result = await llm.classify(question, { schemaSummary, pageContext, history });
      return { ...result, newSessionToken: (request as any).newSessionToken };
    }
  );

  // POST /llm/generate-sql
  server.post<{ Body: { question: string; schema: string; codeContext?: string; enums?: string; history: any[] } }>(
    '/generate-sql',
    async (request, reply) => {
      const { question, schema, codeContext, enums, history } = request.body;
      const result = await llm.generateSQL(question, { schema, codeContext, enums, history });
      return { ...result, newSessionToken: (request as any).newSessionToken };
    }
  );

  // POST /llm/answer — SSE stream
  server.post<{ Body: { question: string; sqlResults?: string; questionType: string; history: any[]; pageContext?: string } }>(
    '/answer',
    async (request, reply) => {
      const { question, sqlResults, questionType, history, pageContext } = request.body;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-New-Session-Token': (request as any).newSessionToken,
      });

      for await (const chunk of llm.streamAnswer(question, { sqlResults, questionType, pageContext })) {
        reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  );

  // POST /llm/answer-from-code — SSE stream (N7 fix: code-only answers)
  server.post<{ Body: { question: string; codeChunks: any[]; history: any[]; pageContext?: string } }>(
    '/answer-from-code',
    async (request, reply) => {
      const { question, codeChunks, history, pageContext } = request.body;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-New-Session-Token': (request as any).newSessionToken,
      });

      for await (const chunk of llm.streamAnswer(question, {
        questionType: 'code',
        codeChunks,
        pageContext,
      })) {
        reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  );
};
```

**Step 4: Commit**
```bash
git add packages/agent/src/llm/ packages/agent/src/routes/llm.ts
git commit -m "feat(agent): add OpenAI LLM proxy with classify, SQL gen, and streaming answer"
```

---

## Phase 5: Agent — Code Indexing (BM25 RAG)

### Task 5.1: Git Clone + File Walker + BM25 Index

**Files:**
- Create: `packages/agent/src/git/cloner.ts`
- Create: `packages/agent/src/git/indexer.ts`
- Create: `packages/agent/src/git/search.ts`
- Create: `packages/agent/src/git/__tests__/indexer.test.ts`
- Create: `packages/agent/src/routes/code.ts`
- Modify: `packages/agent/package.json` (add simple-git, better-sqlite3, natural)

**Dependencies:**
```json
"simple-git": "^3.27.0",
"better-sqlite3": "^11.7.0",
"natural": "^8.0.0",
"@types/better-sqlite3": "^7.6.0"
```

This task implements the code indexing pipeline from the design doc (Section: "Code Understanding — Text-Based RAG"):
1. Clone git repo (shallow, read-only)
2. Walk file tree, filter by allowed extensions, skip sensitive files
3. Chunk files by function/class boundaries
4. Build BM25 index using `natural` library
5. Store in SQLite
6. Search via `/code/search` endpoint

Full implementation code follows the patterns established in Tasks 3.1 and 4.1. The indexer splits files into 50-150 line chunks with 10-line overlap, uses regex for function/class boundary detection, and stores everything in `~/.chatbot-agent/data/code-index.db`.

**Step 1-6: Implement, test, commit** (follows same TDD pattern as previous tasks)

```bash
git commit -m "feat(agent): add git clone, BM25 code indexer, and /code/search endpoint"
```

---

## Phase 6: Agent — Auto-Discovery Pipeline

### Task 6.1: Schema + Enum Discovery + LLM Label Inference

**Files:**
- Create: `packages/agent/src/discovery/pipeline.ts`
- Create: `packages/agent/src/discovery/data-sampler.ts`
- Create: `packages/agent/src/discovery/label-inference.ts`
- Create: `packages/agent/src/routes/discovery.ts`
- Reference: `app/services/autodiscovery.py`, `app/services/data_sampler.py` (V1)

Port V1's auto-discovery to Node.js. Key difference: V1 used OpenAI embeddings for RAG retrieval; V2 uses OpenAI API for label inference and BM25 for code search (no embeddings).

Pipeline:
1. Schema scan (reuse `schema-inspector.ts` from Task 3.1)
2. Data sampling — enum detection (port from `data_sampler.py`)
3. Code search — find enum definitions in code index (from Task 5.1)
4. LLM analysis — OpenAI infers enum labels, business rules (from Task 4.1)
5. Store results in SQLite (`~/.chatbot-agent/data/discovery.db`)
6. Serve via `/discovery/results`
7. Admin overrides via `/discovery/override`

```bash
git commit -m "feat(agent): add auto-discovery pipeline with enum detection and LLM label inference"
```

---

## Phase 7: Chrome Extension — Scaffold + Background Worker

### Task 7.1: Extension Manifest + Vite Build + Background Worker

**Files:**
- Create: `packages/extension/manifest.json`
- Create: `packages/extension/vite.config.ts`
- Create: `packages/extension/src/background/index.ts`
- Create: `packages/extension/src/background/agent-client.ts`
- Create: `packages/extension/src/background/message-router.ts`
- Modify: `packages/extension/package.json` (add React, Vite plugins)

**Dependencies:**
```json
"react": "^19.0.0",
"react-dom": "^19.0.0",
"@anthropic-ai/sdk": "^0.30.0",
"idb": "^8.0.0",
"vite": "^6.0.0",
"@crxjs/vite-plugin": "^2.0.0-beta.25",
"@vitejs/plugin-react": "^4.3.0"
```

The background worker is the message router — all agent HTTP calls go through here. It stores the session token in `chrome.storage.session` and handles token rotation.

```bash
git commit -m "feat(extension): add Manifest V3, Vite build, and background service worker"
```

---

## Phase 8: Chrome Extension — Popup UI

### Task 8.1: React Popup (Agent Status + Settings)

**Files:**
- Create: `packages/extension/src/popup/App.tsx`
- Create: `packages/extension/src/popup/index.tsx`
- Create: `packages/extension/src/popup/components/AgentStatus.tsx`
- Create: `packages/extension/src/popup/components/Settings.tsx`
- Create: `packages/extension/src/popup/components/DiscoveryResults.tsx`
- Create: `packages/extension/src/popup/components/UnlockForm.tsx`
- Create: `packages/extension/popup.html`

The popup shows:
- Agent connection status (green/red indicator)
- Unlock form (passphrase input)
- Discovery results review + override
- Crawl trigger button
- Settings (LLM engine, theme, history retention)
- Clear history button

```bash
git commit -m "feat(extension): add React popup with agent status, unlock, settings, and discovery UI"
```

---

## Phase 9: Chrome Extension — Content Script (Widget + Crawler)

### Task 9.1: Chat Widget in Shadow DOM

**Files:**
- Create: `packages/extension/src/content/index.ts`
- Create: `packages/extension/src/content/widget/ChatWidget.tsx`
- Create: `packages/extension/src/content/widget/styles.css`
- Create: `packages/extension/src/content/widget/mount.ts`
- Reference: `widget/src/ChatWidget.tsx`, `widget/src/index.ts` (V1 widget)

Port V1 widget to content script injection with Shadow DOM. Key changes:
- V1 loaded via `<script>` tag; V2 injected via `chrome.scripting.executeScript`
- V1 used fetch directly; V2 sends messages to background worker
- SSE streaming is now relayed through the background worker

### Task 9.2: Page Crawler

**Files:**
- Create: `packages/extension/src/content/crawler/index.ts`
- Create: `packages/extension/src/content/crawler/extractor.ts`
- Create: `packages/extension/src/content/crawler/spa-detector.ts`

Implements the SPA-aware crawling from the design doc. Extracts navigation links, forms, tables, buttons from the live DOM.

### Task 9.3: Browser Actions

**Files:**
- Create: `packages/extension/src/content/actions/index.ts`
- Create: `packages/extension/src/content/actions/form-filler.ts`
- Create: `packages/extension/src/content/actions/navigator.ts`

Implements framework-aware DOM interaction with safety tiers (auto/fill+highlight/refuse).

```bash
git commit -m "feat(extension): add chat widget, page crawler, and browser actions"
```

---

## Phase 10: Chrome Extension — IndexedDB Storage

### Task 10.1: IndexedDB Layer with idb

**Files:**
- Create: `packages/extension/src/storage/index.ts`
- Create: `packages/extension/src/storage/schema.ts`
- Create: `packages/extension/src/storage/__tests__/storage.test.ts`

Implements the IndexedDB schema from the design doc: projects, crawled_pages, chat_history, settings. Uses `idb` library for typed access. Auto-cleanup for expired entries.

```bash
git commit -m "feat(extension): add IndexedDB storage layer with auto-expiry"
```

---

## Phase 11: Integration — End-to-End Chat Flow

### Task 11.1: Wire Up Full Pipeline

Connect all components:
1. Content script sends question to background worker
2. Background worker calls agent `/llm/classify`
3. Based on type, background worker orchestrates:
   - `data`/`data_with_code`: schema + code search + SQL gen + execute + stream answer
   - `code`: code search + stream answer from code
   - `navigation`/`guidance`: stream guidance answer
   - `action`: execute browser action
4. Background worker relays streamed response to content script
5. Content script displays in widget

### Task 11.2: Agent Setup Flow

Wire up the agent's `/setup` HTML page with hash-wasm for client-side Argon2id encryption.

```bash
git commit -m "feat: wire up end-to-end chat pipeline across extension and agent"
```

---

## Phase 12: Testing + Regression

### Task 12.1: Agent Unit Tests (Jest/Vitest)

- SQL validator (already done in Task 1.3)
- Vault encryption/decryption
- Session token rotation + grace window
- Code indexer (BM25 search quality)
- Discovery pipeline

### Task 12.2: Agent Integration Tests

- Full API flow: unlock → schema → query → answer
- SQL injection attempts blocked
- Rate limiting works
- Read-only enforcement

### Task 12.3: Extension Unit Tests (Vitest)

- Message routing
- IndexedDB CRUD
- Widget component rendering

### Task 12.4: E2E Regression — 20 Question Test Suite

Use Playwright with Chrome extension loading to test all 20 V1 questions against the full V2 stack (extension → agent → OpenAI → DB).

```bash
git commit -m "test: add full test suite — unit, integration, E2E, and 20-question regression"
```

---

## Phase Summary

| Phase | Description | Dependencies | Est. Tasks |
|-------|-------------|-------------|------------|
| 0 | REMOVED (v4) | None | 0 |
| 1 | Monorepo + shared package | None | 4 |
| 2 | Agent: vault + auth + server | Phase 1 | 3 |
| 3 | Agent: database module | Phase 2 | 1 |
| 4 | Agent: OpenAI LLM proxy | Phase 2 | 1 |
| 5 | Agent: code indexing (BM25) | Phase 2 | 1 |
| 6 | Agent: auto-discovery | Phases 3, 4, 5 | 1 |
| 7 | Extension: scaffold + background | Phase 1 | 1 |
| 8 | Extension: popup UI | Phase 7 | 1 |
| 9 | Extension: content script | Phase 7 | 3 |
| 10 | Extension: IndexedDB storage | Phase 7 | 1 |
| 11 | Integration: end-to-end | Phases 6, 8, 9, 10 | 2 |
| 12 | Testing + regression | Phase 11 | 4 |

**Total: ~25 tasks across 13 phases**

**Parallelism:** Phases 3-5 can run in parallel (all depend on Phase 2). Phases 7-10 can run in parallel (all depend on Phase 1). Agent and extension development are largely independent after Phase 1.

---

## Rules for Implementation

1. **TDD**: Write failing test → implement → verify pass → commit
2. **No hardcoded secrets**: All credentials come from vault or user input. ASK the user.
3. **Update progress file after every completed task**: `memory/sql-chatbot-progress.md`
4. **Browser testing only**: User rejected curl testing. Use Playwright for E2E.
5. **Security is #1**: Every agent endpoint validates tokens. All SQL goes through allowlist. Never expose secrets in logs.
6. **Commit after every task**: Small, frequent commits with descriptive messages.
7. **Port from V1 carefully**: The V1 Python code is the source of truth for prompts, validation rules, and business logic. Port faithfully, then improve.
