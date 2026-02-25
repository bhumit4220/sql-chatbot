# SQL Chatbot V3 — Research Findings & Architecture Design

> **Date**: 2026-02-25
> **Status**: Approved (Audit v3 — 41 total issues resolved)
> **Supersedes**: V2 Chrome Extension + Local Agent Design (2026-02-24)

---

## Why V2 Doesn't Work

V2 designed the system as a **Chrome Extension + Local Agent** (standalone Node.js Fastify server on localhost:9876). The architecture is technically sound, but has a fatal product flaw:

**Non-technical admins will not install and run a Node.js server.**

The target user is someone who doesn't know SQL — asking them to run a terminal command, keep a process alive, deal with port conflicts, or install Node.js is a non-starter. This contradicts the core product promise: *"Install Chrome extension → start asking questions."*

---

## Research: How Competitors Handle This

### Competitor Landscape (20+ Products Analyzed)

#### Tier 1 — Established Players

| Product | Architecture | DB Connection | Target User | Pricing |
|---------|-------------|---------------|-------------|---------|
| **Outerbase** | Cloud SaaS | User provides Host/Port/User/Password ([docs](https://docs.outerbase.com/bases/guides/postgres)) | Teams | Free → $49/mo |
| **BlazeSQL** | Hybrid — metadata-only to AI | User provides Host/Port/User/Password, stored on their servers ([docs](https://help.blazesql.com/en/article/how-to-set-up-blaze-for-your-company-rkfp8n/)) | Business analysts | Free → $39/mo |
| **Vanna.ai** | Open-source (22.7k GitHub stars), RAG-based | Self-hosted or cloud, flexible DB connection | Developers building products | Free OSS + enterprise |
| **Wren AI** | Open-source, semantic-layer-first | PostgreSQL, MySQL, Snowflake, BigQuery | Data teams | Free → $299/mo |
| **Defog.ai (SQLCoder)** | Enterprise, fine-tuned LLMs | Self-hosted or cloud | Enterprise (healthcare, finance) | $5,000/mo+ |
| **AskYourDatabase** | Desktop app + embeddable widget | User provides URL/User/Password ([docs](https://www.askyourdatabase.com/docs/connect)) | Both technical and non-technical | $23-49/mo |
| **Chat2DB** (Alibaba) | Desktop app, open-source | Direct connection from desktop | Developers/DBAs | Free → $20/user/mo |

#### Tier 2 — Lightweight Tools

| Product | Architecture | DB Connection | Target User | Pricing |
|---------|-------------|---------------|-------------|---------|
| **Text2SQL.ai** | Cloud + Desktop app | Desktop: local only. Cloud: encrypted. | Developers | Paid plans |
| **AI2SQL** | Cloud + **Chrome Extension** | **Does NOT connect to DB** — generates SQL text only | Developers | $9-19/mo |
| **SQL Chat** (Bytebase) | Open-source Next.js | Direct connection, bring your own OpenAI key | Developers | Free |
| **Basedash** | Cloud SaaS, BI-native | User provides connection string or Host/Port/User/Password ([docs](https://docs.basedash.com/data-sources)) | Business teams | Free → $20/user/mo |
| **Sequel.sh** | Cloud SaaS | Cloud connections | Non-technical | Free → $19/user/mo |
| **Waii** | Acquired by Salesforce (Aug 2025) | Enterprise-grade | Enterprise | N/A |

#### Chrome Extension Gap

**AI2SQL is the ONLY natural-language-to-SQL Chrome extension** — and it does NOT connect to databases. It just generates SQL text you copy-paste. No Chrome extension on the market actually queries a database and returns results.

### Verified: Every Product Asks for DB Credentials

| Product | What They Ask For | How They Store It | Source |
|---------|-------------------|-------------------|--------|
| **Retool** | Host, Port, DB name, Username, Password | Encrypted at rest, never shown in UI | [Retool Docs](https://docs.retool.com/data-sources/guides/connect/postgresql) |
| **Metabase** | Server, Port, Database, User, Password | AES-256 + SHA-512 encryption | [Metabase Docs](https://www.metabase.com/docs/latest/databases/connections/postgresql) |
| **Outerbase** | Host, Port, Username, Password, DB name | Cloud-stored, encrypted | [Outerbase Docs](https://docs.outerbase.com/bases/guides/postgres) |
| **BlazeSQL** | Host, Port, User, Password | Stored on servers, encrypted | [BlazeSQL Docs](https://help.blazesql.com/en/article/how-to-set-up-blaze-for-your-company-rkfp8n/) |
| **AskYourDatabase** | URL, Username, Password | Desktop: local vault. Cloud: encrypted in DB. | [AskYourDatabase Docs](https://www.askyourdatabase.com/docs/connect) |
| **Basedash** | Connection string or Host/Port/User/Password | Encrypted, SSH keys saved encrypted | [Basedash Docs](https://docs.basedash.com/data-sources) |

### Browser Cannot Connect to PostgreSQL Directly

Chrome Extensions (Manifest V3) have **no raw TCP socket API**. PostgreSQL uses a custom binary wire protocol over TCP. Every workaround still requires a server-side component:

| Approach | Status |
|----------|--------|
| Chrome `chrome.sockets.tcp` | Deprecated (Chrome Apps, removed 2020) |
| WebSocket-to-TCP proxy (Neon) | Works, but requires deploying a proxy server |
| PGlite / postgres-wasm | Runs PG locally in browser — cannot connect to remote server |
| PostgREST / Supabase | HTTP-to-PG proxy — requires hosting the proxy |

**Conclusion: A server-side component is unavoidable.** The question is what form it takes.

---

## Three Architecture Options Evaluated

### Option A: Cloud SaaS (Store Credentials in Our Cloud)

```
Chrome Extension → HTTPS → Our Cloud API → TCP → Customer's PostgreSQL
```

**How Retool, Metabase, Outerbase, Basedash all work.**

| Pros | Cons |
|------|------|
| Zero setup for end users | We store customer DB credentials |
| Simplest architecture | Security/trust barrier for sales |
| Full control over infrastructure | Ongoing server costs scale with customers |
| Fast iteration — one deployment | Some enterprise customers won't allow it |

### Option B: Local Agent (Current V2)

```
Chrome Extension → HTTP localhost → Local Node.js Agent → Customer's PostgreSQL
```

| Pros | Cons |
|------|------|
| Credentials never leave customer's machine | **Admins must install and run Node.js** |
| No server costs | Port conflicts, firewall issues |
| Maximum data privacy | Process must stay running |
| | Contradicts target user (non-technical admins) |

**Verdict: Rejected.** The target user will not run a local server.

### Option C: Middleware Agent (New Relic Model) — SELECTED

```
Chrome Extension → HTTPS → Customer's Own App (with our middleware) → App's own DB connection
                                    ↕
                            Our Cloud (LLM API only — receives question + schema metadata, never credentials)
```

**Inspired by New Relic's agent model.** New Relic doesn't ask you to run a separate server. They say: *"Add this package to your existing app."* The agent lives inside the customer's own application.

| Pros | Cons |
|------|------|
| DB credentials **never leave customer's server** | Requires developer for one-time setup |
| No separate server to run | Need packages for multiple frameworks |
| Middleware uses app's own DB connection | Customer app must be running (but it already is) |
| Our cloud only sees schema metadata + questions | More complex distribution model |
| Customer's existing auth/firewall protects the endpoint | |
| App already has access to its own codebase | |

---

## V3 Architecture: Middleware Agent (Option C)

### How It Works

The customer's developer installs a lightweight middleware package into their existing web application. This middleware:

1. **Uses the app's own database connection** — no credentials to transmit
2. **Exposes a single orchestration endpoint** (`POST /chatbot/ask`) that handles all question types
3. **Auto-discovers everything** — schema, enums, foreign keys, model associations, default scopes — from DB introspection + code analysis. No manual configuration of domain rules.
4. **Communicates with our cloud** only for LLM inference (sends schema metadata + question, never credentials)
5. **The Chrome extension** talks to this endpoint on the customer's own domain

### Installation (One-Time, by Developer)

```ruby
# Rails — Gemfile
gem 'chatbot_agent'

# config/routes.rb
mount ChatbotAgent::Engine => '/chatbot'

# config/initializers/chatbot_agent.rb
ChatbotAgent.configure do |config|
  config.api_key = ENV['CHATBOT_API_KEY']  # authenticates with our LLM cloud
end
```

The Rails engine automatically:
- Inherits the host app's authentication (see Decision 4 — Auth Callback)
- Injects the `<meta name="chatbot-agent">` tag via a Railtie (no manual HTML changes needed)
- Stores its SQLite cache in `Rails.root.join('tmp/chatbot_agent/')`

```javascript
// Node.js / Express — ESM
import { chatbotAgent } from '@chatbot/agent';

app.use('/chatbot', chatbotAgent({
  apiKey: process.env.CHATBOT_API_KEY,
  db: existingDbPool
}));
```

```python
# Django
pip install chatbot-agent

# urls.py
from chatbot_agent import urls as chatbot_urls
urlpatterns += [path('chatbot/', include(chatbot_urls))]

# settings.py
CHATBOT_AGENT = {
    'API_KEY': os.environ['CHATBOT_API_KEY'],
    # Optional auth check — defaults to request.user.is_staff
    # 'AUTH_CHECK': 'myapp.auth.check_admin_session',
}
```

That's it. No domain rules, no enum mappings, no custom context. The middleware discovers everything autonomously.

An **optional** `config.custom_context` escape hatch exists for rare edge cases (see Decision 12).

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Customer's Admin Panel (any web app)                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Chrome Extension (content script)                       │   │
│  │  - Chat widget (Shadow DOM)                              │   │
│  │  - DOM crawler (nav, forms, buttons, tables)             │   │
│  │  - Makes HTTP requests to middleware (page context,      │   │
│  │    so session cookies are included automatically)        │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                          │ fetch() from page context             │
│                          │ (session cookies auto-included)       │
│                          ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Middleware Agent (installed in customer's app)           │  │
│  │                                                          │  │
│  │  POST /chatbot/ask        → orchestrates entire flow:    │  │
│  │    1. Validates admin session (auth callback)             │  │
│  │    2. Sends schema + question + history to cloud          │  │
│  │    3. Cloud classifies + generates SQL/search terms       │  │
│  │    4. Middleware executes SQL or searches code locally     │  │
│  │    5. Sends results to cloud for answer generation        │  │
│  │    6. Streams answer back to extension via SSE            │  │
│  │                                                          │  │
│  │  GET  /chatbot/status     → health + version for extension│  │
│  │  POST /chatbot/rediscover → force re-run auto-discovery   │  │
│  │                                                          │  │
│  │  Auto-discovery pipeline (runs lazily on first request):  │  │
│  │    - DB schema introspection (tables, columns, FKs)       │  │
│  │    - Enum detection (sample integer columns + code search)│  │
│  │    - Model association parsing (belongs_to, has_many)     │  │
│  │    - Default scope / soft delete detection                │  │
│  │    - Code indexing (BM25/SQLite) for code questions       │  │
│  │                                                          │  │
│  │  Uses: app's DB connection, app's filesystem              │  │
│  │  Sends to cloud: schema metadata + question ONLY          │  │
│  │  Cache: SQLite at tmp/chatbot_agent/ (Rails) or .cache/   │  │
│  └──────────────────────┬──────────────────────────────────┘  │
│                          │                                     │
│  ┌──────────────────────┴──────────────────────────────────┐  │
│  │  Customer's PostgreSQL Database                          │  │
│  │  (credentials never leave this server)                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ HTTPS (schema metadata + question only)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Our Cloud — LLM API Service                                    │
│                                                                 │
│  POST /api/v1/classify      → question type classification      │
│  POST /api/v1/generate-sql  → SQL generation from schema        │
│  POST /api/v1/answer        → answer generation (SSE stream)    │
│                                                                 │
│  - Receives: question + schema metadata + conversation history  │
│    + SQL results (for answer generation) + code snippets        │
│  - Never receives: DB credentials                               │
│  - Returns: classification, generated SQL, streamed answers     │
│                                                                 │
│  Auth: API key (Bearer token)                                   │
│  Rate limit: 100 req/min per key                                │
│  Model: GPT-4o-mini                                             │
│  Stack: Node.js + Express                                       │
└─────────────────────────────────────────────────────────────────┘
```

### What Lives Where

| Component | Location | Why |
|-----------|----------|-----|
| Chat UI widget | Chrome Extension (content script, Shadow DOM) | Must render in the admin panel |
| DOM crawler | Chrome Extension (content script) | Must access live DOM |
| HTTP requests to middleware | Chrome Extension (content script) | Content script runs in page context — session cookies are auto-included in `fetch()` calls to same-origin middleware |
| Full orchestration | Middleware (customer's app) | Single round-trip, middleware is the brain |
| DB schema introspection | Middleware (customer's app) | Uses app's own DB connection |
| SQL execution | Middleware (customer's app) | Uses app's own DB connection |
| Auto-discovery pipeline | Middleware (customer's app) | Needs DB + code access, fully autonomous |
| Code indexing + search | Middleware (customer's app) | Has access to local codebase |
| Conversation history | Chrome Extension (IndexedDB) | Stays in browser, passed in each request |
| LLM inference (classify, generate SQL, answer) | Our cloud | Centralized, billable, updatable |
| Prompt engineering | Our cloud | Can update prompts without customer deploys |

**Key change from V2**: The content script makes HTTP requests directly (not the background service worker). This is critical because content scripts run in the page's origin context, so the browser automatically includes session cookies for the admin panel domain. A background service worker does NOT have access to page cookies. The background worker is used only for extension-internal coordination (storage, lifecycle), not for HTTP requests to the middleware.

### The 4 Modes (V3 Scope)

> **Note**: Action mode (DOM form-filling, button-clicking) is deferred to V3.1.

#### Data Mode: "How many users signed up this month?"

```
Extension → POST /chatbot/ask {question, history, pageContext}
Middleware → Cloud /api/v1/classify → {type: "data"}
Middleware → Cloud /api/v1/generate-sql {question, schema, enums, discoveredContext, history}
  Cloud returns: {sql: "SELECT COUNT(*) FROM customers WHERE created_at >= '2026-02-01' AND status != 3"}
Middleware executes SQL locally → {columns: ["count"], rows: [{count: 342}]}
Middleware → Cloud /api/v1/answer {question, sqlResult, history}
  Cloud streams: "342 users signed up this month."
Middleware ← SSE → Extension
```

#### Data+Code Mode: "Show me jobs where net sales exceed $500"

This mode handles questions that need **both business logic from code AND a SQL query**. The cloud identifies that the question requires understanding a formula/calculation from the codebase before it can generate correct SQL.

```
Extension → POST /chatbot/ask {question, history, pageContext}
Middleware → Cloud /api/v1/classify → {type: "data_with_code"}
  Cloud returns: {searchTerms: ["net_sales", "calculate_total"]}
Middleware searches local code index → relevant code snippets (e.g., net_sales formula)
Middleware → Cloud /api/v1/generate-sql {question, schema, enums, discoveredContext, codeContext, history}
  Cloud uses code context to understand the formula, generates correct SQL
Middleware executes SQL locally → result rows
Middleware → Cloud /api/v1/answer {question, sqlResult, codeContext, history}
  Cloud streams answer with explanation
Middleware ← SSE → Extension
```

#### Code Mode: "How is net sales calculated?"

```
Extension → POST /chatbot/ask {question, history, pageContext}
Middleware → Cloud /api/v1/classify → {type: "code"}
  Cloud returns: {searchTerms: ["net_sales", "calculate_total", "revenue"]}
Middleware searches local code index (BM25/SQLite) → relevant code snippets
Middleware → Cloud /api/v1/answer {question, codeSnippets, history}
  Cloud streams explanation with file citations
Middleware ← SSE → Extension
```

#### Navigation/Guidance Mode: "Where do I manage user roles?" / "How do I ban a user?"

The cloud classifies as either `navigation` or `guidance` — these are two separate classify types but share the same middleware flow (no SQL or code search needed, just page context). `navigation` = "where is X?", `guidance` = "how do I do X?". The LLM uses the distinction to adjust its answer style (link vs step-by-step instructions).

```
Extension → POST /chatbot/ask {question, history, pageContext}
  (pageContext includes crawled nav links, forms, buttons, tables from live DOM)
Middleware → Cloud /api/v1/classify → {type: "navigation"} or {type: "guidance"}
Middleware → Cloud /api/v1/answer {question, pageContext, history}
  Cloud streams: "Click 'User Roles' in the Settings menu on the left sidebar."
Middleware ← SSE → Extension
```

---

## Resolved Design Decisions

All open questions from the initial research have been resolved:

### Decision 1: Domain Rules — Fully Auto-Discovered

**No manual configuration required.** The middleware's auto-discovery pipeline learns everything autonomously:

| What | How |
|------|-----|
| **Foreign keys** | DB constraint introspection + parse model files (Rails `belongs_to`/`has_many` with `foreign_key:` option, Django `ForeignKey`, Sequelize associations) |
| **Enums** | Sample integer columns with low cardinality (1-30 distinct values) + search codebase for label mappings. **Performance guard**: 5-second timeout per table, skip tables > 1M rows, cap at 100 tables. |
| **Default scopes / soft deletes** | Detect `default_scope`, `paranoia` gem, `acts_as_paranoid`, Django `SoftDeleteManager` in model files |
| **Naming quirks** | When column name doesn't match FK table (e.g., `created_by` → `customers`), code analysis reveals the mapping from model associations |
| **Table/column comments** | Read PostgreSQL `col_description` and `obj_description` |

### Decision 2: Endpoint Discovery — Hybrid (Meta Tag + .well-known + Manual)

The extension auto-detects the middleware on any site the admin visits:

**Primary — HTML meta tag** (simplest for developers):
```html
<meta name="chatbot-agent" content="/chatbot">
```

The Rails gem auto-injects this meta tag via a Railtie middleware — no manual HTML changes needed. Node.js/Django packages provide a helper to add it.

**Secondary — `.well-known` endpoint**:
```
GET /.well-known/chatbot-agent.json
→ {"endpoint": "/chatbot", "version": "1.0"}
```

**Fallback — Manual configuration** in extension popup for edge cases.

**Per-origin state** stored in `chrome.storage.local` (not `sync` — avoids 8KB/100KB quota limits and prevents localhost configs from syncing across machines). Each site config is ~100 bytes; `chrome.storage.local` has a 10MB quota, supporting 100,000+ sites — quota is not a concern:
```json
{
  "sites": {
    "admin.mowsnowpros.com": {"endpoint": "/chatbot", "detected": "meta-tag"},
    "crm.otherclient.com": {"endpoint": "/chatbot", "detected": "well-known"}
  }
}
```

**Endpoint values are always relative paths** (e.g., `/chatbot`). The extension constructs the full URL as `window.location.origin + endpoint + "/ask"`. This works because the middleware is mounted in the same app served on the same origin.

On page load: check storage → if not found, run discovery (meta tag → `.well-known` → skip) → if found, mount widget immediately. Each domain gets isolated conversation history (keyed by `origin + conversationId` in IndexedDB).

### Decision 3: SQL Execution Flow — Cloud Generates, Middleware Executes

```
Cloud generates SQL → Middleware validates + executes locally → Raw results sent to cloud for answer generation
```

**Data flow clarification**: Raw SQL results (column values, row data) ARE sent to the cloud's `/api/v1/answer` endpoint so the LLM can generate accurate natural language answers. DB credentials never leave the customer's server, but query result data does transit to the cloud for processing. This is the same model used by BlazeSQL and similar products.

**SQL execution safety**: All queries are wrapped in an explicit transaction block:

```sql
-- Node.js (pg driver): send as a single multi-statement query
BEGIN; SET TRANSACTION READ ONLY; <generated SQL with forced LIMIT>; COMMIT;
```

```ruby
# Rails: use raw SQL via connection.execute, NOT ActiveRecord::Base.transaction
# ActiveRecord's transaction {} uses savepoints and has different semantics
conn = ActiveRecord::Base.connection
conn.execute("BEGIN")
conn.execute("SET TRANSACTION READ ONLY")
result = conn.execute(validated_sql)
conn.execute("COMMIT")
```

This prevents the `SET TRANSACTION READ ONLY` race condition present in V2's auto-commit mode. The 8-layer SQL validator runs before execution.

### Decision 4: Auth Model — Two Layers

| Layer | Mechanism |
|-------|-----------|
| **Extension ↔ Middleware** | **Content script makes requests from page context** — session cookies are automatically included by the browser. The middleware validates the admin session via a configurable auth callback. |
| **Middleware ↔ Cloud** | API key in `Authorization: Bearer <key>` header. Developer sets `config.api_key = ENV['CHATBOT_API_KEY']`. |

**Auth callback** (how the middleware inherits the host app's auth):

```ruby
# Rails — config/initializers/chatbot_agent.rb
ChatbotAgent.configure do |config|
  config.api_key = ENV['CHATBOT_API_KEY']
  # Optional: defaults to checking current_admin (Devise)
  # Custom auth callback for non-standard setups:
  config.auth_check = ->(request) { request.env['warden'].user(:admin).present? }
end
```

The Rails engine defaults to checking for a Devise admin session. If the host app uses a different auth system, the developer provides a lambda. If no auth callback is configured, the middleware logs a warning and allows unauthenticated access (for development only — production should always have auth).

**CORS policy**: The middleware sets `Access-Control-Allow-Origin` to the request's origin (not wildcard), `Access-Control-Allow-Credentials: true`. Allowed origin check: any origin starting with `chrome-extension://` (scheme-prefix check only — extension IDs change per installation and cannot be known at gem install time) OR matching the app's own domain. The admin session check is the real auth gate; CORS is defense-in-depth.

**All chatbot endpoints** (`/chatbot/ask`, `/chatbot/status`, `/chatbot/rediscover`) require the same auth callback. There is no unauthenticated endpoint except the meta tag injection (which is a static HTML tag, not an endpoint).

**Why content script, not background worker**: Chrome MV3 background service workers do NOT have access to page session cookies. Only content scripts (running in the page's origin context) get cookies included automatically in `fetch()` calls. This is a fundamental browser security model — V2's approach of using the background worker required custom session tokens, which V3 eliminates by using the existing admin session.

### Decision 5: Conversation History — Extension-Only

History lives **only in the extension** (IndexedDB). The extension passes the last 10 messages (constant: `MAX_HISTORY_MESSAGES = 10`, inherited from V2's `constants.ts`) in every `/chatbot/ask` request. The middleware is stateless regarding conversations. No history endpoint needed.

**IndexedDB schema change from V2**: V2's IndexedDB schema keys chat history by `projectId` + `conversationId`, where `projectId` maps to a `projects` store. V3 eliminates the `projects` concept — history is keyed by `origin + conversationId`. This is a **breaking schema change** (not backward-compatible). The V2 `storage/` module requires restructuring, not just configuration changes. Reuse level is ~60%, not 85%.

### Decision 6: Code Indexing — Lazy Initialization

Code index is built on **first request that needs code** (lazy). The middleware checks if the SQLite index exists and is less than 24 hours old:
- If fresh → use cached index
- If stale or missing → index in background, return "Indexing codebase, please try again in a moment" for that first code question
- Re-indexes daily on next code request after 24h

**Background indexing mechanism**:
- **Rails**: `Thread.new { index_codebase }` — the code indexer writes to its own SQLite file (not the app's PG connection pool), so it is safe from ActiveRecord connection pool exhaustion. If the indexer needs to read from PG (e.g., for enum sampling during discovery), it MUST wrap those calls in `ActiveRecord::Base.connection_pool.with_connection { ... }` to properly check out and return connections. Never use bare `ActiveRecord::Base.connection` in a spawned thread.
- **Node.js**: `setImmediate(() => indexCodebase())` or worker thread for large codebases.

**Enum sampling timeout in Ruby**: Use `SET statement_timeout = '5000'` (5 seconds, in milliseconds) before each sample query via `connection.execute`. This is the PostgreSQL-native per-query timeout — no Ruby-level timeout needed.

Default paths: Rails → `Rails.root`, Node.js → `process.cwd()`. Developer can override with `config.codebase_path`.

**Note**: Rails migration files (`.rb` in `db/migrate/`) and `db/schema.rb` WILL be indexed — this is intentional, as they contain valuable schema evolution information useful for discovery.

### Decision 7: Schema Caching — SQLite

Schema cached in SQLite:
- **Rails**: stored at `Rails.root.join('tmp/chatbot_agent/cache.sqlite3')` — persists across app restarts, cleared on `rails tmp:clear`
- **Node.js**: stored at `.chatbot-agent/cache.sqlite3` relative to `cwd()`

Cache lifecycle:
- Lazily populated on first `/chatbot/ask` after app boot
- Auto-refresh if cached schema is older than 1 hour
- Manual refresh via `POST /chatbot/rediscover`

Schema inspection takes 1-3 seconds. Enum detection adds 5-15 seconds on first run (guarded by 5s/table timeout, 100 table cap). Total cold start: ~10-20 seconds on first request, instant after that.

### Decision 8: Multi-Site Extension State

Per-origin config in `chrome.storage.local` (see Decision 2). Conversation history in IndexedDB keyed by `origin + conversationId`. Each site is fully isolated — different schema, different discovery cache, different chat history.

### Decision 9: Cloud LLM Service — Minimal for V3

| Endpoint | Input | Output |
|----------|-------|--------|
| `POST /api/v1/classify` | question + schema summary + page context | `{type, confidence, searchTerms?}` — `type` is one of: `data`, `data_with_code`, `code`, `navigation`, `guidance`. `searchTerms` is included when type is `code` or `data_with_code` (saves a round-trip). |
| `POST /api/v1/generate-sql` | question + schema + enums + discovered context + history + optional codeContext | `{sql}` |
| `POST /api/v1/answer` | question + results (sqlResult/codeSnippets/pageContext) + history | SSE streamed answer |

Auth: API key (`Authorization: Bearer <key>`). Rate limit: 100 req/min per key. Model: GPT-4o-mini. All prompt engineering lives in the cloud (moved from V2's `prompts.ts`, with MSP-specific rules replaced by the `discoveredContext` parameter).

**Timeouts**: All middleware-to-cloud HTTP calls use a 30-second timeout. Rails: `Net::HTTP.open_timeout = 5, read_timeout = 30`. Node.js: `AbortController` with 30s signal. If any cloud call times out, the middleware returns the error per Decision 10's graceful degradation rules.

No billing system for V3 — just API key validation against a simple database. Stack: Node.js + Express.

### `/chatbot/status` Response Schema

```json
{
  "version": "1.0.0",
  "status": "ready",           // "ready" | "discovering" | "error"
  "discoveryState": {
    "schema": "completed",     // "pending" | "running" | "completed" | "failed"
    "enums": "completed",
    "code": "pending"
  },
  "authRequired": true
}
```

The extension uses this to decide whether to mount the widget (`status != "error"`) and whether to show a loading state (`status == "discovering"`).

### Decision 10: Error Handling — Graceful Degradation

| Failure | Behavior |
|---------|----------|
| Cloud unreachable | Middleware returns `503`. Extension shows "Service temporarily unavailable, try again." |
| Middleware unreachable | Extension hides widget, shows nothing (no middleware = no chatbot on this page) |
| SQL execution fails | Middleware sends error to cloud for friendly explanation, streams that to extension |
| Cloud returns invalid SQL | Middleware validates with SQL validator. On failure: sends `{retryWithContext: {originalSql, rejectionReason}}` back to cloud's `/api/v1/generate-sql`. If second attempt also fails, streams a friendly error: "I couldn't generate a valid query for that question. Try rephrasing." |
| Discovery not ready | Middleware returns "Still learning your database, try again in a moment" |
| Auth check fails | Middleware returns `401`. Extension shows "Please log in to use the chatbot." |

No offline mode. Product requires both middleware and cloud.

### Decision 11: Scope — Action Mode Deferred to V3.1

V3 ships with 5 classify types across 4 modes: Data, Data+Code, Code, Navigation, Guidance. Action mode (DOM form-filling, button-clicking) is complex and risky. Deferred to V3.1.

### Decision 12: Enum Overrides — Auto-Discovery Primary

Two sources in priority order:
1. **Auto-discovered** — middleware samples integer columns + searches code for labels (V2 logic, enhanced with model file parsing for associations and scopes)
2. **Optional `config.custom_context`** — developer escape hatch for edge cases

`custom_context` schema:
```ruby
config.custom_context = "plain text string, max 2000 characters"
# Example: "The 'service_type' column uses 3=Hourly but is misspelled as 'Houlry' in the enum definition."
```

This plain-text string is prepended to the SQL generation prompt as additional context. It takes precedence over auto-discovered context for any conflicting information. 2000 character limit prevents prompt context window overflow.

No admin-facing correction UI for V3. Admin correction UI is a V3.1 feature.

---

## Security Model

| Concern | How It's Addressed |
|---------|-------------------|
| DB credentials exposure | Never leave customer's server — middleware uses app's own connection |
| Raw data exposure to cloud | SQL query results ARE sent to cloud for answer generation. DB credentials never are. This matches industry standard (BlazeSQL, Outerbase). Future: add result redaction layer in V3.1. |
| Unauthorized access to middleware | Auth callback validates admin session on every request. Defaults to Devise admin check. Returns 401 if not authenticated. |
| SQL injection | Explicit `BEGIN; SET TRANSACTION READ ONLY; ...; COMMIT;` transaction block + 8-layer SQL validator (SELECT-only, blocked tables/functions, forced LIMIT 500) |
| Middleware ↔ Cloud auth | API key in Bearer token, validated per request |
| Extension ↔ Middleware auth | Content script runs in page context — session cookies auto-included. No custom tokens needed. |
| CORS | `Access-Control-Allow-Origin` set to specific requesting origin (not `*`), `Access-Control-Allow-Credentials: true`. Only `chrome-extension://` origins and the app's own domain are allowed. |
| Code file exposure | Code snippets ARE sent to cloud for LLM-powered explanation. The cloud does not store them beyond the request. Sensitive files (`.env`, credentials) are excluded by the indexer. |
| Sensitive column filtering | **Credentials** (filtered from schema — never sent to cloud): `password`, `pwd`, `token`, `secret`, `ssn`, `api_key`, `salt`, `encr_`, `stripe_`, `bank_`. **PII columns** (included in schema for query generation but column names flagged): `email`, `phone`, `address`, `first_name`, `last_name`, `name`, `dob`, `date_of_birth`, `ip_address`, `card`. Both lists inherited from V2's `SENSITIVE_COLUMN_PATTERNS` and `PII_COLUMN_PATTERNS`. |
| Sensitive file filtering | Code indexer skips `.env`, credentials files, `node_modules/`, `.git/`, and files matching secret patterns (API keys, passwords in source) |

---

## SSE Streaming — Implementation Notes

The middleware streams answers back to the extension using Server-Sent Events (SSE). This requires specific configuration per framework:

### Rails
- Controller must `include ActionController::Live`
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` (for Nginx)
- Requires **Puma** web server (not Unicorn — Unicorn does not support streaming)
- Rack middleware that buffers responses (e.g., `Rack::Deflater`) must be bypassed for SSE endpoints
- **Dual-stream pattern**: The Rails Live controller thread simultaneously reads the cloud's SSE response (via `Net::HTTP` with streaming body using `response.read_body { |chunk| ... }`) and writes to its own SSE response. This is synchronous within one thread — read a chunk from cloud, write it to the extension response. No concurrent I/O needed since the cloud produces tokens sequentially.

### Node.js / Express
- `res.setHeader('Content-Type', 'text/event-stream')`, `res.flushHeaders()`
- Native streaming support, no special configuration needed

### SSE Format
```
data: {"token": "342 "}
data: {"token": "users "}
data: {"token": "signed up this month."}
data: [DONE]
```

---

## What Can Be Reused From V2

| V2 Component | V3 Destination | Reuse Level |
|-------------|----------------|-------------|
| `shared/src/sql-validator/` | Node.js middleware (direct import) + cloud service. **Rails needs a Ruby port using `pg_query` gem** (significant task — `node-sql-parser` has no Ruby equivalent). | As-is for Node.js. Ruby port needed for Rails. |
| `shared/src/types/` | Shared types across V3 TypeScript packages | 80% reuse, adapt for new API shapes + add `data_with_code` type |
| `shared/src/constants.ts` | Split between middleware and cloud | 70% reuse |
| `agent/src/db/schema-inspector.ts` | Rails middleware (port SQL to ActiveRecord) + Node.js middleware (direct) | Logic reuse, DB adapter changes |
| `agent/src/db/sql-executor.ts` | Rails middleware + Node.js middleware (direct). **Fix**: wrap in explicit `BEGIN; SET TRANSACTION READ ONLY; ...; COMMIT;`. **Rails**: use raw `connection.execute()`, NOT `ActiveRecord::Base.transaction {}` (see Decision 3). | Logic reuse + bug fix |
| `agent/src/discovery/data-sampler.ts` | Middleware (both frameworks). **Add**: 5s timeout per table, skip tables > 1M rows, cap at 100 tables. | Logic reuse + performance guards |
| `agent/src/discovery/label-inference.ts` | Middleware (both frameworks) | As-is (framework-agnostic regex) |
| `agent/src/discovery/pipeline.ts` | Middleware (both frameworks) | Logic reuse, enhanced with model parsing |
| `agent/src/git/indexer.ts` | Node.js middleware (direct). **Rails**: port to Ruby (walk directory, chunk files, store in SQLite). Background thread, not blocking. | Logic reuse. Rails port is significant. |
| `agent/src/git/search.ts` | Node.js middleware (direct). **Rails**: port BM25 search to Ruby + SQLite. | Logic reuse. Rails port needed. |
| `agent/src/llm/prompts.ts` | Cloud LLM service. **Remove MSP-specific rules**, replace with `discoveredContext` parameter. | Move + refactor |
| `agent/src/llm/openai-engine.ts` | Cloud LLM service | Move directly |
| `extension/src/content/widget/` | V3 extension. **Change**: content script makes HTTP requests directly (not via background worker). | 80% reuse, significant change to request flow |
| `extension/src/content/crawler/` | V3 extension | As-is |
| `extension/src/background/message-router.ts` | V3 extension. **Simplified**: background worker handles only storage/lifecycle, not HTTP requests. | 40% reuse, major simplification |
| `extension/src/background/agent-client.ts` | **Moved to content script**. Remove vault/session logic. Add `credentials: 'include'` to all `fetch()` calls. | 60% reuse, relocated + simplified |
| `extension/src/storage/` | V3 extension. **Breaking change**: V2 keys by `projectId`, V3 keys by `origin`. Use `chrome.storage.local` (not `sync`). Schema migration required. | 60% reuse, schema restructure |
| `extension/src/popup/` | V3 extension popup. **Redesign**: no vault unlock, just site status + manual endpoint config. | 30% reuse |
| `agent/src/git/cloner.ts` | Not needed in V3 — middleware indexes local filesystem directly (`Rails.root` / `cwd()`), no remote cloning | Removed |
| `agent/src/vault/` | Not needed in V3 — middleware uses env vars for API key | Removed |
| `agent/src/auth/session.ts` | Not needed in V3 — uses app's existing admin session | Removed |

---

## Multi-Framework Agent Packages (Build Priority)

| Priority | Framework | Package | Rationale |
|----------|-----------|---------|-----------|
| 1 | **Ruby on Rails** | `chatbot_agent` (gem) | MSP is the test customer. Large legacy admin panel market. |
| 2 | **Node.js / Express** | `@chatbot/agent` (npm) | Largest framework ecosystem. V2 code reuses directly. |
| 3 | Django | `chatbot-agent` (pip) | Future — large Python admin panel market |
| 4 | Laravel | `chatbot-agent` (composer) | Future — large PHP admin panel market |

**V3 builds Rails gem first** (MSP test customer), then Node.js package.

---

## Customer Onboarding Flow

**Step 1 — Developer (one-time, 5 minutes):**
1. Sign up at our website, get an API key
2. `bundle add chatbot_agent` (or `npm install @chatbot/agent`)
3. Mount route: `mount ChatbotAgent::Engine => '/chatbot'`
4. Set env var: `CHATBOT_API_KEY=<key>`
5. Deploy (the gem auto-injects the meta tag via Railtie — no HTML changes needed)

**Step 2 — Admin (every day):**
1. Install Chrome extension from Chrome Web Store
2. Open their admin panel
3. Extension auto-detects the `/chatbot/` endpoint via meta tag
4. Start asking questions — the bot auto-discovers everything about the database

**Note for split deployments**: If the admin panel is a separate SPA (React/Vue) served from a different domain than the API, the developer must either: (a) add the meta tag manually to the SPA's HTML, or (b) configure the SPA to proxy `/chatbot/` requests to the API server. The Railtie auto-injection only works when Rails serves the HTML.

---

## Competitive Differentiation

| Feature | Outerbase | BlazeSQL | Vanna.ai | AI2SQL | AskYourDB | **Our Product** |
|---------|-----------|----------|----------|--------|-----------|-----------------|
| Natural language → SQL | Yes | Yes | Yes | Yes | Yes | Yes |
| Actually executes queries | Yes | Yes | Yes | **No** | Yes | Yes |
| Chrome extension | No | No | No | Yes (no DB) | No | **Yes (with DB)** |
| Works inside admin panel | No | Embed only | No | No | Embed only | **Yes, native** |
| Code understanding | No | No | No | No | No | **Yes** |
| Navigation guidance | No | No | No | No | No | **Yes** |
| Credentials stay local | No | No | Self-hosted only | N/A | Desktop only | **Yes (middleware)** |
| No separate server for customer | Yes (cloud) | Yes (cloud) | No (self-host) | Yes | No (desktop) | **Yes (middleware in existing app)** |
| Fully autonomous (no manual config) | No (manual schema mapping) | No (manual setup) | No (training required) | N/A | No (manual setup) | **Yes (auto-discovers everything)** |

**No competitor offers data + code + navigation/guidance as a Chrome extension that works inside any admin panel with credentials staying local and fully autonomous discovery.**

---

## V3 Component Summary

| Component | Tech | Location |
|-----------|------|----------|
| Chrome Extension | TypeScript, React, Vite, MV3 | `packages/extension/` |
| Rails Middleware | Ruby, Rails Engine, `pg_query` gem (SQL validation) | `packages/rails-agent/` (gem: `chatbot_agent`) |
| Node.js Middleware | TypeScript, Express middleware | `packages/node-agent/` (npm: `@chatbot/agent`) |
| Cloud LLM Service | TypeScript, Express, OpenAI SDK | `packages/cloud/` |
| Shared Types + SQL Validator (TS) | TypeScript, `node-sql-parser` | `packages/shared/` |

**Note**: The Rails gem requires a Ruby implementation of the SQL validator (using `pg_query` gem) since it cannot import the TypeScript `node-sql-parser` library. This is a significant porting task but `pg_query` provides equivalent PostgreSQL parsing capabilities.

---

## Repo Cleanup Notes

- The top-level `widget/` directory is a **V1 artifact** (standalone IIFE widget from the Python/FastAPI version). It should be deleted or moved to a `v1-archive/` branch before V3 development begins.
- The top-level `app/`, `alembic/` directories are also V1 Python artifacts.

---

## Next Steps

1. Write implementation plan (phase-by-phase build order)
2. Build cloud LLM service (classify, generate-sql, answer endpoints)
3. Build Rails middleware gem (`chatbot_agent`) with auto-discovery
4. Adapt Chrome extension (content-script HTTP requests, hybrid discovery)
5. E2E test on MSP admin panel
