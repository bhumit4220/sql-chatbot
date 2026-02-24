# SQL Chatbot V2 — Chrome Extension + Local Agent Design

> **Date**: 2026-02-24
> **Status**: Approved (v4 — simplified LLM architecture: Ollama removed, OpenAI API via agent proxy)
> **Branch**: v2-development
> **Depends on**: V1 complete (Phases 1-12, all passing)

---

## Problem

The V1 chatbot works but is **too complex to deploy and sell**:
- Requires Docker, API setup, manual JSON seeding, widget embed
- 9 setup steps — customers leave at step 3
- Hosted model means server costs and data privacy concerns
- Manual semantic context seeding per project
- Hosted model means ongoing server costs per question

## Goal

**Install a Chrome extension. Connect your database. Ask questions in plain English. Agent runs on your machine — credentials never leave your network.**

- Agent runs on customer's own server/machine (DB + git access stays local)
- LLM via OpenAI API (GPT-4o-mini default) — swappable to any provider later
- Zero manual semantic seeding (auto-discovery + code understanding)
- Works with any web app, any tech stack, any database
- All secrets (DB creds, git tokens, API keys) stored in agent's encrypted vault — extension NEVER sees them

---

## Product Capabilities

### 1. DATA Mode — Query the Database
> "How many active contractors?" → SQL query → answer

The bot generates SQL from natural language, executes against the customer's database (read-only), and returns a human-friendly answer.

### 2. CODE Mode — Understand Business Logic
> "What is net sales today?" → reads code to find formula → generates correct SQL
> "How is net sales calculated?" → reads code → explains the formula directly
> "What happens when a job is completed?" → finds service object → explains the workflow

The bot searches indexed codebase to find calculation logic, business rules, and domain knowledge. Two uses:
- **Code + SQL**: Combines code understanding with database schema to generate accurate queries (e.g., "What is net sales today?" needs the formula from code to write correct SQL)
- **Code-only answers**: Answers logical/architectural questions directly from code without generating SQL (e.g., "How does contractor payout work?", "What validations run on signup?", "What happens when a job is cancelled?")

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

### Question Classification (6 types)

The classifier outputs 6 types that map to the 4 modes:

| Classifier Output | Mode | Description |
|-------------------|------|-------------|
| `data` | DATA | Simple SQL — schema is enough |
| `data_with_code` | CODE | SQL but needs business logic from code first |
| `code` | CODE | Logical/architectural question — answer directly from code, no SQL needed |
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
│  │  NO API keys         │               │              │
│  └──────────────────────┘               │              │
└─────────────────────────────────────────┼──────────────┘
                                          │
                              127.0.0.1:9876 (HTTP)
                              session token + origin check
                                          │
┌─────────────────────────────────────────▼──────────────┐
│  Local Agent — Node.js (ALL secrets stay here)          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Encrypted Vault (AES-256-GCM)                    │  │
│  │  Key derived from: passphrase via Argon2id        │  │
│  │  Contains: DB creds, git tokens, OpenAI API key   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ DB       │ │ Git      │ │ Discovery│ │ LLM Proxy │  │
│  │ Module   │ │ Module   │ │ Module   │ │ Module    │  │
│  │          │ │          │ │          │ │           │  │
│  │ •Connect │ │ •Clone   │ │ •Schema  │ │ •Classify │  │
│  │ •Schema  │ │ •Index   │ │ •Enums   │ │ •SQL Gen  │  │
│  │ •Execute │ │ •Search  │ │ •FKs     │ │ •Answer   │  │
│  │  SQL     │ │ •Serve   │ │ •Stale   │ │ •Stream   │  │
│  │(readonly)│ │(readonly)│ │ •Labels  │ │           │  │
│  └────┬─────┘ └────┬─────┘ └──────────┘ └─────┬─────┘  │
│       │            │                           │        │
│  Listens: 127.0.0.1 ONLY (never 0.0.0.0)      │        │
│  HTTP on localhost (HTTPS deferred, see N2 fix) │        │
│  Origin validation: only chrome-extension://<id>│        │
│  Session token: 4-hour expiry, rotated/request  │        │
│  Rate limited: 60 req/min                       │        │
└───────┼────────────┼───────────────────────────┼────────┘
        │            │                           │
┌───────▼────┐ ┌─────▼───────┐          ┌───────▼────────┐
│  Database  │ │  Git Repo   │          │  OpenAI API    │
│ (read-only │ │ (read-only  │          │ (GPT-4o-mini)  │
│  user)     │ │  clone)     │          │  Key from vault│
└────────────┘ └─────────────┘          └────────────────┘
```

### Message Flow — CRITICAL

Content scripts **cannot** fetch `127.0.0.1` directly due to CORS restrictions in Manifest V3. All communication MUST route through the background worker:

```
Content Script                Background Worker              Agent
     │                              │                          │
     │  chrome.runtime.sendMessage  │                          │
     │  ─────────────────────────►  │                          │
     │                              │   fetch('http://        │
     │                              │   127.0.0.1:9876/...')   │
     │                              │  ─────────────────────►  │
     │                              │                          │
     │                              │  ◄─────────────────────  │
     │  ◄─────────────────────────  │                          │
     │   response via sendResponse  │                          │
```

---

## LLM Strategy

### [v4 UPDATE] OpenAI API via Agent Proxy (Ollama Removed)

**Why this changed:** Ollama required a 4.7GB model download (~30-40 min on typical connections), 8GB+ RAM, and was a terrible first-run experience. GPT-4o-mini is already proven (V1 passes all 20 test questions) and requires zero setup.

**Default: OpenAI GPT-4o-mini via agent proxy**

The agent holds the OpenAI API key in its encrypted vault and proxies all LLM calls. The extension never sees the API key.

```
LLM Call Flow:
  Extension → Agent (question + context)
  Agent → decrypts OpenAI key from vault
  Agent → calls api.openai.com (HTTPS)
  Agent → streams response back to extension
  Extension → displays answer
```

**Why OpenAI via agent (not direct from extension):**
- API key stays in encrypted vault — extension NEVER sees it
- Agent can add schema/code context before calling LLM
- Single point of control for rate limiting, logging, prompt engineering
- Swapping LLM provider requires zero extension changes

### Swappable LLM Provider

The LLM module is behind a pluggable interface. Changing provider = implement the interface + update config:

```
Implementations:
  ├── OpenAIEngine (default) — GPT-4o-mini via agent, key in vault
  ├── GroqEngine (future) — free tier, fast inference
  ├── AnthropicEngine (future) — Claude as alternative
  └── OllamaEngine (future) — for privacy-conscious users who want fully local
```

No architecture change needed to swap providers. The extension doesn't know or care which LLM backend the agent uses.

### No LLM in Service Worker or Browser

The background service worker NEVER runs LLM inference. It only routes messages. All LLM calls go through the agent. This avoids:
- MV3 service worker termination (5 min idle timeout kills loaded models)
- Large model downloads in browser
- WebGPU dependency

### Discovery LLM

The discovery pipeline (enum label inference, business term detection) also uses the OpenAI API via the agent:

```
Agent Discovery Pipeline:
  1. Schema scan (agent → DB)
  2. Data sampling (agent → DB)
  3. Code search (agent → git index)
  4. LLM analysis (agent → OpenAI API)
     - Input: column names + sampled values + code snippets
     - Output: enum labels, business rules, term synonyms
  5. Store results on agent
  6. Serve to extension via /discovery/results
```

### POC Requirement — REMOVED

GPT-4o-mini is already proven in V1 (20/20 dumb-admin questions passing). No separate POC needed.

---

## Pluggable Interfaces

Everything behind interfaces so components can be swapped later.

### LLM Engine Interface
```typescript
interface LLMEngine {
  classify(question: string, context: ClassifyContext): Promise<QuestionType>
  // QuestionType: "data" | "data_with_code" | "code" | "navigation" | "action" | "guidance"
  generateSQL(question: string, context: SQLContext): Promise<SQLResult>
  streamAnswer(question: string, context: AnswerContext): AsyncIterable<string>
  isReady(): Promise<boolean>
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

Implementations:
  ├── OpenAIEngine (default) — GPT-4o-mini, API key in agent vault
  ├── GroqEngine (future) — free tier, Llama models
  ├── AnthropicEngine (future) — Claude models
  └── OllamaEngine (future) — local inference for privacy-conscious users
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

The agent setup page runs on the agent (`http://127.0.0.1:9876/setup`) but is rendered **in the browser**. Credentials must be encrypted before leaving the browser form:

```
Setup Flow (secure):
  1. Admin opens agent setup page: http://127.0.0.1:9876/setup
  2. Agent serves setup HTML with embedded JavaScript
  3. Admin enters passphrase → JS derives encryption key via Argon2id WASM (hash-wasm library — native argon2 doesn't run in browser, see N4 fix)
  4. Admin enters DB URL, git token, OpenAI API key
  5. JS encrypts all secrets client-side using the derived key (AES-256-GCM)
  6. JS sends ONLY encrypted blobs to agent:
     POST /setup/configure
     Body: {
       passphrase_hash: "argon2id hash for verification",
       encrypted_db_url: "base64(AES-GCM encrypted)",
       encrypted_git_token: "base64(AES-GCM encrypted)",
       encrypted_llm_api_key: "base64(AES-GCM encrypted)",
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
| **Token rotation** | New token issued on every request. Previous token valid for 5-second grace window (supports parallel requests, see N1 fix). Replay after grace = instant rejection. |
| **Encrypted at rest** | Stored in `chrome.storage.session` (memory-only, cleared on browser close). NOT in IndexedDB. |
| **Scope limiting** | Token encodes allowed operations. Read-only token cannot be upgraded. |
| **IP binding** | Token bound to 127.0.0.1 — only localhost requests accepted. |

### [FIX C5 + N2] Agent HTTP on Localhost (HTTPS deferred)

The agent serves on **`http://127.0.0.1:9876`** for V1 launch:

```
Why HTTP on localhost (not HTTPS):
  - Self-signed certs cause NET::ERR_CERT_AUTHORITY_INVALID in Chrome fetch()
  - host_permissions do NOT bypass certificate validation for fetch() calls
  - Localhost is exempt from mixed-content browser restrictions
  - Real security comes from: origin binding, session tokens, 127.0.0.1-only binding
  - HTTPS on localhost adds significant UX friction for marginal security gain

Security still enforced without HTTPS:
  - Agent binds to 127.0.0.1 ONLY (not 0.0.0.0) — no network exposure
  - Origin validation: only chrome-extension://<registered-id> accepted
  - Session token required on every request
  - Token rotation with 5s grace window
  - Rate limiting: 60 req/min

Future upgrade path (post-launch):
  - Use mkcert to auto-generate locally-trusted certs during agent setup
  - mkcert creates a local CA, installs it in system trust store
  - Transparent to user — no manual cert steps
  - Upgrade to HTTPS when mkcert integration is stable
```

### What Lives Where

| Secret | Stored Where | Encrypted | Extension Sees? |
|--------|-------------|-----------|-----------------|
| DB credentials | Agent encrypted vault | AES-256-GCM (Argon2id key) | NEVER |
| Git token | Agent encrypted vault | AES-256-GCM (Argon2id key) | NEVER |
| OpenAI API key | Agent encrypted vault | AES-256-GCM (Argon2id key) | NEVER |
| Passphrase | Nowhere (admin's memory) | N/A | Transient only (to unlock) |
| Session token | chrome.storage.session (memory) | Memory-only, cleared on close | Yes (only this) |
| Schema cache | Agent | Not secret | Via API only |
| Code index | Agent | Not secret | Via API only |
| Chat history | Extension (IndexedDB) | See PII section below | Yes |
| Crawled pages | Extension (IndexedDB) | Not secret | Yes |

### Agent Security

- **Listens on 127.0.0.1 ONLY** — never 0.0.0.0, never accessible from network
- **HTTP on localhost** — 127.0.0.1 only (HTTPS deferred to post-launch via mkcert, see N2 fix)
- **Origin validation** — only accepts requests from `chrome-extension://<registered-id>`
- **Session token required** on every API request (except `/auth/status`)
- **Token rotation** — new token per request, old token valid for 5s grace window (parallel request support)
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

1. Parse SQL via pg-query-parser or fallback: pgsql-ast-parser / node-sql-parser (verify package viability during POC — see N3 fix)
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

### Base: `http://127.0.0.1:9876` (HTTP on localhost, see N2 fix)

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
    encrypted_llm_api_key: "AES-GCM encrypted blob",
    salt: "random 32-byte salt",
    iv: "random 12-byte IV"
  }
  Returns: { success: bool, session_token: "..." }
  (Stores encrypted blobs, tests DB + OpenAI connections after unlock)

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

### LLM Endpoints (OpenAI API proxy)
```
POST /llm/classify
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, schema_summary, page_context, history }
  Returns: { type: "data"|"data_with_code"|"code"|"navigation"|"action"|"guidance", new_session_token }
  (Agent decrypts OpenAI key from vault → calls GPT-4o-mini → returns classification)

POST /llm/generate-sql
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, schema, code_context, enums, history }
  Returns: SSE stream of { sql, explanation } then tokens
  (Agent decrypts key → calls OpenAI → streams response back)

POST /llm/answer
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, sql_results, question_type, history, page_context }
  Returns: SSE stream of answer tokens

POST /llm/answer-from-code
  Header: X-Session-Token: ..., Origin: chrome-extension://<id>
  Body: { question, code_chunks, history, page_context }
  Returns: SSE stream of answer tokens
  (For "code" type questions — answers directly from code context, no SQL involved)
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
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": ["http://127.0.0.1:9876/*"],  // HTTP on localhost (see N2 fix)
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
    agent_url: string,  // always http://127.0.0.1:9876
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
    llm_provider: "openai" | "groq" | "anthropic" | "ollama",  // default: openai, swappable later
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
| **Enum labels** | LLM (OpenAI) analyzes column name + values + code context | status 1 = "Active", 2 = "Inactive", 3 = "Deleted" |
| **Relationships** | Explicit FKs + inferred from `*_id` naming | jobs.created_by → customers.id |
| **Soft deletes** | Found `deleted_at` or status with "deleted" value | "Exclude status=3 by default" |
| **Stale columns** | Cache columns where all values are 0/NULL | contractors.completed_jobs_count (all 0) |
| **Business terms** | LLM infers from table/column names + code | "workers" = contractors table |

### Discovery Pipeline (runs entirely on agent)

```
1. Schema scan → tables, columns, types, FKs, indexes, comments (agent → DB)
2. Data sampling → distinct values for enum-like columns (agent → DB)
3. Code search → find enum definitions, model associations (agent → code index)
4. LLM analysis → agent calls OpenAI API, combines schema + samples + code:
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

### Flow A: Data questions (type: `data` or `data_with_code`)

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
      - POST /code/search { query: "net sales" } → code chunks (skipped for "data" type)
      - GET /db/schema?relevant_to="net sales" → relevant tables
      - GET /discovery/results → enum mappings, business rules

   c. Sends all context to agent: POST /llm/generate-sql
      → Agent builds prompt with schema + code + enums + history
      → Agent calls OpenAI API (key from vault)
      → Streams back: { sql, explanation }

   d. Agent validates SQL (allowlist approach)
      → If invalid: returns error, asks LLM to retry

   e. Agent executes SQL: POST /db/query internally
      → Read-only transaction, 500 row cap

   f. Sends results to agent: POST /llm/answer
      → Agent calls OpenAI with results + question
      → Streams answer tokens back to extension

4. Background worker relays streamed tokens to content script

5. Content script displays:
   - Streaming answer in chat widget
   - SQL query (expandable, for transparency)
   - Source attribution: "Based on: sales_calculator.rb" (if code was used)

6. Answer text saved to IndexedDB (NO raw SQL results stored)
```

### Flow B: Code-only questions (type: `code`)

```
1. Admin types: "How does contractor payout work?"

2. Content script captures question + page context
   → Sends to background worker

3. Background worker:
   a. Forwards to agent: POST /llm/classify
      → Response: "code" (answer from code, no SQL needed)

   b. Agent searches code index:
      - POST /code/search { query: "contractor payout" } → code chunks
      - Multiple search terms if needed (synonyms, related concepts)

   c. Sends code context to agent: POST /llm/answer
      → Agent builds prompt with code chunks + question + history
      → Agent calls OpenAI API (key from vault)
      → Streams explanation back to extension
      → NO SQL generation, NO database query

4. Background worker relays streamed tokens to content script

5. Content script displays:
   - Streaming answer explaining the logic/workflow
   - Source attribution: "Based on: contractor_payout_service.rb:45-80"
   - No SQL section shown

6. Answer text saved to IndexedDB
```

---

## Error Handling and Recovery

### [FIX I1] Error States

| Error | User Experience | Recovery |
|-------|----------------|----------|
| **Agent unreachable** | Widget shows: "Agent offline. Start your agent or check connection." + link to troubleshooting | Auto-retry every 30s. Extension popup shows red status indicator. |
| **Agent locked** | Widget shows: "Session expired. Click to unlock." → popup opens passphrase prompt | Re-enter passphrase in extension popup. |
| **Database connection lost** | Widget shows: "Database connection lost. Your agent is reconnecting..." | Agent auto-retries with exponential backoff (1s, 2s, 4s, max 30s). |
| **OpenAI API error** | Widget shows: "LLM service unavailable. Check your API key or try again." | Agent retries once. If persistent, admin checks API key in agent setup. |
| **OpenAI rate limit** | Widget shows: "API rate limit reached. Please wait a moment." | Auto-retry with exponential backoff. |
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

**LLM provider updates**: Swap provider by updating agent config. New providers added via pluggable LLMEngine interface.

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
- Regression: V1 test suite (20 dumb-admin questions) must pass with OpenAI GPT-4o-mini
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

### Total time: ~3 minutes

```
Step 1: Install Chrome Extension (30 seconds)
  → Chrome Web Store → "Add to Chrome" → Done

Step 2: Install Agent on server (30 seconds)
  → npm install -g @yourproduct/agent
  → yourproduct-agent start
  → Agent opens http://127.0.0.1:9876/setup

Step 3: Configure in Agent Setup UI (60 seconds)
  ┌─────────────────────────────────────────────┐
  │  Secure Setup                               │
  │  All credentials encrypted in your browser  │
  │  before transmission.                       │
  │                                              │
  │  Create a passphrase:                        │
  │  [**************]                            │
  │  (Used to encrypt/decrypt your secrets)      │
  │                                              │
  │  OpenAI API Key:                             │
  │  [sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx      ] │
  │  Get one at: platform.openai.com/api-keys   │
  │                                              │
  │  Database Connection:                        │
  │  [postgresql://reader:pass@localhost/mydb  ] │
  │  Use a READ-ONLY database user!             │
  │  [ ] I confirm this is a read-only user      │
  │                                              │
  │  Git Repository (optional):                  │
  │  [https://github.com/myorg/myapp           ] │
  │  Access Token: [ghp_xxxxxxxxxxxx           ] │
  │  Use a read-only token (Contents only)      │
  │                                              │
  │  [Save & Connect]                            │
  │                                              │
  │  Credentials encrypted locally              │
  │  OpenAI API connected (GPT-4o-mini)         │
  │  Database connected (45 tables, read-only)  │
  │  Git repo cloned (234 files indexed)        │
  │  Auto-discovery complete (12 enums found)   │
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
- **idb** library for IndexedDB
- **Vite** for building

### Local Agent
- **Node.js 20+** with TypeScript
- **Fastify** for REST API (faster than Express, built-in validation)
- **pg** (node-postgres) for database connection
- **pg-query-parser** for SQL allowlist validation (fallback: pgsql-ast-parser or node-sql-parser — verify during POC, see N3 fix)
- **simple-git** for git operations
- **better-sqlite3** for local code index + discovery storage
- **openai** (npm package) for OpenAI API calls (GPT-4o-mini default)
- **natural** for BM25 text search (code RAG)
- **argon2** for passphrase key derivation (native, server-side only)
- **hash-wasm** for Argon2id in browser (WASM — used in setup page, see N4 fix)
- **node:crypto** for AES-256-GCM encryption
- Published as npm package: `@yourproduct/agent`

### Shared
- **TypeScript types** shared between extension and agent (monorepo)
- **SQL validation logic** shared (runs in both, agent is authoritative)
- **Pluggable interfaces** for LLM, DataSource, CodeSource, Storage

### [FIX N6] Monorepo Structure (pnpm workspaces)

```
sql-chatbot/
├── pnpm-workspace.yaml
├── package.json              # root: scripts, devDependencies
├── tsconfig.base.json        # shared TS config
├── packages/
│   ├── shared/               # @chatbot/shared
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types/        # shared TypeScript interfaces
│   │       ├── sql-validator/ # SQL allowlist validation (used by both)
│   │       └── constants.ts  # shared constants, enums
│   ├── agent/                # @chatbot/agent
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── server.ts     # Fastify entry point
│   │       ├── vault/        # Argon2id + AES-256-GCM encryption
│   │       ├── db/           # PostgreSQL module
│   │       ├── git/          # Git clone + BM25 code index
│   │       ├── discovery/    # Auto-discovery pipeline
│   │       ├── llm/          # LLM proxy (OpenAI default, swappable)
│   │       ├── auth/         # Session tokens, origin validation
│   │       └── setup/        # Setup HTML page (served by agent)
│   └── extension/            # @chatbot/extension
│       ├── package.json
│       ├── manifest.json     # Manifest V3
│       ├── vite.config.ts
│       └── src/
│           ├── popup/        # React popup UI
│           ├── content/      # Content script (widget, crawler, actions)
│           ├── background/   # Service worker (message router)
│           └── storage/      # IndexedDB layer
└── docs/
    └── plans/
```

---

## What We Reuse From V1

| V1 Component | V2 Usage |
|-------------|----------|
| SQL validation rules | Port to TypeScript, upgrade to allowlist approach |
| System prompts | Reuse and adapt for OpenAI GPT-4o-mini (same model as V1) |
| Widget UI/UX | Adapt for content script injection in Shadow DOM |
| Auto-discovery logic | Port schema inspection + data sampling to Node.js |
| Chat flow architecture | Same classify → generate → execute → answer pipeline |
| Safety rules | Same read-only enforcement, upgraded to allowlist |
| Knowledge categories | Same enum_mapping, business_rule, etc. structure |
| 20-question test suite | Regression tests for V2 LLM quality validation |

## What's New in V2

| Component | Description |
|-----------|------------|
| Chrome Extension (Manifest V3) | Popup + content script + background worker |
| Local Node.js agent | DB + Git + LLM proxy with encrypted vault |
| OpenAI API via agent proxy | GPT-4o-mini default, swappable LLM provider interface |
| Code indexing + BM25 RAG | Text-based code search for business logic understanding |
| Page crawler | SPA-aware extraction of navigation, forms, tables from live pages |
| Browser actions | Framework-aware DOM interaction (React/Vue/Angular compatible) |
| Pluggable interfaces | Swap LLM, DataSource, CodeSource, Storage implementations |
| Agent setup UI | Client-side encrypted credential entry |
| Enhanced auto-discovery | LLM-powered enum labels + admin override system |
| Security hardening | Origin binding, token rotation, allowlist SQL validation, localhost-only |
| Knowledge override | Admin can correct auto-discovered labels via extension UI |
| Schema filtering | Two-pass approach for databases with 1000+ tables |

---

## Audit Trail

### v1 (2026-02-24): Initial design
### v2 (2026-02-24): Audit fixes applied (C1-C5, I1-I8, M1-M5)
### v3 (2026-02-24): Re-audit fixes applied (N1-N7)
### v4 (2026-02-24): Simplified LLM architecture — Ollama removed, OpenAI API via agent proxy

**v4 Changes:**
- Removed Ollama (4.7GB model download = terrible UX, ~30-40 min on typical connections)
- Default LLM: OpenAI GPT-4o-mini via agent proxy (proven in V1, all 20 questions passing)
- OpenAI API key stored in agent's encrypted vault (extension NEVER sees it)
- Removed offscreen document (was only for WebLLM)
- Removed `"offscreen"` manifest permission
- Removed Phase 0 POC (GPT-4o-mini already proven)
- LLM module is behind pluggable interface — swap to Groq/Anthropic/Ollama later
- Setup flow now collects OpenAI API key alongside DB creds and git token
- Setup time reduced from ~5 min to ~3 min (no model download)

| ID | Severity | Issue | Fix Applied |
|----|----------|-------|-------------|
| C1 | CRITICAL | Service worker kills WebLLM mid-inference | LLM runs on agent via OpenAI API proxy. Background worker is message-only. No in-browser LLM. |
| C2 | CRITICAL | 3B model insufficient for SQL generation | Using OpenAI GPT-4o-mini (proven in V1). Swappable via LLMEngine interface. |
| C3 | CRITICAL | Content script CORS blocks agent fetch | All agent calls route through background worker. Message flow diagram added. |
| C4 | CRITICAL | Session token unencrypted in IndexedDB | Token stored in chrome.storage.session (memory-only). Origin binding, 4h expiry, per-request rotation. |
| C5 | CRITICAL | Setup sends plaintext credentials over HTTP | Client-side encryption via Argon2id + AES-256-GCM before transmission. Agent serves HTTP on localhost (HTTPS deferred, see N2). |
| I1 | IMPORTANT | No error handling defined | Full error state table with user experience and recovery for each failure. |
| I2 | IMPORTANT | No update/migration strategy | Version protocol, semantic versioning, IndexedDB migrations, agent update path. |
| I3 | IMPORTANT | Crawler fails on SPAs | SPA-aware crawling with MutationObserver, same-tab navigation, framework detection. |
| I4 | IMPORTANT | `<all_urls>` causes CWS review delays | Removed. Using `activeTab` + programmatic injection via chrome.scripting.executeScript. |
| I5 | IMPORTANT | SQL denylist is incomplete | Switched to allowlist via pg-query-parser. Only SELECT permitted. Agent is authoritative validator. |
| I6 | IMPORTANT | Discovery needs LLM but LLM is in browser | Discovery runs entirely on agent. Agent calls OpenAI API. No circular dependency. |
| I7 | IMPORTANT | No testing strategy | Test plan added: unit (Jest/Vitest), integration (Supertest), E2E (Playwright), security, regression. |
| I8 | IMPORTANT | PII in chat history | Auto-expiry (7 days), no raw SQL results stored, clear button, opt-out option, PII warning. |
| N1 | IMPORTANT | Token rotation breaks parallel requests | 5-second grace window for old tokens. Chat flow makes parallel requests (step 3b) which would fail with instant invalidation. |
| N2 | IMPORTANT | Self-signed HTTPS cert not trusted by Chrome fetch() | Changed to HTTP on 127.0.0.1. Localhost exempt from mixed-content. Real security = origin binding + tokens + localhost-only. HTTPS via mkcert deferred to post-launch. |
| M1 | MINOR | 4 modes vs 3 classifier outputs | Classifier expanded to 6 types: data, data_with_code, code, navigation, action, guidance. `code` type answers logical questions directly from codebase without SQL. |
| M2 | MINOR | Naive DOM actions fail with React/Vue | Framework-aware fillField using React fiber setter and InputEvent sequences. |
| M3 | MINOR | Revenue model unenforceable | License key validated by agent (not extension). Grace period for offline. |
| M4 | MINOR | No logging/debugging | Structured agent logging, extension debug mode, diagnostic export (never exports secrets). |
| M5 | MINOR | Large schema in IndexedDB | Schema fetched from agent on demand, not cached in IndexedDB. Two-pass approach for 1000+ tables. |
| N3 | MINOR | pg-query-parser maintenance status unknown | Verify during POC. Fallbacks identified: pgsql-ast-parser, node-sql-parser. |
| N4 | MINOR | Argon2id native bindings don't run in browser | Setup page uses hash-wasm (WASM) for Argon2id. Agent uses native argon2 package. |
| N5 | MINOR | Chrome may kill idle offscreen documents | N/A — offscreen document removed in v4 (no in-browser LLM). |
| N6 | MINOR | Monorepo structure unspecified | pnpm workspaces with packages/shared, packages/agent, packages/extension. Full directory tree added. |
| N7 | IMPORTANT | CODE mode only described as SQL helper, not standalone | CODE mode is now first-class: answers logical/architectural questions directly from code (no SQL). New classifier type `code`, new `/llm/answer-from-code` endpoint, separate chat flow (Flow B). |
