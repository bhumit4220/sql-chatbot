# SQL Chatbot V2 — Chrome Extension + Local Agent Design

> **Date**: 2026-02-24
> **Status**: Approved (v2 — audit fixes applied: C1-C5, I1-I8, M1-M5)
> **Branch**: v2-development
> **Depends on**: V1 complete (Phases 1-12, all passing)

---

## Problem

The V1 chatbot works but is **too complex to deploy and sell**:
- Requires Docker, API setup, manual JSON seeding, widget embed
- 9 setup steps — customers leave at step 3
- Hosted model means server costs and data privacy concerns
- Manual semantic context seeding per project
- Third-party LLM dependency (OpenAI) adds cost per question

## Goal

**Install a Chrome extension. Connect your database. Ask questions in plain English. Everything runs locally — your data never leaves your network.**

- Zero remote cloud infrastructure (agent runs on customer's own server/machine)
- Zero third-party LLM dependency (runs locally via Ollama or in-browser)
- Zero manual semantic seeding (auto-discovery + code understanding)
- Works with any web app, any tech stack, any database
- Credentials never stored in or accessible to the Chrome extension

---

## Product Capabilities

### 1. DATA Mode — Query the Database
> "How many active contractors?" → SQL query → answer

The bot generates SQL from natural language, executes against the customer's database (read-only), and returns a human-friendly answer.

### 2. CODE Mode — Understand Business Logic
> "What is net sales today?" → reads code to find formula → generates correct SQL

The bot searches indexed codebase to find calculation logic, business rules, and domain knowledge. Combines code understanding with database schema to generate accurate queries.

### 3. NAVIGATION Mode — Know the Admin Panel
> "Where is the payments page?" → crawled page knowledge → "Go to Payments in sidebar"

The extension crawls the live admin panel (rendered HTML, not source code) and indexes page titles, menus, forms, buttons, and URLs. Tech-independent — works with Rails, React, Django, anything.

### 4. ACTION Mode — Automate the Browser
> "Fill the new job form for customer John" → fills the form fields

The extension manipulates the DOM to fill forms, navigate pages, click buttons, and select dropdowns. Safety rules prevent destructive auto-actions.

**Action Safety Rules:**
- **READ actions** (navigate, filter, search) → Auto-execute
- **FILL actions** (fill form fields) → Fill + highlight, ask admin to confirm
- **CREATE actions** (submit new records) → Fill form, DON'T click submit
- **DELETE/DESTRUCTIVE actions** → REFUSE, tell admin to do it manually

### Question Classification (5 types)

The classifier outputs 5 types that map to the 4 modes:

| Classifier Output | Mode | Description |
|-------------------|------|-------------|
| `data` | DATA | Simple SQL — schema is enough |
| `data_with_code` | CODE | SQL but needs business logic from code |
| `navigation` | NAVIGATION | Where to find a page/feature |
| `action` | ACTION | Fill form, click, navigate DOM |
| `guidance` | NAVIGATION | How-to, help, capabilities |

---

## Architecture — "Smart Split"

Split responsibilities by what MUST run where.

```
┌─────────────────────────────────────────────────────────┐
│  Chrome Extension (ZERO secrets)                         │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ Popup UI │  │ Content  │  │  Background Worker    │  │
│  │ (React)  │  │ Script   │  │  (message router)     │  │
│  │          │  │          │  │                       │  │
│  │ Settings │  │ Widget   │  │  Routes messages      │  │
│  │ Projects │  │ Crawler  │  │  between content      │  │
│  │ Agent    │  │ Actions  │  │  script, popup,       │  │
│  │ Status   │  │ DOM Read │  │  and agent.           │  │
│  └──────────┘  └──────────┘  │                       │  │
│                              │  ALL agent HTTP calls  │  │
│  ┌──────────────────────┐    │  go through here      │  │
│  │  IndexedDB           │    │  (content scripts     │  │
│  │  (config, crawled    │    │   cannot fetch agent   │  │
│  │   pages, chat        │    │   due to CORS)        │  │
│  │   history, settings) │    └───────────┬───────────┘  │
│  │  NO credentials      │               │              │
│  │  Session token       │               │              │
│  │  encrypted at rest   │               │              │
│  └──────────────────────┘               │              │
└─────────────────────────────────────────┼──────────────┘
                                          │
                              127.0.0.1:9876 (HTTPS)
                              session token + origin check
                                          │
┌─────────────────────────────────────────▼──────────────┐
│  Local Agent — Node.js (ALL secrets stay here)          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Encrypted Vault (AES-256-GCM)                    │  │
│  │  Key derived from: passphrase via Argon2id        │  │
│  │  Contains: DB creds, git tokens                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ DB       │ │ Git      │ │ Discovery│ │ LLM       │  │
│  │ Module   │ │ Module   │ │ Module   │ │ Module    │  │
│  │          │ │          │ │          │ │ (Ollama)  │  │
│  │ •Connect │ │ •Clone   │ │ •Schema  │ │           │  │
│  │ •Schema  │ │ •Index   │ │ •Enums   │ │ •Classify │  │
│  │ •Execute │ │ •Search  │ │ •FKs     │ │ •SQL Gen  │  │
│  │  SQL     │ │ •Serve   │ │ •Stale   │ │ •Answer   │  │
│  │(readonly)│ │(readonly)│ │ •Labels  │ │ •Stream   │  │
│  └────┬─────┘ └────┬─────┘ └──────────┘ └───────────┘  │
│       │            │                                    │
│  Listens: 127.0.0.1 ONLY (never 0.0.0.0)              │
│  HTTPS with auto-generated self-signed cert             │
│  Origin validation: only chrome-extension://<id>        │
│  Session token: 4-hour expiry, rotated per request      │
│  Rate limited: 60 req/min                               │
└───────┼────────────┼────────────────────────────────────┘
        │            │
┌───────▼────┐ ┌─────▼───────┐
│  Database  │ │  Git Repo   │
│ (read-only │ │ (read-only  │
│  user)     │ │  clone)     │
└────────────┘ └─────────────┘
```

### Message Flow — CRITICAL

Content scripts **cannot** fetch `127.0.0.1` directly due to CORS restrictions in Manifest V3. All communication MUST route through the background worker:

```
Content Script                Background Worker              Agent
     │                              │                          │
     │  chrome.runtime.sendMessage  │                          │
     │  ─────────────────────────►  │                          │
     │                              │   fetch('https://       │
     │                              │   127.0.0.1:9876/...')   │
     │                              │  ─────────────────────►  │
     │                              │                          │
     │                              │  ◄─────────────────────  │
     │  ◄─────────────────────────  │                          │
     │   response via sendResponse  │                          │
```

---

## LLM Strategy

### [FIX C2] Default: Ollama on Agent (not WebLLM in browser)

The audit found that a 3B browser model is **insufficient for reliable SQL generation**. Multi-join queries, enum mappings, date arithmetic, and subqueries require a stronger model.

**Default: Ollama running on the agent** with a 7B+ model:

| Model | Size | SQL Quality | Context Window |
|-------|------|-------------|----------------|
| **Qwen2.5-Coder-7B** (default) | 4.5GB | Very good | 32K tokens |
| Qwen2.5-Coder-14B | 9GB | Excellent | 32K tokens |
| Codestral 22B | 12GB | Best | 32K tokens |
| DeepSeek-Coder-V2-Lite | 9GB | Excellent | 128K tokens |

**Why Ollama on agent:**
- Agent already runs on the server — Ollama adds no new infrastructure
- 7B+ models generate significantly better SQL than 3B browser models
- 32K context windows fit schema + code + history easily
- No WebGPU dependency — works on any server with CPU (GPU optional but faster)
- Agent bundles Ollama or detects existing installation

**WebLLM stays as optional** for users who want pure in-browser inference and accept lower accuracy. Not the default.

### [FIX C1] No LLM in Service Worker

The audit found that Manifest V3 service workers are **terminated after 5 minutes of inactivity**, killing any loaded model.

**Fix:** The background service worker NEVER runs LLM inference. It only routes messages. LLM runs on the agent (Ollama) or optionally in an **offscreen document** for WebLLM:

```
LLM Location Options:
  ├── Agent/Ollama (default) — agent handles all LLM calls
  │     Extension sends: POST /llm/classify, POST /llm/generate-sql, POST /llm/answer
  │     Agent calls Ollama locally and streams response back
  │
  ├── WebLLM (optional) — runs in offscreen document, NOT service worker
  │     chrome.offscreen.createDocument({ url: 'offscreen.html' })
  │     Offscreen document loads WebLLM + model, persists longer than SW
  │     Background worker communicates via chrome.runtime.sendMessage()
  │
  ├── Chrome AI (optional) — Gemini Nano via window.ai in offscreen document
  │
  └── OpenAI/Anthropic (optional) — bring-your-own-key, calls from agent
```

### Fallback Chain
```
1. Check if agent has Ollama running → use it (best quality)
2. If no Ollama → check for WebGPU in browser → offer WebLLM in offscreen doc
3. If no WebGPU → check Chrome AI availability → use Gemini Nano
4. If nothing local → prompt user to install Ollama or provide API key
```

### [FIX I6] Discovery LLM Location

The discovery pipeline needs LLM for enum label inference and business term detection. Since the **default LLM is Ollama on the agent**, discovery runs entirely on the agent with no circular dependency:

```
Agent Discovery Pipeline:
  1. Schema scan (agent → DB)
  2. Data sampling (agent → DB)
  3. Code search (agent → git index)
  4. LLM analysis (agent → Ollama locally)
     - Input: column names + sampled values + code snippets
     - Output: enum labels, business rules, term synonyms
  5. Store results on agent
  6. Serve to extension via /discovery/results
```

### POC Requirement

**Before full implementation, build a proof-of-concept:**
1. Install Ollama + Qwen2.5-Coder-7B on development machine
2. Test against the V1 test suite of 20 dumb-admin questions
3. Compare SQL accuracy with GPT-4o-mini
4. If 7B model fails > 20% of questions, evaluate 14B or consider fine-tuned text-to-SQL variants

---

## Pluggable Interfaces

Everything behind interfaces so components can be swapped later.

### LLM Engine Interface
```typescript
interface LLMEngine {
  classify(question: string, context: ClassifyContext): Promise<QuestionType>
  // QuestionType: "data" | "data_with_code" | "navigation" | "action" | "guidance"
  generateSQL(question: string, context: SQLContext): Promise<SQLResult>
  streamAnswer(question: string, context: AnswerContext): AsyncIterable<string>
  isReady(): Promise<boolean>
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

Implementations:
  ├── OllamaEngine (default) — calls Ollama on agent
  ├── WebLLMEngine (optional) — runs in offscreen document via WebGPU
  ├── ChromeAIEngine (optional) — Chrome built-in Gemini Nano
  └── OpenAIEngine (optional) — bring-your-own-key, calls from agent
```

### Data Source Interface
```typescript
interface DataSource {
  getSchema(): Promise<TableSchema[]>
  executeQuery(sql: string): Promise<QueryResult>
  discoverEnums(): Promise<EnumMapping[]>
  discoverRelationships(): Promise<Relationship[]>
  healthCheck(): Promise<HealthStatus>
}

Implementations:
  ├── LocalAgentDataSource (default) — calls agent REST API on localhost
  ├── CloudAPIDataSource — calls hosted API (future SaaS)
  └── DirectRESTDataSource — calls PostgREST/Hasura directly (future)
```

### Code Source Interface
```typescript
interface CodeSource {
  search(query: string, limit?: number): Promise<CodeChunk[]>
  getFile(path: string): Promise<FileContent>
  listFiles(pattern: string): Promise<string[]>
  isAvailable(): Promise<boolean>
}

Implementations:
  ├── AgentCodeSource (default) — agent clones git repo, indexes, serves
  ├── GitHubAPICodeSource — search via GitHub API directly (future)
  └── NoneCodeSource — no code access, skip code understanding
```

### Storage Interface
```typescript
interface Storage {
  get<T>(collection: string, key: string): Promise<T | null>
  set<T>(collection: string, key: string, value: T): Promise<void>
  query<T>(collection: string, filter: Record<string, any>): Promise<T[]>
  delete(collection: string, key: string): Promise<void>
  clear(collection: string): Promise<void>
}

Implementations:
  ├── IndexedDBStorage (default) — browser IndexedDB
  └── AgentStorage — store on agent side (future)
```

---

## Security Model

### Core Principle: Credentials are never stored in or accessible to the Chrome extension.

### [FIX C5] Credential Setup — Client-Side Encryption

The agent setup page runs on the agent (`https://127.0.0.1:9876/setup`) but is rendered **in the browser**. Credentials must be encrypted before leaving the browser form:

```
Setup Flow (secure):
  1. Admin opens agent setup page: https://127.0.0.1:9876/setup
  2. Agent serves setup HTML with embedded JavaScript
  3. Admin enters passphrase → JS derives encryption key via Argon2id (in browser)
  4. Admin enters DB URL, git token
  5. JS encrypts all secrets client-side using the derived key (AES-256-GCM)
  6. JS sends ONLY encrypted blobs to agent:
     POST /setup/configure
     Body: {
       passphrase_hash: "argon2id hash for verification",
       encrypted_db_url: "base64(AES-GCM encrypted)",
       encrypted_git_token: "base64(AES-GCM encrypted)",
       salt: "random salt used for key derivation",
       iv: "initialization vector"
     }
  7. Agent stores encrypted blobs as-is
  8. Agent NEVER sees plaintext credentials until admin unlocks vault

Unlock Flow:
  1. Admin enters passphrase in extension popup
  2. Extension sends passphrase to background worker
  3. Background worker sends to agent: POST /auth/unlock { passphrase }
  4. Agent derives key from passphrase + stored salt via Argon2id
  5. Agent decrypts vault → tests DB connection → tests git
  6. Agent returns session token
  7. Background worker stores session token (encrypted, see C4 fix)
  8. Passphrase is NEVER stored anywhere
```

### [FIX C4] Session Token — Hardened

| Protection | Implementation |
|------------|---------------|
| **Origin binding** | Agent validates `Origin: chrome-extension://<extension-id>` header on every request. Rejects all other origins. Extension ID is registered during setup. |
| **Short expiry** | Token expires after **4 hours** (not 24h). |
| **Token rotation** | New token issued on every request. Previous token invalidated. Replay = instant rejection. |
| **Encrypted at rest** | Stored in `chrome.storage.session` (memory-only, cleared on browser close). NOT in IndexedDB. |
| **Scope limiting** | Token encodes allowed operations. Read-only token cannot be upgraded. |
| **IP binding** | Token bound to 127.0.0.1 — only localhost requests accepted. |

### [FIX C5] Agent HTTPS

The agent serves ALL endpoints (including setup) over **HTTPS with a self-signed certificate**:

```
First agent start:
  1. Generate self-signed TLS cert (2048-bit RSA, 1 year validity)
  2. Store cert + key in agent's data directory (~/.chatbot-agent/tls/)
  3. Serve on https://127.0.0.1:9876
  4. Extension trusts this cert via manifest's host_permissions

Why HTTPS on localhost:
  - Prevents other local processes from sniffing traffic
  - Prevents other browser extensions from intercepting via service worker
  - Chrome refuses to send credentials over plain HTTP in some contexts
  - Defense in depth
```

### What Lives Where

| Secret | Stored Where | Encrypted | Extension Sees? |
|--------|-------------|-----------|-----------------|
| DB credentials | Agent encrypted vault | AES-256-GCM (Argon2id key) | NEVER |
| Git token | Agent encrypted vault | AES-256-GCM (Argon2id key) | NEVER |
| Passphrase | Nowhere (admin's memory) | N/A | Transient only (to unlock) |
| Session token | chrome.storage.session (memory) | Memory-only, cleared on close | Yes (only this) |
| Schema cache | Agent | Not secret | Via API only |
| Code index | Agent | Not secret | Via API only |
| Chat history | Extension (IndexedDB) | See PII section below | Yes |
| Crawled pages | Extension (IndexedDB) | Not secret | Yes |

### Agent Security

- **Listens on 127.0.0.1 ONLY** — never 0.0.0.0, never accessible from network
- **HTTPS only** — self-signed TLS cert, no plaintext HTTP
- **Origin validation** — only accepts requests from `chrome-extension://<registered-id>`
- **Session token required** on every API request (except `/auth/status`)
- **Token rotation** — new token per request, old token invalidated
- **Session expires** after 4 hours (configurable, max 8 hours)
- **All SQL forced read-only** — `SET TRANSACTION READ ONLY` on every query
- **SQL validation — allowlist approach** (see below)
- **Git clone is read-only** — no push, no write operations
- **Rate limiting** — 60 requests/minute per session
- **Request size limits** — max 10KB per request body
- **Audit logging** — all queries logged with timestamp (no credential logging)

### [FIX I5] SQL Validation — Allowlist, Not Denylist

The V1 denylist approach (block specific keywords) is inherently incomplete. V2 uses a strict **allowlist**:

```
SQL Validation Rules (agent is authoritative):

1. Parse SQL via pg-query-parser (PostgreSQL's actual parser, ported to JS)
2. ALLOWLIST: Only permit single SELECT statements
   - Must be exactly one statement
   - Statement type must be SelectStmt
   - Reject everything else (INSERT, UPDATE, DELETE, DROP, TRUNCATE,
     CREATE, ALTER, GRANT, COPY, DO, CALL, EXECUTE, SET, RESET, SHOW)
3. Reject CTEs containing mutation (WITH ... INSERT/UPDATE/DELETE)
4. Reject SELECT INTO (creates tables)
5. Reject all system catalog access (pg_*, information_schema)
6. Reject dangerous functions:
   - File I/O: pg_read_file, pg_read_binary_file, lo_import, lo_export
   - Network: dblink, dblink_exec
   - Sleep: pg_sleep, pg_sleep_for
   - Admin: pg_terminate_backend, pg_cancel_backend, pg_reload_conf
   - Dynamic: EXECUTE, PREPARE
7. Add LIMIT 500 if no LIMIT clause present
8. Wrap in read-only transaction: SET TRANSACTION READ ONLY

Defense in depth:
  - Extension validates (first pass, can be bypassed)
  - Agent validates (authoritative, always enforced)
  - Database user should be read-only (ultimate backstop)
```

### Database Security — Read-Only User Required

Agent setup UI **requires** confirmation that a read-only user is being used:

```sql
-- Agent shows this guidance and asks admin to confirm:
CREATE USER chatbot_reader WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE mydb TO chatbot_reader;
GRANT USAGE ON SCHEMA public TO chatbot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_reader;

-- Revoke any default write permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM chatbot_reader;
```

The agent also **tests** the user's permissions on first connect — attempts an INSERT into a temp table. If it succeeds, warns the admin that the user has write access.

### Git Security — Read-Only Token

Agent setup UI guides the admin:
- **GitHub**: Settings → Fine-grained tokens → Read-only → Contents only
- **GitLab**: Settings → Access Tokens → read_repository only
- **Bitbucket**: App passwords → Repositories: Read only

Agent validates: attempts `git push --dry-run`. If it would succeed, warns admin.

### Code Indexing — Safe Files Only

**Auto-excluded (never indexed, never served to extension):**
```
.env, .env.*, *.env, .env.local, .env.production
credentials.*, secrets.*, master.key, config/master.key
*.pem, *.key, *.p12, *.pfx, *.cert, *.crt
id_rsa, id_ed25519, authorized_keys, known_hosts
.git/ (full directory)
node_modules/, vendor/, venv/, __pycache__/, .bundle/
*.log, *.lock, package-lock.json, yarn.lock
docker-compose*.yml (may contain passwords)
database.yml, database.yml.enc (Rails DB config)
*.sqlite3, *.db (database files)

Content scanning (reject files containing any of):
  - password=, PASSWORD=
  - api_key=, API_KEY=, apikey=
  - secret_key=, SECRET_KEY=
  - private_key=, PRIVATE_KEY=
  - access_token=, ACCESS_TOKEN=
  - AWS_SECRET, STRIPE_SECRET, GITHUB_TOKEN
  - BEGIN RSA PRIVATE KEY, BEGIN OPENSSH PRIVATE KEY
  - connection_string=, DATABASE_URL=
```

**Indexed file types (allowlist):**
```
Code:    .rb, .py, .js, .ts, .go, .java, .php, .ex, .rs, .cs
Views:   .erb, .html, .jsx, .tsx, .vue, .blade.php, .ejs, .hbs
Config:  .yml (only: routes.yml, schema.yml, openapi.yml — explicit allowlist)
Schema:  .sql, .graphql, schema.rb, structure.sql
Docs:    .md (README, CLAUDE.md — may contain useful business context)
```

### LLM Safety — No Credentials in Prompts

**LLM receives:**
- Schema (table names, column names, types — no connection info)
- Code snippets (from indexed safe files only)
- SQL results (data rows — see PII section)
- Page context (crawled DOM)

**LLM NEVER receives:**
- Connection strings, database URLs
- Passwords, tokens, API keys
- .env file contents
- Any content from excluded files
- Raw file paths that could reveal server structure

### [FIX I8] PII in Chat History

SQL query results may contain PII (emails, names, addresses, payment info). Chat history stores these in IndexedDB.

**Mitigations:**
- **Auto-expiry**: Chat history older than 7 days auto-deleted (configurable)
- **No raw results stored**: Only the LLM-generated answer text is stored, NOT raw SQL result rows
- **SQL query stored**: The generated SQL is stored (for debugging) but NOT the result data
- **Clear history button**: One-click clear all history from extension popup
- **PII warning**: First-time setup warns admin that query answers may contain PII
- **Opt-out**: Admin can disable chat history storage entirely in settings

---

## Local Agent — REST API Design

### Base: `https://127.0.0.1:9876` (HTTPS with self-signed cert)

### Auth Endpoints
```
POST /auth/unlock
  Body: { passphrase: "..." }
  Returns: { session_token: "...", expires_at: "...", extension_id: "..." }
  (Derives key, decrypts vault, tests connections, issues bound token)
  Rate limit: 5 attempts per minute (brute-force protection)

POST /auth/lock
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  (Locks vault, invalidates all sessions, wipes decrypted secrets from memory)

GET /auth/status
  Returns: { locked: bool, configured: bool, agent_version: "..." }
  (No auth needed — tells extension if setup is complete)
```

### Setup Endpoints (Agent's own web UI)
```
GET /setup
  Returns: HTML setup page with embedded JS for client-side encryption
  (Admin enters credentials here — encrypted before transmission)

POST /setup/configure
  Body: {
    passphrase_hash: "argon2id hash",
    encrypted_db_url: "AES-GCM encrypted blob",
    encrypted_git_token: "AES-GCM encrypted blob (optional)",
    salt: "random 32-byte salt",
    iv: "random 12-byte IV"
  }
  Returns: { success: bool, session_token: "..." }
  (Stores encrypted blobs, tests connections after unlock)

POST /setup/register-extension
  Body: { extension_id: "chrome-extension://abcdef..." }
  Returns: { registered: true }
  (Registers the extension origin for CORS/origin validation)
```

### Database Endpoints
```
GET /db/schema
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { tables: [...], new_session_token: "..." }
  Query params: ?relevant_to=query (optional — returns only relevant tables)

GET /db/enums
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { enums: [...], new_session_token: "..." }

POST /db/query
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { sql: "SELECT ..." }
  Returns: { columns, rows, total_count, execution_time_ms, new_session_token }
  (Validates SQL via allowlist, forces read-only, caps at 500 rows)

GET /db/health
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { connected: bool, latency_ms: number, new_session_token }
```

### LLM Endpoints (Ollama proxy)
```
POST /llm/classify
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, schema_summary, page_context, history }
  Returns: { type: "data"|"data_with_code"|"navigation"|"action"|"guidance", new_session_token }

POST /llm/generate-sql
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, schema, code_context, enums, history }
  Returns: SSE stream of { sql, explanation } then tokens
  (Agent calls Ollama, streams response back)

POST /llm/answer
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, sql_results, question_type, history, page_context }
  Returns: SSE stream of answer tokens
```

### Code Endpoints
```
GET /code/status
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { indexed: bool, file_count, last_indexed_at, new_session_token }

POST /code/search
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { query: "net sales calculation", limit: 10 }
  Returns: { results: [{ file, line_start, line_end, content, score }], new_session_token }
  (File paths sanitized — relative only, no absolute server paths)

POST /code/reindex
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { status: "indexing", file_count, new_session_token }
  (Incremental: git pull + re-index changed files only)
```

### Discovery Endpoints
```
POST /discovery/run
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { status: "running", new_session_token }

GET /discovery/status
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: {
    schema: "completed", enums: "completed", code: "indexing",
    tables_found: 45, enums_detected: 12, files_indexed: 234,
    new_session_token
  }

GET /discovery/results
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Returns: { schema, enums, relationships, stale_columns, business_terms, new_session_token }

POST /discovery/override
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { type: "enum", table: "jobs", column: "status", corrections: { "1": "Active" } }
  Returns: { saved: true, new_session_token }
  (Admin can correct auto-discovered labels — stored on agent)
```

---

## Chrome Extension Structure

### Manifest V3

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage", "offscreen", "scripting"],
  "host_permissions": ["https://127.0.0.1:9876/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": []
}
```

**[FIX I4] No `<all_urls>` in host_permissions.** Content scripts are injected programmatically via `chrome.scripting.executeScript` with `activeTab` permission, triggered when the user clicks the extension icon. This avoids the enhanced Chrome Web Store review for `<all_urls>`.

### Extension Components

**Popup UI (React)**
- Project list / setup
- Agent connection status + health
- Discovery results review + manual overrides
- Crawl trigger button
- Settings (LLM engine choice, chat history retention, preferences)
- Clear history button
- Does NOT handle credentials (redirects to agent setup UI)

**Background Service Worker**
- **Message router ONLY** — no LLM, no heavy computation
- Routes messages between popup ↔ content script ↔ agent
- All HTTP calls to agent go through here (CORS fix)
- Session token management (stored in chrome.storage.session)
- Lightweight — survives MV3 lifecycle without issues

**Offscreen Document (optional — only for WebLLM)**
- Created only if user selects WebLLM engine
- `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'] })`
- Loads WebLLM + model, persists longer than service worker
- Communicates with background worker via `chrome.runtime.sendMessage()`

**Content Script (injected on demand via activeTab)**
- Chat widget injection (floating bubble, Shadow DOM)
- Page crawler (extract DOM: nav, forms, tables, buttons)
- Browser actions (fill forms, click, navigate)
- Page context extraction (current URL, title, breadcrumbs)
- Sends all data to background worker via `chrome.runtime.sendMessage()`
- **NEVER fetches agent directly** — always through background worker

### IndexedDB Schema

```
Database: "chatbot_v2"

Stores:
  projects: {
    id (auto),
    name: string,
    agent_url: string,  // always https://127.0.0.1:9876
    discovery_status: object,
    created_at: timestamp,
    updated_at: timestamp
    // NO session_token here — stored in chrome.storage.session
    // NO schema_cache here — fetched from agent on demand
  }

  crawled_pages: {
    id (auto),
    project_id: number,
    url: string,
    title: string,
    navigation: [{ text, href, selector }],
    forms: [{ action, fields: [{ label, selector, type, options }] }],
    buttons: [{ text, selector, action_type }],
    tables: [{ headers, selector }],
    crawled_at: timestamp,
    expires_at: timestamp  // auto-cleanup after 30 days
  }

  chat_history: {
    id (auto),
    project_id: number,
    conversation_id: string,
    role: "user" | "assistant",
    content: string,       // answer text only, NO raw SQL results
    question_type: string,
    sql_query: string | null,  // for debugging, no result data
    created_at: timestamp,
    expires_at: timestamp  // auto-cleanup after 7 days (configurable)
  }

  settings: {
    llm_engine: "ollama" | "webllm" | "chrome_ai" | "openai",
    theme: "light" | "dark" | "auto",
    position: "bottom-right" | "bottom-left",
    history_retention_days: number,  // default 7
    auto_crawl: boolean,
    debug_mode: boolean
  }
```

---

## Page Crawler Design

### [FIX I3] SPA-Aware Crawling

The crawler must work with both server-rendered pages (Rails, Django) and SPAs (React, Vue, Angular).

```
Crawl Strategy:

1. Admin clicks "Crawl this site" in extension popup
2. Content script starts on CURRENT page (admin is already logged in)
3. Extract navigation links from current page
4. For each link:
   a. Navigate using window.location (server-rendered) OR
      click the link and wait for DOM mutation (SPA)
   b. Wait for page to stabilize:
      - MutationObserver: wait until no DOM changes for 2 seconds
      - OR document.readyState === 'complete' + 1s buffer
   c. Extract page content (see below)
   d. Go back / navigate to next link
5. All crawling happens in the CURRENT TAB (preserves auth cookies/session)
6. Progress shown in extension popup: "Crawling... 12/34 pages"

SPA Detection:
  - If clicking a link does NOT cause full page reload
    (check: navigation event type, URL change via pushState)
  → Switch to SPA mode: click links, wait for MutationObserver

Server-rendered Detection:
  - If clicking a link causes full page reload
  → Use standard navigation, wait for document.readyState
```

### Extraction Rules

```javascript
// Navigation: multiple selector strategies
const navSelectors = [
  'nav a', '.sidebar a', '[role="navigation"] a',
  '.menu a', '.nav-link', '[data-menu] a',
  'aside a', '.drawer a'
];

// Forms: all input fields with labels
document.querySelectorAll('form').forEach(form => {
  form.querySelectorAll('input, select, textarea').forEach(field => {
    const label = findLabel(field); // <label>, aria-label, placeholder, nearby text
    const uniqueSelector = generateUniqueSelector(field); // data-testid > id > name > CSS path
    // Store: { label, selector, type, options (for select), required }
  });
});

// Tables: column headers
document.querySelectorAll('table, [role="grid"], [role="table"]');

// Buttons: action buttons with inferred types
document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn');
// Infer type from text: "Delete" → destructive, "Create" → create, "Export" → read
```

### Re-crawl Strategy
- **Incremental**: When admin navigates to a page not in crawl cache, auto-crawl it
- **Manual full re-crawl**: Button in extension popup
- **Auto-expiry**: Crawled pages expire after 30 days, re-crawled on next visit
- **Estimated time**: 1-3 seconds per page, ~30-90 seconds for 30-page admin panel

---

## Browser Actions Design

### Action Types and Safety

```
NAVIGATE actions → Auto-execute
  "Go to contractors page" → window.location = "/admin/contractors"

SEARCH actions → Auto-execute
  "Search for John" → find search input → type "John" → submit

FILTER actions → Auto-execute
  "Filter by Calgary" → find filter dropdown → select "Calgary"

FILL actions → Fill + highlight, DON'T submit
  "Fill the form with name John" → fill fields → highlight yellow →
  "I've filled the form. Please review and click Submit."

DESTRUCTIVE actions → REFUSE
  "Delete contractor #123" →
  "I can't perform delete actions. Please click the Delete button yourself."
```

### [FIX M2] Framework-Aware DOM Interaction

Naive `.value` setting doesn't work with React/Vue/Angular. Use framework-detection and appropriate methods:

```javascript
async function fillField(selector, value) {
  const field = document.querySelector(selector);
  if (!field) return { success: false, error: 'Field not found' };

  // Focus the field first
  field.focus();

  // Detect framework and use appropriate method
  if (isReactElement(field)) {
    // React: use native input value setter to bypass React's synthetic events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Standard: use InputEvent for maximum compatibility
    field.value = '';
    for (const char of value) {
      field.dispatchEvent(new InputEvent('beforeinput', {
        data: char, inputType: 'insertText', bubbles: true, cancelable: true
      }));
      field.value += char;
      field.dispatchEvent(new InputEvent('input', {
        data: char, inputType: 'insertText', bubbles: true
      }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Visual feedback
  field.style.outline = '3px solid #facc15';
  field.style.backgroundColor = '#fefce8';
  return { success: true };
}

function isReactElement(el) {
  return Object.keys(el).some(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
}
```

---

## Code Understanding — Text-Based RAG

### Indexing Flow (on agent)

```
1. Agent clones git repo (read-only, shallow clone --depth=1 for speed)
2. Walks file tree, filters by allowed extensions (see Security section)
3. Skips sensitive files (content scanning for credentials)
4. Chunks each file:
   - Split by function/class/method boundaries (regex, not AST)
   - Each chunk: ~50-150 lines with file path + line numbers
   - Overlap: 10 lines between chunks
   - Tag: relative file path, language hint (from extension)
5. Search index (zero external dependency):
   - TF-IDF + BM25 via natural library (Node.js, no Python/neural models)
   - No embeddings needed — avoids OpenAI dependency entirely
   - BM25 is excellent for code search (keyword matching is often better than semantic)
6. Store chunks + index in SQLite on agent (~/.chatbot-agent/data/code-index.db)
7. Serve search results via /code/search endpoint
8. Incremental updates: git pull + re-index changed files only
```

### Search Flow (at query time)

```
Admin: "What is net sales today?"

1. LLM classifies as "data_with_code" (needs business logic)
2. Agent searches code index via BM25 for: "net sales", "calculate sales", "revenue"
3. Returns top 5-10 relevant code chunks:
   - app/services/sales_calculator.rb:45-80 (net_sales method)
   - app/models/order.rb:12-30 (scope definitions)
4. These chunks are included in the LLM prompt alongside DB schema
5. LLM reads code → understands: net_sales = gross - refunds - discounts
6. LLM generates correct SQL based on actual business logic
```

### Scalability for Large Codebases

| Codebase Size | Files | Chunks | Index Size | Index Time |
|---------------|-------|--------|------------|------------|
| Small | < 500 | ~2K | ~10MB | < 30s |
| Medium | 500-5K | ~20K | ~100MB | 1-3 min |
| Large | 5K-50K | ~200K | ~1GB | 5-15 min |

For large codebases (10K+ files):
- **Shallow clone** (`--depth=1`) — skip git history, clone only latest
- **Incremental re-index** — only re-index files changed since last `git pull`
- **File limit** — configurable max files to index (default: 10K)
- **Directory allowlist** — admin can specify which directories to index (e.g., `app/`, `lib/`)

---

## Auto-Discovery — Enhanced (No Manual Seeding)

### What Gets Auto-Detected

| Detection | How | Example |
|-----------|-----|---------|
| **Enums** | Sample distinct values from int columns with cardinality < 50 | status: {1: 245, 2: 18, 3: 92} |
| **Enum labels** | LLM (Ollama) analyzes column name + values + code context | status 1 = "Active", 2 = "Inactive", 3 = "Deleted" |
| **Relationships** | Explicit FKs + inferred from `*_id` naming | jobs.created_by → customers.id |
| **Soft deletes** | Found `deleted_at` or status with "deleted" value | "Exclude status=3 by default" |
| **Stale columns** | Cache columns where all values are 0/NULL | contractors.completed_jobs_count (all 0) |
| **Business terms** | LLM infers from table/column names + code | "workers" = contractors table |

### [FIX I6] Discovery Pipeline (runs entirely on agent)

```
1. Schema scan → tables, columns, types, FKs, indexes, comments (agent → DB)
2. Data sampling → distinct values for enum-like columns (agent → DB)
3. Code search → find enum definitions, model associations (agent → code index)
4. LLM analysis → Ollama on agent combines schema + samples + code:
   - Generate enum label suggestions
   - Infer business rules
   - Detect term synonyms
5. Store as structured metadata on agent (SQLite)
6. Serve to extension via /discovery/results
7. Admin can override via /discovery/override (corrections saved on agent)
```

### [FIX from V1 Regression] Knowledge Override System

V1 had hand-curated semantic context (23 entries for MSP). V2 auto-discovers but allows manual corrections:

```
Extension popup → "Discovery Results" tab:
  ┌─────────────────────────────────────────────┐
  │  Detected Enums                              │
  │                                              │
  │  jobs.status:                                │
  │    1 → "Active" ✅  [Edit]                   │
  │    2 → "Inactive" ✅  [Edit]                 │
  │    3 → "Deleted" ✅  [Edit]                  │
  │    4 → "Pending" ❌  [Fix: "Verified"]       │
  │                                              │
  │  Detected Relationships                      │
  │    jobs.created_by → customers.id ✅         │
  │    jobs.property_id → properties.id ✅       │
  │                                              │
  │  Stale Columns (all zeros/NULL)              │
  │    contractors.completed_jobs_count ⚠️        │
  │    [Mark as stale] [Keep]                    │
  │                                              │
  │  + Add Custom Rule                           │
  └─────────────────────────────────────────────┘
```

### Schema Filtering for Large Databases

For databases with 1000+ tables, the full schema won't fit in the LLM context window. Use a **two-pass approach**:

```
Pass 1 (fast): Table selection
  - LLM receives only table names + brief descriptions
  - "Which tables are relevant to: 'How many active contractors?'"
  - LLM returns: ["contractors", "jobs"] (5-10 tables max)

Pass 2 (detailed): SQL generation
  - LLM receives full column details for selected tables only
  - Generates SQL with complete schema context
  - Fits within 32K context window even for huge databases
```

---

## Chat Flow — End to End

```
1. Admin types: "What is net sales today?"

2. Content script captures:
   - Question text
   - Page context (current URL, title, navigation)
   - Sends to background worker via chrome.runtime.sendMessage()

3. Background worker:
   a. Forwards to agent: POST /llm/classify
      → Response: "data_with_code" (needs SQL + code context)

   b. Parallel requests to agent:
      - POST /code/search { query: "net sales" } → code chunks
      - GET /db/schema?relevant_to="net sales" → relevant tables
      - GET /discovery/results → enum mappings, business rules

   c. Sends all context to agent: POST /llm/generate-sql
      → Agent builds prompt with schema + code + enums + history
      → Agent calls Ollama
      → Streams back: { sql, explanation }

   d. Agent validates SQL (allowlist approach)
      → If invalid: returns error, asks LLM to retry

   e. Agent executes SQL: POST /db/query internally
      → Read-only transaction, 500 row cap

   f. Sends results to agent: POST /llm/answer
      → Agent calls Ollama with results + question
      → Streams answer tokens back to extension

4. Background worker relays streamed tokens to content script

5. Content script displays:
   - Streaming answer in chat widget
   - SQL query (expandable, for transparency)
   - Source attribution: "Based on: sales_calculator.rb"

6. Answer text saved to IndexedDB (NO raw SQL results stored)
```

---

## Error Handling and Recovery

### [FIX I1] Error States

| Error | User Experience | Recovery |
|-------|----------------|----------|
| **Agent unreachable** | Widget shows: "Agent offline. Start your agent or check connection." + link to troubleshooting | Auto-retry every 30s. Extension popup shows red status indicator. |
| **Agent locked** | Widget shows: "Session expired. Click to unlock." → popup opens passphrase prompt | Re-enter passphrase in extension popup. |
| **Database connection lost** | Widget shows: "Database connection lost. Your agent is reconnecting..." | Agent auto-retries with exponential backoff (1s, 2s, 4s, max 30s). |
| **Ollama not running** | Widget shows: "LLM not available. Start Ollama or choose a different engine in settings." | Extension popup shows Ollama install guide. |
| **WebLLM model download fails** | Progress bar shows. "Download interrupted. Click to retry." | Resume download from where it stopped (HTTP range requests). |
| **WebGPU not available** | Settings shows: "Your browser doesn't support WebGPU. Using Ollama instead." | Auto-fallback to Ollama if available. |
| **SQL generation fails** | Widget shows: "I couldn't generate a query for that. Try rephrasing." | Show the error to admin, log for debugging. |
| **SQL execution fails** | Widget shows: "Query failed: [pg error message]. Try a different question." | Log full error on agent. |
| **Git clone fails** | Setup shows: "Could not clone repository. Check URL and token." | Retry button. Code features disabled until fixed. |
| **IndexedDB quota exceeded** | Auto-cleanup: delete oldest chat history, then oldest crawled pages | Warn admin if approaching limit. |
| **Rate limit hit** | Widget shows: "Too many requests. Wait a moment." | Auto-retry after cooldown. |

### Offline Behavior

When the agent is unreachable:
- **Navigation mode works** — uses cached crawled pages in IndexedDB
- **Data/Code modes fail gracefully** — "Agent offline" message
- **Chat history accessible** — stored locally
- **Settings accessible** — stored locally

---

## Update and Migration Strategy

### [FIX I2] Versioning

```
Version Protocol:
  1. Extension sends its version on first connect: GET /auth/status
  2. Agent returns its version in response
  3. If major versions don't match → show "Update required" message
  4. If minor versions differ → warn but allow (backward compatible)

Semantic Versioning:
  Extension: 2.x.y
  Agent: 2.x.y
  Compatibility: major version must match
```

**Extension updates**: Auto-updated via Chrome Web Store. IndexedDB migrations run on extension update via versioned upgrade handlers in idb library.

**Agent updates**: `npm update -g @yourproduct/agent`. Agent checks for updates on start, notifies admin if outdated. Encrypted vault format versioned — migrations run automatically.

**Model updates**: New Ollama models pulled via `ollama pull`. Extension settings show available models.

---

## Testing Strategy

### [FIX I7] Test Plan

**Agent (Node.js):**
- Unit tests: Jest for SQL validator, encryption, code indexer, discovery
- Integration tests: Supertest for API endpoints with test PostgreSQL
- Security tests: Verify SQL injection attempts blocked, verify read-only enforcement
- Load tests: Verify rate limiting works

**Extension:**
- Unit tests: Vitest for React components, message routing, storage layer
- E2E tests: Playwright with Chrome extension loading
- Manual testing: Matrix of LLM engines × question types × database sizes

**Combined:**
- E2E: Playwright opens Chrome with extension → connects to test agent → asks 20 V1 test questions
- Regression: V1 test suite (20 dumb-admin questions) must pass with Ollama + 7B model
- Security: Penetration testing checklist (OWASP top 10 for extensions)

---

## Logging and Debugging

### [FIX M4] Debug Mode

**Agent logging** (always on, structured JSON):
```json
{
  "timestamp": "2026-02-24T10:30:00Z",
  "level": "info",
  "event": "sql_query",
  "sql": "SELECT COUNT(*) FROM contractors WHERE status = 1",
  "execution_time_ms": 45,
  "row_count": 1
  // NEVER logs: credentials, connection strings, passphrase
}
```

Log location: `~/.chatbot-agent/logs/agent.log` (rotated, max 50MB)

**Extension debug mode** (opt-in via settings):
- Console output for message routing, LLM calls, crawl progress
- Enabled via: Settings → Debug Mode → ON
- Shows: classification results, SQL generated, agent response times
- Hidden by default in production

**Diagnostic export**:
- Extension popup → Settings → "Export Debug Info"
- Exports: agent health, extension version, LLM engine status, last 10 errors
- **NEVER exports**: credentials, session tokens, chat content, SQL results

---

## Customer Setup Experience

### Total time: ~5 minutes

```
Step 1: Install Chrome Extension (30 seconds)
  → Chrome Web Store → "Add to Chrome" → Done

Step 2: Install Agent + Ollama on server (2-3 minutes)
  → npm install -g @yourproduct/agent
  → yourproduct-agent start
  → Agent auto-installs Ollama if not present
  → Agent pulls default model (Qwen2.5-Coder-7B, ~4.5GB, one time)
  → Agent opens https://127.0.0.1:9876/setup

Step 3: Configure in Agent Setup UI (60 seconds)
  ┌─────────────────────────────────────────────┐
  │  🔒 Secure Setup                            │
  │  All credentials encrypted in your browser  │
  │  before transmission.                       │
  │                                              │
  │  Create a passphrase:                        │
  │  [••••••••••••••]                            │
  │  (Used to encrypt/decrypt your secrets)      │
  │                                              │
  │  Database Connection:                        │
  │  [postgresql://reader:pass@localhost/mydb  ] │
  │  ⚠️  Use a READ-ONLY database user!          │
  │  [ ] I confirm this is a read-only user      │
  │                                              │
  │  Git Repository (optional):                  │
  │  [https://github.com/myorg/myapp           ] │
  │  Access Token: [ghp_xxxxxxxxxxxx           ] │
  │  💡 Use a read-only token (Contents only)    │
  │                                              │
  │  [Save & Connect]                            │
  │                                              │
  │  ✅ Credentials encrypted locally            │
  │  ✅ Database connected (45 tables, read-only)│
  │  ✅ Git repo cloned (234 files indexed)      │
  │  ✅ Auto-discovery complete (12 enums found) │
  │  ✅ Ollama ready (Qwen2.5-Coder-7B loaded)  │
  └─────────────────────────────────────────────┘

Step 4: Open your admin panel (30 seconds)
  → Click extension icon on your admin page
  → Chat widget appears in bottom-right
  → Click "Crawl this site" (one time, 30-90 seconds)
  → Done. Start asking questions.
```

### Multi-User Support

Multiple admins at the same company can use the chatbot:
- Each admin installs the Chrome extension on their machine
- All connect to the SAME agent (running on the server)
- Each admin unlocks with the SAME passphrase (shared company secret)
- Each gets their own session token (independent sessions)
- Chat history is per-browser (stored locally in each admin's IndexedDB)
- Agent supports multiple concurrent sessions (token-based, no session state)

---

## Revenue Model

### [FIX M3] Enforcement

**Option 1: Paid Extension with Agent License (Recommended for launch)**
- **Free tier**: 1 project, 50 questions/day, data mode only
- **Pro**: $29/month — unlimited projects, all modes
- **Enforcement**: Agent requires a license key (validated once per day via lightweight API call)
  - License key is entered during agent setup, stored in encrypted vault
  - Agent checks license on start + every 24 hours
  - If license check fails (server down), grace period of 7 days
  - License server is the ONLY cloud touchpoint — does not receive any customer data
  - If user patches the extension to skip check, the agent still enforces it

---

## Tech Stack

### Chrome Extension
- **Manifest V3** (latest Chrome extension standard)
- **React 19** + TypeScript (popup UI, widget)
- **@anthropic-ai/sdk** or **@mlc-ai/web-llm** (optional, for in-browser LLM)
- **idb** library for IndexedDB
- **Vite** for building

### Local Agent
- **Node.js 20+** with TypeScript
- **Fastify** for REST API (faster than Express, built-in validation)
- **pg** (node-postgres) for database connection
- **pg-query-parser** for SQL allowlist validation
- **simple-git** for git operations
- **better-sqlite3** for local code index + discovery storage
- **natural** for BM25 text search (code RAG)
- **argon2** for passphrase key derivation
- **node:crypto** for AES-256-GCM encryption + TLS cert generation
- Published as npm package: `@yourproduct/agent`

### Shared
- **TypeScript types** shared between extension and agent (monorepo)
- **SQL validation logic** shared (runs in both, agent is authoritative)
- **Pluggable interfaces** for LLM, DataSource, CodeSource, Storage

---

## What We Reuse From V1

| V1 Component | V2 Usage |
|-------------|----------|
| SQL validation rules | Port to TypeScript, upgrade to allowlist approach |
| System prompts | Reuse and adapt for Ollama (Qwen2.5-Coder-7B) |
| Widget UI/UX | Adapt for content script injection in Shadow DOM |
| Auto-discovery logic | Port schema inspection + data sampling to Node.js |
| Chat flow architecture | Same classify → generate → execute → answer pipeline |
| Safety rules | Same read-only enforcement, upgraded to allowlist |
| Knowledge categories | Same enum_mapping, business_rule, etc. structure |
| 20-question test suite | Regression tests for V2 LLM quality validation |

## What's New in V2

| Component | Description |
|-----------|------------|
| Chrome Extension (Manifest V3) | Popup + content script + background worker + offscreen doc |
| Local Node.js agent | DB + Git + Ollama bridge with encrypted vault |
| Ollama integration | Local LLM on agent, no third-party API dependency |
| Code indexing + BM25 RAG | Text-based code search for business logic understanding |
| Page crawler | SPA-aware extraction of navigation, forms, tables from live pages |
| Browser actions | Framework-aware DOM interaction (React/Vue/Angular compatible) |
| Pluggable interfaces | Swap LLM, DataSource, CodeSource, Storage implementations |
| Agent setup UI | Client-side encrypted credential entry |
| Enhanced auto-discovery | LLM-powered enum labels + admin override system |
| Security hardening | HTTPS, origin binding, token rotation, allowlist SQL validation |
| Knowledge override | Admin can correct auto-discovered labels via extension UI |
| Schema filtering | Two-pass approach for databases with 1000+ tables |

---

## Audit Trail

### v1 (2026-02-24): Initial design
### v2 (2026-02-24): Audit fixes applied

| ID | Severity | Issue | Fix Applied |
|----|----------|-------|-------------|
| C1 | CRITICAL | Service worker kills WebLLM mid-inference | LLM moved to agent (Ollama) or offscreen document. Background worker is message-only. |
| C2 | CRITICAL | 3B model insufficient for SQL generation | Default changed to Ollama + Qwen2.5-Coder-7B. WebLLM is optional. POC required before full build. |
| C3 | CRITICAL | Content script CORS blocks agent fetch | All agent calls route through background worker. Message flow diagram added. |
| C4 | CRITICAL | Session token unencrypted in IndexedDB | Token stored in chrome.storage.session (memory-only). Origin binding, 4h expiry, per-request rotation. |
| C5 | CRITICAL | Setup sends plaintext credentials over HTTP | Agent serves HTTPS. Client-side encryption via Argon2id + AES-256-GCM before transmission. |
| I1 | IMPORTANT | No error handling defined | Full error state table with user experience and recovery for each failure. |
| I2 | IMPORTANT | No update/migration strategy | Version protocol, semantic versioning, IndexedDB migrations, agent update path. |
| I3 | IMPORTANT | Crawler fails on SPAs | SPA-aware crawling with MutationObserver, same-tab navigation, framework detection. |
| I4 | IMPORTANT | `<all_urls>` causes CWS review delays | Removed. Using `activeTab` + programmatic injection via chrome.scripting.executeScript. |
| I5 | IMPORTANT | SQL denylist is incomplete | Switched to allowlist via pg-query-parser. Only SELECT permitted. Agent is authoritative validator. |
| I6 | IMPORTANT | Discovery needs LLM but LLM is in browser | Discovery runs entirely on agent. Ollama handles LLM analysis. No circular dependency. |
| I7 | IMPORTANT | No testing strategy | Test plan added: unit (Jest/Vitest), integration (Supertest), E2E (Playwright), security, regression. |
| I8 | IMPORTANT | PII in chat history | Auto-expiry (7 days), no raw SQL results stored, clear button, opt-out option, PII warning. |
| M1 | MINOR | 4 modes vs 3 classifier outputs | Classifier expanded to 5 types: data, data_with_code, navigation, action, guidance. |
| M2 | MINOR | Naive DOM actions fail with React/Vue | Framework-aware fillField using React fiber setter and InputEvent sequences. |
| M3 | MINOR | Revenue model unenforceable | License key validated by agent (not extension). Grace period for offline. |
| M4 | MINOR | No logging/debugging | Structured agent logging, extension debug mode, diagnostic export (never exports secrets). |
| M5 | MINOR | Large schema in IndexedDB | Schema fetched from agent on demand, not cached in IndexedDB. Two-pass approach for 1000+ tables. |
