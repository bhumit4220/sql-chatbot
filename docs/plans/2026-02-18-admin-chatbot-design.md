# SQL Chatbot — Design Document

## Summary

A standalone AI-powered admin assistant that does two things:

1. **Data Q&A** — Connects to any PostgreSQL database, answers natural language questions by generating safe read-only SQL queries.
2. **Admin Panel Guide** — Knows the admin panel's pages, workflows, and features. Guides admins on how to do things, where to find things, and how to navigate.

Delivered as a **Python/FastAPI backend** with an **embeddable JavaScript widget** that any admin panel can include with a single `<script>` tag — regardless of technology (Rails, Django, Laravel, React, etc.).

MSP (Mow Snow Pros) is the first integration, but the product is database-agnostic and technology-independent from day one.

## Decisions Made

- **Standalone app** — Separate codebase. Own database, own API, own deployment. Host admin panels just embed the widget.
- **Python 3.12 + FastAPI** — Best AI ecosystem, native OpenAI SDK, async-first, SSE streaming built-in.
- **AI Provider:** OpenAI GPT-4o mini via official `openai` Python SDK.
- **Data Q&A:** Schema-aware SQL generation with structured outputs (Pydantic model).
- **Admin Panel Guide:** Knowledge base per project — project owner provides page descriptions, workflows, URLs as structured entries via API. Stored in chatbot's own DB.
- **Transport:** SSE streaming from day one.
- **Capabilities:** Read-only queries. No write actions in Phase 1.
- **Chat Memory:** Multi-turn, stored in chatbot's own PostgreSQL database.
- **Multi-tenancy:** Each "project" has its own DB connection + knowledge base + API key.
- **RAG:** Not in Phase 1. Knowledge base uses direct context injection (small enough to fit in prompt). RAG via pgvector is a Phase 2 enhancement for large knowledge bases.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Any Admin Panel (Rails, Django, Laravel, React, etc.)  │
│                                                         │
│  <script src="https://chatbot-api/widget/widget.js"     │
│          data-api-key="proj_live_abc123"                 │
│          data-api-url="https://chatbot-api"              │
│          async></script>                                 │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Floating Chat Widget (Shadow DOM isolated)     │    │
│  │  - Renders inside Shadow DOM (no CSS conflicts) │    │
│  │  - Communicates via fetch() + ReadableStream    │    │
│  │  - Authenticated via X-API-Key header           │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │ POST /api/v1/chat/stream
                          │ Header: X-API-Key: proj_live_abc123
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Chatbot API (Python + FastAPI)                         │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Auth         │  │ Conversations│  │ Projects     │  │
│  │ (API key +   │  │ (chat, SSE   │  │ (CRUD, DB    │  │
│  │  JWT admin)  │  │  streaming)  │  │  connections,│  │
│  └──────┬───────┘  └──────┬───────┘  │  knowledge)  │  │
│         │                 │          └──────┬───────┘  │
│  ┌──────┴─────────────────┴─────────────────┴───────┐  │
│  │              Core Services                        │  │
│  │                                                   │  │
│  │  IntentClassifier ── determines question type:    │  │
│  │                      "data" or "guidance"         │  │
│  │                                                   │  │
│  │  SchemaInspector ─── SQLAlchemy inspect()          │  │
│  │                      + schema cache in DB          │  │
│  │                      + sensitive columns stripped  │  │
│  │                                                   │  │
│  │  KnowledgeBase ───── loads project's admin panel   │  │
│  │                      knowledge (pages, workflows,  │  │
│  │                      URLs, how-tos)               │  │
│  │                                                   │  │
│  │  LLMService ──────── OpenAI GPT-4o mini            │  │
│  │                      structured output (Pydantic)  │  │
│  │                      + SSE streaming for answers   │  │
│  │                                                   │  │
│  │  SqlValidator ────── sqlparse (statement type)      │  │
│  │                      + sqlglot (AST analysis)      │  │
│  │                      + keyword/function blocklist   │  │
│  │                                                   │  │
│  │  SqlExecutor ─────── read-only PG role (required)   │  │
│  │                      + SET TRANSACTION READ ONLY   │  │
│  │                      + statement_timeout enforced   │  │
│  │                                                   │  │
│  │  TenantDBManager ─── dynamic engine pool            │  │
│  │                      per-project connection cache   │  │
│  │                      pool_size: 2-5 per tenant     │  │
│  │                      eviction: 30min inactive TTL  │  │
│  │                      pool_pre_ping: true           │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Chatbot's Own Database (PostgreSQL)              │  │
│  │  projects, api_keys, admins,                      │  │
│  │  knowledge_entries,                               │  │
│  │  conversations, messages, audit_logs              │  │
│  │  Managed via Alembic migrations                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          │ Dynamic connection per project
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Tenant Database (e.g., MSP PostgreSQL)                 │
│  - REQUIRED: dedicated read-only PG role                │
│  - SET TRANSACTION READ ONLY as defense-in-depth        │
│  - statement_timeout: 30s                               │
└─────────────────────────────────────────────────────────┘
```

## Two Question Types

The chatbot handles two types of questions with different flows:

### Type 1: Data Questions
"How many jobs completed today?" → generates SQL → queries DB → streams answer with data.

### Type 2: Guidance Questions
"How do I approve a contractor?" → looks up knowledge base → streams step-by-step guidance with links.

The LLM determines the question type in the first API call. If it's a data question, it returns SQL. If it's a guidance question, it returns `sql_query: null` and the system skips SQL validation/execution and goes straight to streaming an answer from the knowledge base context.

**Ambiguous questions** (could be both data + guidance, e.g. "How do refunds work?"): The LLM picks the single best-fit type based on the system prompt instruction: "If the question asks for counts, totals, lists, or specific records, classify as data. If it asks how to do something, where to find something, or what something means, classify as guidance. When genuinely ambiguous, prefer guidance — the user can follow up with a data question." No hybrid responses in Phase 1.

## Query Flow

```
1. User types question in widget
        │
2. Widget sends POST /api/v1/chat/stream
   Header: X-API-Key, Content-Type: application/json
   Body: { question, conversation_id? }
        │
3. FastAPI verifies API key → loads project
        │
4. Load context in parallel:
   a) SchemaInspector: cached DB schema (sensitive columns pre-stripped)
   b) KnowledgeBase: project's admin panel knowledge entries
        │
5. LLMService.generate_sql() — FIRST OpenAI call (structured output)
   Input: system prompt + schema + knowledge base + conversation history (last 10 messages, max 2,000 tokens) + question
   Output: Pydantic model:
     {
       question_type: "data" | "guidance",
       sql_query: "SELECT ..." | null,
       explanation_of_query: "This counts completed jobs...",
       confidence: 0.95
     }
        │
        ├── If question_type == "guidance" → skip to step 8
        │
6. SqlValidator validates the SQL (if data question):
   - sqlparse: single statement, SELECT type only
   - sqlglot AST walk: reject Insert/Update/Delete/Drop/Create/Alter/
     Grant/Revoke/Command nodes. Detect SELECT...INTO via AST (not keyword match).
   - Keyword blocklist (all SQL uppercased before checking):
     INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT,
     REVOKE, EXECUTE, COPY, PREPARE, DO, SET ROLE, SET SESSION
   - PG function blocklist:
     pg_read_file, pg_ls_dir, pg_stat_file, dblink, lo_import, lo_export,
     pg_terminate_backend, pg_cancel_backend, pg_sleep, current_setting
   - PG system catalog blocklist:
     pg_stat_activity, pg_roles, pg_shadow, pg_authid
   - Force LIMIT 500 if missing
   If invalid → log rejection in audit_logs → return error to user
        │
7. SqlExecutor runs validated SQL on tenant DB:
   - Uses dedicated read-only PG role (REQUIRED, not optional)
   - SET TRANSACTION READ ONLY as defense-in-depth
   - statement_timeout = 30s
   - Fetch max 500 rows
   - If result > 50 rows, truncate to 50 for LLM input (include row count)
        │
8. LLMService.stream_answer() — SECOND OpenAI call (streaming SSE)
   Input depends on question type:
   - Data: original question + SQL results (max 50 rows) + schema context
   - Guidance: original question + knowledge base entries
   Output: streamed natural language answer, token by token
        │
9. SSE events sent to widget:
   - event: sql_generated  → { sql, explanation } (data questions only)
   - event: message        → { token } (streamed, both types)
   - event: done           → { total_tokens }
        │
10. Save to chatbot DB:
    - Conversation + message records
    - Audit log: project_id, question, SQL (if any), validation_result
      (integer enum: 0=passed, 1=rejected, 2=error, 3=guidance_only),
      execution_time_ms, result_row_count, token_usage, ip_address
    - Increment daily token counter for project budget tracking
```

### Why Two OpenAI Calls (Not One)

1. **Call 1 (structured, non-streaming):** Classify question type + generate SQL (if data question). Uses Pydantic structured output (`response_format`) for reliable JSON. Fast (~1s with GPT-4o mini).
2. **Call 2 (streaming SSE):** Given the SQL results (or knowledge base for guidance), stream a natural language answer token-by-token. Streaming makes perceived latency minimal.

The LLM cannot produce a data-rich answer before SQL execution, so two calls are architecturally necessary for data questions. For guidance questions, call 1 is still needed to classify intent and select relevant knowledge.

## Admin Panel Knowledge Base

Each project has a knowledge base — a collection of entries that teach the chatbot about the admin panel. Entries are created via the admin API.

### Knowledge Entry Structure

```json
{
  "category": "navigation",
  "title": "Approve a contractor",
  "content": "To approve a contractor: 1) Go to Contractors page (/admin/contractors). 2) Click on the pending contractor's name. 3) Review their documents. 4) Click the 'Approve' button.",
  "url": "/admin/contractors",
  "tags": ["contractor", "approve", "pending"]
}
```

### Categories

| Category | Purpose | Example |
|---|---|---|
| `navigation` | How to find a page/feature | "Where is the disputes page?" |
| `workflow` | Step-by-step how to do something | "How do I issue a refund?" |
| `concept` | What something means | "What does 'escalated' status mean?" |
| `faq` | Frequently asked questions | "Why can't I see deleted customers?" |

### How It Works

- All knowledge entries for a project are loaded and included in the LLM's system prompt context.
- For Phase 1, this is direct context injection (entries are small enough to fit in the prompt — typical admin panel has 20-50 entries, ~2-5K tokens).
- Hard limit: max 100 knowledge entries per project, enforced at the API level. Returns 422 if limit exceeded on creation.
- Phase 2: When knowledge bases grow large, switch to RAG with pgvector to retrieve only relevant entries per question.

### Knowledge Management API

```
POST   /api/v1/projects/:id/knowledge          # Create entry
GET    /api/v1/projects/:id/knowledge          # List entries
PUT    /api/v1/projects/:id/knowledge/:entry_id # Update entry
DELETE /api/v1/projects/:id/knowledge/:entry_id # Delete entry
```

## Security

### SQL Security (Defense-in-Depth, 5 Layers)

| Layer | Mechanism | What It Catches |
|---|---|---|
| **1. Schema Stripping** | Sensitive columns removed from schema BEFORE sending to LLM. If the LLM never sees `password`, `auth_token`, `encr_pwd` in the schema, it cannot generate SQL referencing them. Columns matching: `password`, `pwd`, `token`, `secret`, `ssn`, `api_key`, `salt`, `encr_*`, `stripe_*`, `bank_*` are stripped. | Prevents data exfiltration of sensitive columns. Cannot be bypassed via SQL aliases or subqueries because the column names are never exposed. |
| **2. SQL Parsing (sqlparse)** | Single statement only. Statement type must be SELECT. | Multi-statement injection, non-SELECT DML. |
| **3. SQL AST Analysis (sqlglot)** | Walk AST tree, reject: Insert, Update, Delete, Drop, Create, Alter, Grant, Revoke, Command nodes. Detect `SELECT...INTO` via AST node type (not keyword string matching — avoids false positives on table names containing "into"). Additionally, parse all referenced column names from the AST and verify each exists in the stripped schema — reject queries referencing non-existent columns (prevents hallucinated column access and probing). | Sophisticated SQL injection, obfuscated writes, hallucinated column references. |
| **4. Keyword + Function Blocklist** | All SQL uppercased before checking. Keywords: INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, EXECUTE, COPY, PREPARE, DO, SET ROLE, SET SESSION. PG functions: pg_read_file, pg_ls_dir, pg_stat_file, dblink, lo_import, lo_export, pg_terminate_backend, pg_cancel_backend, pg_sleep, current_setting. PG system catalogs: pg_stat_activity, pg_roles, pg_shadow, pg_authid. | Edge cases that pass AST analysis, PG-specific exploits, DoS via pg_sleep. |
| **5. Read-Only PG Role (REQUIRED)** | Dedicated PostgreSQL role with `GRANT SELECT ON specific_tables` only. This is the primary security boundary. `SET TRANSACTION READ ONLY` is applied as additional defense-in-depth but is NOT relied upon (it doesn't block mutable functions or system catalog reads). | Everything. Even if layers 1-4 are bypassed, the DB user physically cannot write, execute functions with side effects, or access tables not explicitly granted. |

**Required tenant DB role setup (provide in project docs + admin UI):**

```sql
-- Create a read-only role for the chatbot
CREATE ROLE chatbot_readonly LOGIN PASSWORD 'strong_password_here';

-- Revoke all default privileges first
REVOKE ALL ON DATABASE your_database FROM chatbot_readonly;
REVOKE ALL ON SCHEMA public FROM chatbot_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM chatbot_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM chatbot_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM chatbot_readonly;

-- Grant only what's needed
GRANT CONNECT ON DATABASE your_database TO chatbot_readonly;
GRANT USAGE ON SCHEMA public TO chatbot_readonly;

-- Grant SELECT on specific tables only (not all tables)
GRANT SELECT ON TABLE users, jobs, properties, invoices TO chatbot_readonly;
-- Omit tables with sensitive data (payments, tokens, etc.)

-- Prevent future default privileges from granting access
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM chatbot_readonly;
```

### Other Security

| Layer | Mechanism |
|---|---|
| Row Limit | Force LIMIT 500 if query lacks LIMIT clause |
| Query Timeout | `statement_timeout = 30000` (30s) on tenant connection |
| API Key Auth | Widget authenticates via `X-API-Key` header. Keys SHA-256 hashed in DB. Multiple active keys per project supported for zero-downtime rotation. **Threat model:** API keys are embedded in client-side JavaScript and must be considered public. They identify the project and enforce rate limits but do NOT grant access to sensitive data — that responsibility falls to the read-only PG role (which limits visible tables/columns) and schema stripping (which removes sensitive columns from LLM context). A leaked key allows only read-only natural language queries within the project's rate limits, which is the same access any admin with the widget already has. Keys can be revoked instantly via the admin API. |
| CORS | `allow_origins=["*"]` with `allow_credentials=False`. Safe because auth is via API key header, not cookies. Browsers won't send ambient credentials. |
| Rate Limiting | Per API key: 30 req/min, 500/day. Implemented via Redis (shared across gunicorn workers). Redis is included in docker-compose from day one. |
| Token Budget | Per project: configurable daily token cap (default 500K). Check `usage.total_tokens` from OpenAI response. Check budget BEFORE API call, increment AFTER. |
| Connection String Encryption | Tenant DB connection strings encrypted at rest using Fernet symmetric encryption. |
| Connection String Validation | On project creation: parse DSN, reject private/loopback IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) unless admin override, test connection with 5s timeout, verify PostgreSQL via `server_version`, verify read-only role by attempting a write and confirming it fails. |
| Audit Log | Log ALL attempts: project_id, question, SQL, validation_result (integer enum), rejection_reason, execution_time_ms, result_row_count, token_usage, ip_address, timestamp. |

## Data Model (Chatbot's Own Database)

```
admins
├── id (PK)
├── email (VARCHAR, unique)
├── password_hash (VARCHAR)
├── role (VARCHAR: "owner", "member")
├── created_at, updated_at

projects
├── id (PK)
├── udid (UUID, unique)
├── name (VARCHAR 255)
├── connection_string_encrypted (TEXT, Fernet encrypted)
├── schema_cache (TEXT, cached CREATE TABLE dump, sensitive columns stripped)
├── schema_cached_at (TIMESTAMP)
├── schema_refresh_interval_hours (INTEGER, default 24)
├── daily_token_limit (INTEGER, default 500000)
├── owner_admin_id (FK → admins)
├── created_at, updated_at
  Note: Phase 1 uses single-admin ownership (owner_admin_id). Each project
  belongs to one admin. All admin API endpoints filter by the authenticated
  admin's ID — admins can only see/modify their own projects. Phase 2 may
  add an admin_project_memberships table for team access with roles.

api_keys
├── id (PK)
├── key_prefix (VARCHAR 12, display: "proj_abc1...")
├── key_hash (VARCHAR 64, SHA-256, unique, indexed)
├── project_id (FK → projects)
├── is_active (BOOLEAN)
├── rate_limit_per_minute (INTEGER, default 30)
├── rate_limit_per_day (INTEGER, default 500)
├── last_used_at (TIMESTAMP)
├── created_at, updated_at

knowledge_entries
├── id (PK)
├── project_id (FK → projects)
├── category (VARCHAR 32: "navigation", "workflow", "concept", "faq")
├── title (VARCHAR 255)
├── content (TEXT)
├── url (VARCHAR 512, nullable — deep link to admin page)
├── tags (VARCHAR[], PostgreSQL array — for search/filtering)
├── sort_order (INTEGER, default 0)
├── is_active (BOOLEAN, default true)
├── created_at, updated_at
  indexes: project_id (for loading all entries per project)

conversations
├── id (PK)
├── udid (UUID, unique)
├── project_id (FK → projects)
├── session_id (VARCHAR 64, widget-generated, stored in browser localStorage
│   so conversations persist across page reloads but not across browsers)
├── started_at (TIMESTAMP)
├── updated_at (TIMESTAMP)
  indexes: (project_id, session_id) composite (for session lookup)

messages
├── id (PK)
├── conversation_id (FK → conversations)
├── role (VARCHAR 16: "user" | "assistant")
├── content (TEXT)
├── question_type (VARCHAR 16: "data" | "guidance" | null)
├── sql_query (TEXT, nullable)
├── sql_results_summary (TEXT, nullable: "47 rows returned")
├── tokens_used (INTEGER, nullable)
├── created_at (TIMESTAMP)
  indexes: conversation_id (for loading message history)

audit_logs
├── id (PK)
├── project_id (FK → projects, nullable)
├── api_key_id (FK → api_keys, nullable)
├── event_type (VARCHAR 64: "sql_executed", "sql_rejected", "guidance",
│   "api_error", "rate_limited", "budget_exceeded")
├── question (TEXT)
├── sql_query (TEXT, nullable)
├── validation_result (INTEGER: 0=passed, 1=rejected, 2=error, 3=guidance_only)
├── rejection_reason (TEXT, nullable)
├── execution_time_ms (DECIMAL)
├── result_row_count (INTEGER, nullable)
├── token_usage (INTEGER, nullable)
├── error_message (TEXT, nullable)
├── ip_address (VARCHAR 45)
├── created_at (TIMESTAMP)
  indexes: project_id, created_at, validation_result
  partition: by created_at (monthly) for efficient retention/drops
```

### Data Retention

- Conversations and messages: configurable TTL per project (default 90 days).
- Audit logs: partitioned by month. Drop partitions older than retention period.
- Cleanup: FastAPI background task runs daily, deletes expired conversations + messages, drops old audit log partitions.

## Project Structure

```
sql-chatbot/
├── app/
│   ├── main.py                          # FastAPI app, lifespan, middleware
│   ├── config.py                        # pydantic-settings BaseSettings
│   ├── database.py                      # Chatbot's own DB engine + sessions
│   │
│   ├── api/v1/
│   │   ├── router.py                    # Aggregates all domain routers
│   │   ├── auth/
│   │   │   ├── router.py                # Admin login, token refresh
│   │   │   ├── schemas.py
│   │   │   ├── models.py                # Admin ORM model
│   │   │   ├── service.py               # JWT create/verify, password hash
│   │   │   └── dependencies.py          # verify_api_key(), get_current_admin()
│   │   ├── projects/
│   │   │   ├── router.py                # CRUD projects + DB connections
│   │   │   ├── schemas.py               # Pydantic request/response models
│   │   │   ├── models.py                # SQLAlchemy ORM: Project, ApiKey
│   │   │   └── service.py               # Create project, rotate key, validate conn
│   │   ├── knowledge/
│   │   │   ├── router.py                # CRUD knowledge entries
│   │   │   ├── schemas.py
│   │   │   ├── models.py                # KnowledgeEntry ORM
│   │   │   └── service.py
│   │   ├── conversations/
│   │   │   ├── router.py                # POST /chat/stream, GET history
│   │   │   ├── schemas.py               # ChatRequest, ChatEvent, SQLResponse
│   │   │   ├── models.py                # Conversation, Message ORM
│   │   │   └── service.py               # Conversation management
│   │   └── widget/
│   │       └── router.py                # GET /widget/widget.js (serve bundle)
│   │
│   ├── services/
│   │   ├── tenant_db.py                 # Dynamic engine manager (multi-tenant)
│   │   ├── schema_inspector.py          # SQLAlchemy inspect → CREATE TABLE format
│   │   ├── knowledge_service.py         # Load + format knowledge entries for prompt
│   │   ├── llm_service.py              # OpenAI: generate_sql() + stream_answer()
│   │   ├── sql_validator.py            # sqlparse + sqlglot + blocklists
│   │   └── sql_executor.py             # Read-only query execution + timeout
│   │
│   ├── core/
│   │   ├── security.py                  # JWT, API key hashing, Fernet encryption
│   │   ├── exceptions.py                # Custom HTTP exceptions + handlers
│   │   ├── middleware.py                # CORS, request logging, rate limiting
│   │   └── logging.py                  # Structured JSON logging config
│   │
│   └── tasks/
│       └── cleanup.py                   # Background: conversation TTL, audit partition drops
│
├── alembic/                             # DB migrations for chatbot's own tables
│   ├── env.py
│   └── versions/
│
├── widget/                              # Embeddable JS widget (separate build)
│   ├── src/
│   │   ├── index.ts                     # Entry: Shadow DOM bootstrap + config
│   │   ├── ChatWidget.tsx               # React chat UI component
│   │   └── styles.css                   # Widget styles (injected into Shadow DOM)
│   ├── dist/
│   │   └── widget.js                    # Built IIFE bundle (served by FastAPI)
│   └── vite.config.ts                   # Vite lib mode → single IIFE file
│
├── tests/
│   ├── test_sql_validator.py
│   ├── test_schema_inspector.py
│   ├── test_llm_service.py
│   ├── test_knowledge_service.py
│   └── test_api/
│
├── Dockerfile
├── docker-compose.yml
├── pyproject.toml
├── alembic.ini
└── .env.example
```

## API Endpoints

### Widget API (authenticated via X-API-Key)

```
POST /api/v1/chat/stream          # Send question, receive SSE stream
GET  /api/v1/conversations/:id    # Get conversation history
```

### Admin API (authenticated via JWT Bearer token)

```
POST /api/v1/auth/login           # Admin login → JWT
POST /api/v1/auth/refresh         # Refresh JWT

POST   /api/v1/projects                          # Create project
GET    /api/v1/projects                          # List projects
GET    /api/v1/projects/:id                      # Get project
PUT    /api/v1/projects/:id                      # Update project
DELETE /api/v1/projects/:id                      # Delete project
POST   /api/v1/projects/:id/test-connection      # Test DB connection
POST   /api/v1/projects/:id/refresh-schema       # Force schema refresh
POST   /api/v1/projects/:id/api-keys             # Create API key
GET    /api/v1/projects/:id/api-keys             # List API keys (prefix + active status only, never full key)
DELETE /api/v1/projects/:id/api-keys/:key_id     # Revoke API key

POST   /api/v1/projects/:id/knowledge            # Create knowledge entry (max 100 per project)
GET    /api/v1/projects/:id/knowledge            # List entries (paginated)
GET    /api/v1/projects/:id/knowledge/:entry_id  # Get single entry
PUT    /api/v1/projects/:id/knowledge/:entry_id  # Update entry
DELETE /api/v1/projects/:id/knowledge/:entry_id  # Delete entry
```

All list endpoints (`GET .../projects`, `GET .../knowledge`, `GET .../api-keys`) support cursor-based pagination via query params: `?limit=20&after=<last_id>`. Default limit: 20, max: 100. Response includes `has_more: bool` and `next_cursor: string|null`.

### Operations

```
GET /health                       # Health check: { status, version, db_connected }
GET /ready                        # Readiness probe: can accept traffic
```

## Tech Stack

| Component | Technology | Version |
|---|---|---|
| Language | Python | 3.12 |
| Framework | FastAPI | 0.115 |
| ASGI Server | gunicorn + uvicorn workers | gunicorn 22.x, uvicorn 0.32 |
| AI SDK | openai (official Python SDK) | 1.59+ |
| ORM | SQLAlchemy (async) | 2.0.36 |
| Async PG Driver | asyncpg | 0.30 |
| Migrations | Alembic | 1.14 |
| SQL Parsing | sqlparse | 0.5.3 |
| SQL AST Analysis | sqlglot | 25.x |
| SSE | sse-starlette | 2.1 |
| Auth (JWT) | python-jose[cryptography] | 3.3 |
| Password Hashing | passlib[bcrypt] | 1.7 |
| Encryption | cryptography (Fernet) | 43.x |
| Rate Limiting | redis (via redis-py async) | 5.x |
| Config | pydantic-settings | 2.7 |
| Logging | structlog | 24.x |
| Widget Build | Vite (lib mode, IIFE) | 6.x |
| Widget UI | React (bundled in IIFE) | 19.x |
| Linting | ruff | 0.8 |
| Testing | pytest + pytest-asyncio | 8.x |

## Widget Embedding (Any Technology)

```html
<!-- One line — works on any admin panel -->
<script src="https://your-chatbot.com/widget/widget.js"
        data-api-key="proj_live_abc123"
        data-api-url="https://your-chatbot.com"
        data-position="bottom-right"
        async></script>
```

**Placement:** Before the closing `</body>` tag (not in `<head>`). The `async` attribute prevents blocking page load. The widget creates its DOM container after the body exists.

**How it works:**
- Loads as an IIFE (no module system required)
- Reads config from `data-*` attributes on its own script tag
- Creates a Shadow DOM container (complete CSS isolation from host page)
- Renders a floating chat panel (bottom-right by default)
- Communicates via `fetch()` + `ReadableStream` (not EventSource, because POST + custom headers are needed)
- `session_id` stored in `localStorage` so conversations persist across page reloads within the same browser
- Widget bundle served with content hash for cache-busting: `/widget/widget.js?v={build_hash}`

**Browser requirements:** All modern browsers (Chrome, Firefox, Safari, Edge). Requires Streams API support. No IE11 support.

## Error Handling

| Scenario | Response to User |
|---|---|
| OpenAI API timeout (>15s) | "I'm taking too long. Please try again." |
| OpenAI API error (5xx) | "Having trouble connecting. Retrying..." (auto-retry once, 2s delay) |
| OpenAI rate limit (429) | "Please wait a moment and try again." |
| SQL validation rejected | "I generated an unsafe query and blocked it. Could you rephrase?" |
| Query timeout (>30s) | "That query was too complex. Could you be more specific?" |
| Query execution error | "I wrote a query the database couldn't run. Let me try differently." (auto-retry with error context) |
| Empty results | "No results found for that query." |
| Guidance question | Stream guidance answer directly (no SQL step) |
| Unknown question type | "I'm not sure how to help with that. Try asking about your data or how to use the admin panel." |
| Invalid API key | 403: "Invalid API key" |
| Rate limit exceeded | 429: "Rate limit exceeded. Please wait." |
| Daily token budget exceeded | "This project has reached its daily query limit." |
| Tenant DB connection failed | "Could not connect to the database. Please check connection settings." |
| Schema too large | "Database has too many tables. Please configure which tables to include." |

## Logging & Monitoring

- **Structured JSON logging** via `structlog` to stdout (Docker-friendly, collected by any log aggregator).
- **Log levels:** ERROR for failures, WARNING for rejected SQL / rate limits, INFO for each chat request (project_id, question_type, latency_ms, tokens).
- **Key metrics to track:** request latency, LLM call latency (call 1 + call 2 separately), SQL execution time, error rates by type, token usage per project, active tenant connections.
- **Health endpoint** (`GET /health`) for Docker health checks and load balancer probes.
- **Alerting triggers:** error rate > 5% over 5 minutes, tenant DB connection failure, daily token budget > 80%.

## Deployment

```yaml
# docker-compose.yml
services:
  api:
    build: .
    ports: ["8000:8000"]
    environment:
      DATABASE_URL: postgresql+asyncpg://chatbot:secret@db:5432/chatbot
      REDIS_URL: redis://redis:6379/0
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      JWT_SECRET_KEY: ${JWT_SECRET_KEY}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: chatbot
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: chatbot
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chatbot"]
      interval: 5s

volumes:
  pgdata:
```

**Server:** `gunicorn` as process manager with `uvicorn.workers.UvicornWorker`, 2-4 workers.

**Startup:** Entrypoint script runs `alembic upgrade head` then starts gunicorn.

**First admin bootstrap:** `python -m app.cli create-admin --email admin@example.com` (CLI command, run once after first deploy).

**Required environment variables:**
- `DATABASE_URL` — chatbot's own PostgreSQL
- `REDIS_URL` — Redis for rate limiting (shared across workers)
- `OPENAI_API_KEY` — OpenAI API key
- `JWT_SECRET_KEY` — for signing JWT tokens
- `ENCRYPTION_KEY` — Fernet key for encrypting tenant connection strings

## MSP Integration (First Customer)

To integrate this chatbot into the MSP admin panel:

1. **Deploy the chatbot API** (Docker container, separate from MSP)
2. **Create first admin** via CLI: `python -m app.cli create-admin`
3. **Create a project** via admin API with MSP's PostgreSQL connection string (using a read-only PG role)
4. **Add knowledge entries** via admin API — MSP admin panel pages, workflows, how-tos
5. **Get an API key** for the project
6. **Add one line** to `app/views/layouts/admin_application.html.erb` (before closing `</body>`):

```erb
<% if admin_signed_in? %>
  <script src="<%= Rails.application.credentials.dig(:chatbot, :api_url) %>/widget/widget.js"
          data-api-key="<%= Rails.application.credentials.dig(:chatbot, :api_key) %>"
          data-api-url="<%= Rails.application.credentials.dig(:chatbot, :api_url) %>"
          data-position="bottom-right" async></script>
<% end %>
```

No gems, no Ruby code, no migrations in MSP. One script tag in the layout.

## Schema Cache Strategy

- **Auto-refresh:** If `schema_cached_at` is older than `schema_refresh_interval_hours` (default 24h), refresh on next query.
- **Manual refresh:** Admin API endpoint `POST /projects/:id/refresh-schema`.
- **Size limit:** If CREATE TABLE dump exceeds 50KB (~100+ tables), store only and prompt with the most-queried tables (tracked via audit logs). Remaining tables available on-demand.
- **Sensitive column stripping:** Before caching, remove columns matching the blocklist patterns from the schema. The LLM never sees these columns.

## Cost Estimate

- ~$0.001-0.003 per question (2 API calls with GPT-4o mini) for data-only queries
- Knowledge base context injection adds ~30-50% token overhead (2-5K tokens per call for a typical 50-entry knowledge base)
- With knowledge base: ~$0.002-0.005 per question
- Large result sets (50 rows of data in 2nd call) push toward $0.007
- At 100 questions/day: ~$8-20/month
- At 500 questions/day: ~$40-100/month
- Per-project daily token cap is configurable (default 500K tokens ≈ ~$0.10/day)

## Future Extensions (Not in Phase 1)

- **RAG with pgvector** — for large knowledge bases, retrieve only relevant entries per question instead of injecting all
- **Contextual awareness** — widget passes current page URL, chatbot gives page-specific guidance
- **Quick actions / deep links** — clickable links in chat that navigate to admin pages
- **Multiple DB engines** — MySQL, SQL Server, SQLite (sqlglot already supports multiple dialects)
- **Write actions** — with confirmation flow and approval chain
- **Admin dashboard UI** — web interface for managing projects, viewing conversations, analytics
- **Custom knowledge upload** — drag-and-drop PDFs/docs, auto-indexed via RAG
- **Proactive alerts** — configurable alert rules, chatbot notifies when conditions are met
- **Report generation** — formatted reports with tables/charts, exportable
- **Multi-language** — admin asks in any language, chatbot responds in same language
