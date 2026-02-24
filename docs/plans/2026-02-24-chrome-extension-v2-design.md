# SQL Chatbot V2 — Chrome Extension + Local Agent Design

> **Date**: 2026-02-24
> **Status**: Approved
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

**Install a Chrome extension. Connect your database. Ask questions in plain English. Everything runs locally — your data never leaves your machine.**

- Zero server infrastructure (no Docker, no cloud)
- Zero third-party LLM dependency (runs locally in browser)
- Zero manual semantic seeding (auto-discovery + code understanding)
- Works with any web app, any tech stack, any database
- Credentials never touch the browser

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

---

## Architecture — "Smart Split"

Split responsibilities by what MUST run where.

```
┌──────────────────────────────────────────────────┐
│  Chrome Extension (ZERO secrets)                  │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Popup UI │  │ Content  │  │  Background   │  │
│  │ (React)  │  │ Script   │  │  Worker       │  │
│  │          │  │          │  │               │  │
│  │ Settings │  │ Widget   │  │ LLM Engine    │  │
│  │ Projects │  │ Crawler  │  │ (WebLLM)     │  │
│  │ Agent    │  │ Actions  │  │               │  │
│  │ Connect  │  │ DOM Read │  │ Classifier    │  │
│  │          │  │          │  │ SQL Generator │  │
│  └──────────┘  └──────────┘  │ Answer Gen    │  │
│                              └───────┬───────┘  │
│  ┌──────────────────────┐            │          │
│  │  IndexedDB           │            │          │
│  │  (config, crawled    │            │          │
│  │   pages, chat        │            │          │
│  │   history, settings) │            │          │
│  │  NO credentials      │            │          │
│  └──────────────────────┘            │          │
└──────────────────────────────────────┼──────────┘
                                       │
                              localhost:9876
                              (session token auth)
                                       │
┌──────────────────────────────────────▼──────────┐
│  Local Agent — Node.js (ALL secrets stay here)   │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Encrypted Vault (AES-256)                 │  │
│  │  Unlocked by: admin's passphrase           │  │
│  │  Contains: DB creds, git tokens            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────┐  │
│  │ DB Module   │ │ Git Module   │ │ Discovery│  │
│  │             │ │              │ │ Module   │  │
│  │ • Connect   │ │ • Clone repo │ │          │  │
│  │ • Schema    │ │ • Index code │ │ • Schema │  │
│  │ • Execute   │ │ • Search     │ │ • Enums  │  │
│  │   SQL       │ │ • Serve file │ │ • FKs    │  │
│  │ (read-only) │ │ (read-only)  │ │ • Stale  │  │
│  └──────┬──────┘ └──────┬───────┘ └──────────┘  │
│         │               │                        │
│  Listens: 127.0.0.1 ONLY (not 0.0.0.0)         │
│  Auth: session token (expires 24h)               │
│  Rate limited                                    │
└─────────┼───────────────┼────────────────────────┘
          │               │
 ┌────────▼────┐  ┌───────▼───────┐
 │  Database   │  │  Git Repo     │
 │ (read-only  │  │ (read-only    │
 │  user)      │  │  clone)       │
 └─────────────┘  └───────────────┘
```

---

## Pluggable Interfaces

Everything behind interfaces so components can be swapped later.

### LLM Engine Interface
```
interface LLMEngine {
  classify(question, context) → "data" | "guidance" | "action"
  generateSQL(question, schema, codeContext, history) → { sql, explanation }
  generateAnswer(question, results, type, history) → AsyncStream<string>
  isReady() → boolean
  initialize() → Promise<void>
}

Implementations:
  ├── WebLLMEngine (default) — runs Qwen2.5-Coder-3B in browser via WebGPU
  ├── OllamaEngine — calls Ollama on agent (localhost)
  ├── ChromeAIEngine — Chrome built-in Gemini Nano
  └── OpenAIEngine — bring-your-own-key
```

### Data Source Interface
```
interface DataSource {
  getSchema() → TableSchema[]
  executeQuery(sql) → { columns, rows, error }
  discoverEnums() → EnumMapping[]
  discoverRelationships() → Relationship[]
  healthCheck() → boolean
}

Implementations:
  ├── LocalAgentDataSource (default) — calls agent REST API on localhost
  ├── CloudAPIDataSource — calls hosted API (future SaaS)
  └── DirectRESTDataSource — calls PostgREST/Hasura directly (future)
```

### Code Source Interface
```
interface CodeSource {
  search(query) → CodeChunk[]
  getFile(path) → string
  listFiles(pattern) → string[]
  isAvailable() → boolean
}

Implementations:
  ├── AgentCodeSource (default) — agent clones git repo, indexes, serves
  ├── GitHubAPICodeSource — search via GitHub API directly (future)
  └── NoneCodeSource — no code access, skip code understanding
```

### Storage Interface
```
interface Storage {
  get(key) → any
  set(key, value) → void
  query(collection, filter) → any[]
  clear() → void
}

Implementations:
  ├── IndexedDBStorage (default) — browser IndexedDB
  └── AgentStorage — store on agent side (future)
```

---

## Security Model

### Core Principle: Credentials NEVER touch the browser.

### Credential Flow
```
1. Admin installs extension
2. Admin installs agent on server (npm install -g @product/agent)
3. Agent starts → opens localhost:9876/setup
4. Admin enters credentials DIRECTLY in agent's web UI:
   - Passphrase (encrypts all secrets)
   - Database connection string
   - Git repo URL + access token (optional)
5. Agent encrypts everything with passphrase (AES-256)
6. Agent tests connections, runs discovery
7. Agent issues session token → returned to extension
8. Extension stores ONLY the session token
```

### What Lives Where

| Secret | Stored | Encrypted | Extension sees? |
|--------|--------|-----------|----------------|
| DB credentials | Agent only | AES-256 | NEVER |
| Git token | Agent only | AES-256 | NEVER |
| Passphrase | Nowhere (admin's memory) | N/A | NEVER |
| Session token | Extension (IndexedDB) | No (short-lived, 24h) | Yes (only this) |
| Schema cache | Agent | No (not secret) | Via API only |
| Code index | Agent | No (not secret) | Via API only |
| Chat history | Extension (IndexedDB) | Optional | Yes |
| Crawled pages | Extension (IndexedDB) | No (not secret) | Yes |

### Agent Security

- **Listens on 127.0.0.1 ONLY** — not accessible from network
- **Session token required** on every API request
- **Session expires** after 24 hours (configurable)
- **All SQL forced read-only** (SET TRANSACTION READ ONLY)
- **SQL validation** — no DROP, DELETE, INSERT, UPDATE, ALTER, GRANT
- **Git clone is read-only** — no push, no write operations
- **Rate limiting** on all endpoints

### Database Security — Read-Only User Recommended

Agent setup UI guides the admin:
```sql
CREATE USER chatbot_reader WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE mydb TO chatbot_reader;
GRANT USAGE ON SCHEMA public TO chatbot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_reader;
```

### Git Security — Read-Only Token

Agent setup UI guides the admin:
- **GitHub**: Settings → Fine-grained tokens → Read-only → Contents only
- **GitLab**: Settings → Access Tokens → read_repository only
- **Bitbucket**: App passwords → Repositories: Read only

### Code Indexing — Safe Files Only

**Auto-excluded (never indexed):**
```
.env, .env.*, *.env
credentials.*, secrets.*, master.key
*.pem, *.key, *.p12, *.pfx
.git/
node_modules/, vendor/, venv/, __pycache__/
*.log, *.lock
Any file containing: password=, api_key=, secret_key=, private_key=
```

**Indexed file types:**
```
Code:    .rb, .py, .js, .ts, .go, .java, .php, .ex, .rs, .cs
Views:   .erb, .html, .jsx, .tsx, .vue, .blade.php, .ejs, .hbs
Config:  .yml, .yaml (non-secret), .json (non-package-lock)
Schema:  .sql, .graphql, schema.rb, structure.sql
```

### LLM Safety — No Credentials in Prompts

**LLM receives:**
- Schema (table names, column names, types)
- Code snippets (from indexed safe files)
- SQL results (data rows)
- Page content (crawled DOM)

**LLM NEVER receives:**
- Connection strings
- Passwords or tokens
- .env file contents
- Any credential-containing content

---

## Local Agent — REST API Design

### Base: `http://127.0.0.1:9876`

### Auth Endpoints
```
POST /auth/unlock
  Body: { passphrase: "..." }
  Returns: { session_token: "...", expires_at: "..." }
  (Unlocks the encrypted vault, issues session token)

POST /auth/lock
  Header: X-Session-Token: ...
  (Locks the vault, invalidates session)

GET /auth/status
  Returns: { locked: bool, configured: bool }
  (No auth needed — tells extension if setup is complete)
```

### Setup Endpoints (Agent's own web UI at /setup)
```
GET /setup
  Returns: HTML setup page (rendered by agent, NOT extension)
  (Admin enters DB creds, git token, passphrase here)

POST /setup/configure
  Body: { passphrase, db_url, git_url?, git_token? }
  Returns: { success, session_token }
  (Encrypts secrets, tests connections, starts discovery)
```

### Database Endpoints
```
GET /db/schema
  Header: X-Session-Token: ...
  Returns: { tables: [{ name, columns: [{ name, type, nullable }], ... }] }

GET /db/enums
  Header: X-Session-Token: ...
  Returns: { enums: [{ table, column, values: [{ value, count }] }] }

POST /db/query
  Header: X-Session-Token: ...
  Body: { sql: "SELECT ..." }
  Returns: { columns, rows, total_count, execution_time_ms }
  (Validates SQL, forces read-only, caps at 500 rows)

GET /db/health
  Header: X-Session-Token: ...
  Returns: { connected: bool, latency_ms: number }
```

### Code Endpoints
```
GET /code/status
  Header: X-Session-Token: ...
  Returns: { indexed: bool, file_count, last_indexed_at }

POST /code/search
  Header: X-Session-Token: ...
  Body: { query: "net sales calculation", limit: 10 }
  Returns: { results: [{ file, line_start, line_end, content, score }] }

GET /code/file?path=app/services/sales_service.rb
  Header: X-Session-Token: ...
  Returns: { content: "...", language: "ruby" }

POST /code/reindex
  Header: X-Session-Token: ...
  Returns: { status: "indexing", file_count }
```

### Discovery Endpoints
```
POST /discovery/run
  Header: X-Session-Token: ...
  Returns: { status: "running" }
  (Triggers full auto-discovery: schema + enums + relationships + code index)

GET /discovery/status
  Header: X-Session-Token: ...
  Returns: {
    schema: "completed",
    enums: "completed",
    code: "indexing",
    tables_found: 45,
    enums_detected: 12,
    files_indexed: 234
  }

GET /discovery/results
  Header: X-Session-Token: ...
  Returns: {
    schema: [...],
    enums: [...],
    relationships: [...],
    stale_columns: [...],
    business_terms: [...]
  }
```

---

## Chrome Extension Structure

### Manifest V3

```
manifest.json:
  permissions: ["activeTab", "storage", "sidePanel"]
  host_permissions: ["http://127.0.0.1:9876/*", "<all_urls>"]
  background: { service_worker: "background.js" }
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }]
  action: { default_popup: "popup.html" }
```

### Extension Components

**Popup UI (React)**
- Project list / setup
- Agent connection status
- Discovery results review
- Settings (LLM engine choice, preferences)
- Does NOT handle credentials (redirects to agent UI)

**Background Service Worker**
- LLM engine management (WebLLM init/inference)
- Agent communication layer
- Message routing between popup, content script, and agent
- Session token management

**Content Script**
- Chat widget injection (floating bubble)
- Page crawler (extract DOM: nav, forms, tables, buttons)
- Browser actions (fill forms, click, navigate)
- Page context extraction (current URL, title, breadcrumbs)

### IndexedDB Schema

```
Database: "chatbot_v2"

Stores:
  projects: {
    id, name, agent_url, session_token,
    schema_cache, discovery_status,
    created_at, updated_at
  }

  crawled_pages: {
    id, project_id, url, title,
    navigation: [{ text, href, selector }],
    forms: [{ action, fields: [{ label, selector, type }] }],
    buttons: [{ text, selector, action_type }],
    tables: [{ headers, selector }],
    crawled_at
  }

  chat_history: {
    id, project_id, conversation_id,
    role, content, question_type, sql_query,
    created_at
  }

  settings: {
    llm_engine, theme, position,
    auto_crawl, crawl_depth
  }
```

---

## LLM — WebLLM Integration

### Default Engine: Qwen2.5-Coder-3B via WebLLM

```
Initialization:
  1. Extension installs → background worker starts
  2. First use → downloads model (~2GB, one time)
  3. Model loaded into WebGPU memory
  4. Ready for inference

Runtime:
  1. Question arrives from content script
  2. Background worker builds prompt:
     - System prompt (classification rules, safety rules)
     - Schema (from agent /db/schema)
     - Code context (from agent /code/search)
     - Page context (from content script)
     - Chat history (from IndexedDB)
  3. WebLLM runs inference locally
  4. Streams tokens back to content script
```

### Model Selection

| Model | Size | Best For |
|-------|------|----------|
| Qwen2.5-Coder-3B | 2GB | SQL generation, code understanding (default) |
| Phi-3.5-mini-instruct | 2.4GB | General questions, navigation |
| Llama-3.2-3B-Instruct | 2GB | Conversation, general purpose |

### Fallback Chain
```
1. Try WebLLM (default)
2. If WebGPU not available → try Chrome AI (Gemini Nano)
3. If Chrome AI not available → prompt user for Ollama or API key
```

---

## Page Crawler Design

### How It Works

The content script crawls the live rendered pages — no code access needed.

```
Admin clicks "Crawl this site" in extension popup
  → Content script starts on current page
  → Extracts: title, URL, navigation links
  → Follows each navigation link (opens in background)
  → For each page extracts:
     - Page title, URL, breadcrumbs
     - Form fields (label, selector, type, options)
     - Table columns (headers, selector)
     - Buttons (text, selector, inferred action type)
     - Menu items (text, href)
  → Stores all in IndexedDB (crawled_pages store)
  → Done in 30-60 seconds for typical admin panel
```

### Extraction Rules

```javascript
// Navigation: sidebar links, menu items
document.querySelectorAll('nav a, .sidebar a, [role="navigation"] a')

// Forms: all input fields with labels
document.querySelectorAll('form').forEach(form => {
  form.querySelectorAll('input, select, textarea').forEach(field => {
    // Extract: label (from <label> or aria-label), name, type, selector
  })
})

// Tables: column headers
document.querySelectorAll('table thead th, [role="columnheader"]')

// Buttons: action buttons
document.querySelectorAll('button, [role="button"], input[type="submit"]')
```

### Re-crawl Strategy
- Auto re-crawl when admin navigates to a new page (incremental)
- Manual full re-crawl from extension popup
- Crawled data stored per-project in IndexedDB

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

### DOM Interaction

```javascript
// Fill a text field
async function fillField(selector, value) {
  const field = document.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.style.outline = '3px solid #facc15'; // yellow highlight
}

// Select a dropdown option
async function selectOption(selector, value) {
  const select = document.querySelector(selector);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.style.outline = '3px solid #facc15';
}

// Click a button/link
async function clickElement(selector) {
  const el = document.querySelector(selector);
  el.click();
}
```

---

## Code Understanding — Text-Based RAG

### Indexing Flow (on agent)

```
1. Agent clones git repo (read-only)
2. Walks file tree, filters by allowed extensions
3. Skips sensitive files (see Security section)
4. Chunks each file:
   - Split by function/class/method boundaries (regex, not AST)
   - Each chunk: ~100-200 lines with file path + line numbers
   - Overlap: 20 lines between chunks
5. For each chunk, generate embedding:
   - Option A: Use WebLLM's embedding model (if available)
   - Option B: Use a lightweight local embedding model (all-MiniLM-L6-v2)
   - Option C: Simple TF-IDF + BM25 (no neural model, zero dependency)
6. Store chunks + embeddings in SQLite on agent
7. Serve search results via /code/search endpoint
```

### Search Flow (at query time)

```
Admin: "What is net sales today?"

1. Extension sends question to agent /code/search
2. Agent searches code index for: "net sales", "calculate sales", "revenue"
3. Returns top 5 relevant code chunks:
   - app/services/sales_calculator.rb:45-80 (net_sales method)
   - app/models/order.rb:12-30 (scope definitions)
   - app/controllers/reports_controller.rb:55-70 (sales report action)
4. Extension feeds these chunks + DB schema to LLM
5. LLM reads code → understands: net_sales = gross - refunds - discounts
6. LLM generates correct SQL
```

### Tech Independence

Since we use text-based RAG (not AST parsing):
- Ruby, Python, JavaScript, Go, Java, PHP, Rust — all treated as text
- LLM reads raw code and understands any language
- No per-language parser needed
- Works with ANY codebase

---

## Auto-Discovery — Enhanced (No Manual Seeding)

### What Gets Auto-Detected

| Detection | How | Example |
|-----------|-----|---------|
| **Enums** | Sample distinct values from int columns with cardinality < 50 | status: {1: 245, 2: 18, 3: 92} |
| **Enum labels** | LLM analyzes column name + values + code context | status 1 = "Active", 2 = "Inactive", 3 = "Deleted" |
| **Relationships** | Explicit FKs + inferred from `*_id` naming | jobs.created_by → customers.id |
| **Soft deletes** | Found `deleted_at` or status with "deleted" value | "Exclude status=3 by default" |
| **Stale columns** | Cache columns where all values are 0/NULL | contractors.completed_jobs_count (all 0) |
| **Business terms** | LLM infers from table/column names + code | "workers" = contractors table |

### Discovery Pipeline

```
1. Schema scan → tables, columns, types, FKs, indexes, comments
2. Data sampling → distinct values for enum-like columns
3. Code search → find enum definitions, model associations, calculations
4. LLM analysis → combine schema + samples + code → generate:
   - Enum mappings with labels
   - Relationship map
   - Business rules (soft deletes, stale columns)
   - Term synonyms
5. Store as structured metadata on agent
6. Serve to extension via /discovery/results
```

---

## Chat Flow — End to End

```
1. Admin types: "What is net sales today?"

2. Content script captures:
   - Question text
   - Page context (current URL, title, navigation)
   - Sends to background worker

3. Background worker:
   a. Classifies question → "data" (needs SQL)

   b. Gathers context:
      - Schema from agent (/db/schema) → cached in IndexedDB
      - Code search from agent (/code/search?q="net sales")
      - Discovery results from agent (/discovery/results) → enum mappings
      - Crawled page context from IndexedDB
      - Chat history from IndexedDB

   c. Builds prompt:
      - System: classification rules + safety rules
      - Schema: table/column definitions
      - Code: relevant code chunks showing calculation logic
      - Enums: auto-detected mappings
      - History: last 10 messages

   d. LLM generates SQL (via WebLLM locally)

   e. Validates SQL (same rules as V1):
      - Single SELECT statement
      - No INSERT/UPDATE/DELETE/DROP
      - No blocked functions
      - Adds LIMIT 500

   f. Sends SQL to agent (/db/query)

   g. Gets results back

   h. LLM generates human-friendly answer (streams tokens)

4. Content script displays:
   - Streaming answer in chat widget
   - SQL query (expandable, for transparency)
   - "Based on: code from sales_calculator.rb" (attribution)

5. Saved to IndexedDB (chat_history)
```

---

## Customer Setup Experience

### Total time: ~3 minutes

```
Step 1: Install Chrome Extension (30 seconds)
  → Chrome Web Store → "Add to Chrome" → Done

Step 2: Install Agent on server (60 seconds)
  → npm install -g @yourproduct/agent
  → yourproduct-agent start
  → Agent opens localhost:9876/setup

Step 3: Configure in Agent UI (60 seconds)
  ┌─────────────────────────────────────────────┐
  │  🔒 Setup                                   │
  │                                              │
  │  Create a passphrase:                        │
  │  [••••••••••••••]                            │
  │                                              │
  │  Database Connection:                        │
  │  [postgresql://reader:pass@localhost/mydb  ] │
  │  💡 We recommend a read-only database user   │
  │                                              │
  │  Git Repository (optional):                  │
  │  [https://github.com/myorg/myapp           ] │
  │  Access Token: [ghp_xxxxxxxxxxxx           ] │
  │  💡 Use a read-only token (Contents only)    │
  │                                              │
  │  [Save & Connect]                            │
  │                                              │
  │  ✅ Database connected (45 tables found)     │
  │  ✅ Git repo cloned (234 files indexed)      │
  │  ✅ Auto-discovery complete (12 enums found) │
  └─────────────────────────────────────────────┘

Step 4: Open your admin panel (30 seconds)
  → Navigate to your admin site
  → Chat widget appears in bottom-right
  → Click "Crawl this site" (one time, 30 seconds)
  → Done. Start asking questions.
```

---

## Revenue Model

### Option 1: Paid Extension (Recommended for launch)
- **Free tier**: 1 project, 50 questions/day, data mode only
- **Pro**: $29/month — unlimited projects, all modes, priority model downloads
- License key validated via simple API call (only thing that touches your server)

### Option 2: One-time Purchase
- $99 one-time for full access
- No recurring revenue but simpler to sell

### Option 3: Freemium + Premium Models
- Extension free, basic model included
- Premium models (larger, more accurate) behind paywall

---

## Tech Stack

### Chrome Extension
- **Manifest V3** (latest Chrome extension standard)
- **React 19** + TypeScript (popup UI, widget)
- **WebLLM** (@mlc-ai/web-llm) for local LLM inference
- **IndexedDB** via idb library for storage
- **Vite** for building

### Local Agent
- **Node.js 20+** with TypeScript
- **Express** or **Fastify** for REST API
- **pg** (node-postgres) for database connection
- **simple-git** for git operations
- **better-sqlite3** for local code index storage
- **node-forge** or **crypto** for AES-256 encryption
- Published as npm package: `@yourproduct/agent`

### Shared
- **TypeScript types** shared between extension and agent
- **SQL validation logic** (port from Python to TypeScript)
- **Pluggable interfaces** for LLM, DataSource, CodeSource, Storage

---

## What We Reuse From V1

| V1 Component | V2 Usage |
|-------------|----------|
| SQL validation rules | Port to TypeScript (same logic) |
| System prompts | Reuse and adapt for WebLLM |
| Widget UI/UX | Adapt for content script injection |
| Auto-discovery logic | Port schema inspection + data sampling to Node.js |
| Chat flow architecture | Same classify → generate → execute → answer pipeline |
| Safety rules | Same read-only enforcement, same SQL blocklists |
| Knowledge categories | Same enum_mapping, business_rule, etc. structure |

## What's New in V2

| Component | Description |
|-----------|------------|
| Chrome Extension (Manifest V3) | Popup + content script + service worker |
| WebLLM integration | Local LLM in browser, no API dependency |
| Local Node.js agent | DB + Git bridge with encrypted vault |
| Code indexing + RAG | Text-based code search for business logic |
| Page crawler | Extract navigation, forms, tables from live pages |
| Browser actions | Fill forms, navigate, search, filter via DOM |
| Pluggable interfaces | Swap LLM, DataSource, CodeSource, Storage |
| Agent setup UI | Secure credential entry directly on agent |
| Enhanced auto-discovery | LLM-powered enum label detection, stale column detection |
