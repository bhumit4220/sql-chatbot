# SQL Chatbot — Developer Integration Guide

> How to integrate the SQL Chatbot into any new project, from zero to full integration.

## Prerequisites

- Docker & Docker Compose installed
- PostgreSQL database (the target database you want to query)
- A web application with an admin panel (for widget embedding)

---

## Step 1: Deploy the Chatbot Stack

Clone and start the chatbot API, Redis, and chatbot PostgreSQL database:

```bash
cd "/path/to/sql-chatbot"
docker compose up -d --build
```

This starts three containers:
- **sql-chatbot-api** — FastAPI app on `http://localhost:8000`
- **sql-chatbot-redis** — Redis on port 6380
- **sql-chatbot-db** — PostgreSQL (chatbot's own DB) on port 5433

Verify it's running:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

---

## Step 2: Create an Admin Account

Register as an admin (owner role is created automatically for the first user):

```bash
curl -X POST http://localhost:8000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourcompany.com", "password": "YourSecurePassword123"}'
```

Then log in to get a JWT token:

```bash
curl -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourcompany.com", "password": "YourSecurePassword123"}'
```

Save the `access_token` from the response — you'll need it for all subsequent API calls.

```bash
export TOKEN="your_access_token_here"
```

---

## Step 3: Create a Project with Your Database Connection

A "project" connects the chatbot to your target database:

```bash
curl -X POST http://localhost:8000/api/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "connection_string": "postgresql+asyncpg://user:pass@host:5432/dbname",
    "allowed_tables": null,
    "blocked_tables": ["admin_users", "sessions", "ar_internal_metadata", "schema_migrations"]
  }'
```

**Important notes:**
- The connection string must use `postgresql+asyncpg://` prefix (async driver)
- If your database is on the host machine and the chatbot runs in Docker, use the Docker bridge IP (typically `172.19.0.1` or `172.17.0.1`) instead of `localhost`
- `blocked_tables` excludes sensitive tables from auto-discovery and queries
- The connection string is encrypted at rest using Fernet encryption

Save the `id` from the response — this is your `project_id`.

---

## Step 4: Trigger Auto-Discovery

Auto-discovery scans your database schema (tables, columns, types, foreign keys, constraints, indexes, comments) and samples data to detect enum-like patterns:

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/discovery/run \
  -H "Authorization: Bearer $TOKEN"
```

This creates `schema_documents` in the vector store — the chatbot uses these via RAG (Retrieval-Augmented Generation) to understand your database structure when generating SQL.

Check discovery status:

```bash
curl http://localhost:8000/api/v1/projects/{project_id}/discovery/status \
  -H "Authorization: Bearer $TOKEN"
```

---

## Step 5: Generate an API Key for the Widget

The embedded widget authenticates via an API key (not JWT):

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production Widget"}'
```

**Save the `raw_key` from the response immediately** — it is shown only once. The key is stored as a SHA-256 hash and cannot be retrieved later.

---

## Step 6: Seed Semantic Context (Business Knowledge)

Auto-discovery learns your schema structure, but it cannot know the *meaning* of your data. For example, if your `users` table has `status = 1` meaning "Active", the chatbot needs to be told this.

Create a JSON file (e.g., `semantic_context.json`) with your business knowledge:

```json
{
  "enum_mappings": [
    {
      "table": "users",
      "column": "status",
      "mappings": {"1": "Active", "2": "Inactive", "3": "Deleted"},
      "description": "User account status. Active = registered and usable. Deleted = soft-deleted, exclude by default."
    }
  ],
  "column_descriptions": [
    {
      "table": "orders",
      "column": "created_by",
      "description": "Foreign key to users table (the user who placed the order). This is the user FK, NOT a column called user_id.",
      "synonyms": ["user_id", "customer"]
    }
  ],
  "business_rules": [
    {
      "title": "Soft Delete Rule",
      "rule": "All models use soft deletes via status=3. Always exclude status=3 unless explicitly asked for deleted records.",
      "tables": ["users", "orders", "products"],
      "sql_filter": "status != 3"
    }
  ],
  "verified_queries": [
    {
      "question": "How many active users are there?",
      "sql": "SELECT COUNT(*) FROM users WHERE status = 1",
      "explanation": "Active = status 1. Excludes soft-deleted (status=3)."
    }
  ],
  "metric_definitions": [
    {
      "name": "Total Revenue",
      "sql_expression": "SUM(orders.total_amount)",
      "description": "Sum of all order totals",
      "tables": ["orders"]
    }
  ]
}
```

Import it via the batch endpoint (replaces all semantic entries each time):

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/knowledge/semantic-context \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @semantic_context.json
```

**Categories explained:**
| Category | Purpose | When to Use |
|----------|---------|-------------|
| `enum_mappings` | Maps integer values to human labels | Any column that stores integer codes (status, type, role, etc.) |
| `column_descriptions` | Explains non-obvious column names | Abbreviated columns (`serv_type`), misleading FKs (`created_by` instead of `user_id`) |
| `business_rules` | Default filters and logic | Soft deletes, "completed" = multiple statuses, stale cache columns to avoid |
| `verified_queries` | Known-good SQL for common questions | Your top 5-10 most-asked dashboard questions |
| `metric_definitions` | Standard calculations | Revenue formulas, KPI definitions, aggregation rules |

**Tip:** Start with enum_mappings and business_rules — these have the biggest impact on accuracy. Add verified_queries for your most common questions. You can re-run the import any time to update.

---

## Step 7: Add Navigation Knowledge (Optional)

If you want the chatbot to answer "where do I find X?" questions about your admin panel, add navigation entries:

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/knowledge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "navigation",
    "title": "Users Page",
    "content": "Go to Users in the left sidebar to see all registered users. You can filter by status, search by name/email, and export to CSV.",
    "url": "/admin/users"
  }'
```

Repeat for each page/feature in your admin panel.

---

## Step 8: Embed the Widget

Add this single script tag to your admin layout (before `</body>`):

```html
<script
  src="http://localhost:8000/static/widget/chatbot-widget.js"
  data-api-url="http://localhost:8000"
  data-api-key="YOUR_RAW_API_KEY_HERE"
  data-position="bottom-right"
  data-chatbot-id="my-app-chatbot"
></script>
```

**Attributes:**

| Attribute | Required | Description |
|-----------|----------|-------------|
| `data-api-url` | Yes | Base URL of the chatbot API |
| `data-api-key` | Yes | The raw API key from Step 5 |
| `data-position` | No | `bottom-right` (default) or `bottom-left` |
| `data-chatbot-id` | No | Unique ID if embedding multiple widgets |

The widget:
- Renders as a floating chat bubble in the corner
- Runs inside a Shadow DOM (isolated from your app's CSS)
- Streams responses via Server-Sent Events (SSE)
- Requires no npm dependencies — it's a single vanilla JS file

---

## Step 9: Test and Verify

Open your admin panel and click the chat widget. Try these types of questions:

1. **Data questions**: "How many active users are there?" — should generate SQL and return a number
2. **Detail questions**: "Show me the last 5 orders" — should return names and details, not just IDs
3. **Navigation questions**: "Where can I manage users?" — should point to the admin page
4. **Help questions**: "What can you do?" — should list capabilities
5. **Action requests**: "Delete user #123" — should refuse (read-only) and redirect to the relevant page

If answers are wrong:
- **Wrong enum values**: Add/fix entries in `enum_mappings`
- **Wrong JOIN path**: Add a `business_rule` explaining the correct join
- **Wrong column name**: Add a `column_description` with synonyms
- **Consistently wrong SQL for a common question**: Add a `verified_query`

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│  Your Admin App  │     │           SQL Chatbot Stack              │
│                  │     │                                          │
│  ┌────────────┐  │     │  ┌─────────┐  ┌───────┐  ┌───────────┐ │
│  │  Widget JS  │──────────│ FastAPI  │──│ Redis │  │ Chatbot   │ │
│  │  (Shadow   │  │SSE  │  │  API    │  │(cache)│  │ PostgreSQL│ │
│  │   DOM)     │  │     │  └────┬────┘  └───────┘  │ (pgvector)│ │
│  └────────────┘  │     │       │                   └───────────┘ │
│                  │     │       │ Read-only SQL                    │
└─────────────────┘     │       ▼                                  │
                        │  ┌─────────┐                             │
                        │  │ Your DB │ (PostgreSQL)                │
                        │  └─────────┘                             │
                        └──────────────────────────────────────────┘
```

**Flow:**
1. User types question in widget
2. Widget sends question to API via SSE stream
3. API classifies question (data vs guidance)
4. For data: RAG retrieves relevant schema docs → LLM generates SQL → SQL executed read-only → LLM formats answer
5. For guidance: Knowledge base entries used to answer navigation/how-to questions
6. Streamed response displayed in widget

---

## Quick Reference

| Action | Endpoint | Method |
|--------|----------|--------|
| Register admin | `/api/v1/auth/register` | POST |
| Login | `/api/v1/auth/login` | POST |
| Create project | `/api/v1/projects` | POST |
| Run discovery | `/api/v1/projects/{id}/discovery/run` | POST |
| Create API key | `/api/v1/projects/{id}/api-keys` | POST |
| Import semantic context | `/api/v1/projects/{id}/knowledge/semantic-context` | POST |
| Add knowledge entry | `/api/v1/projects/{id}/knowledge` | POST |
| List knowledge entries | `/api/v1/projects/{id}/knowledge` | GET |
| Chat (SSE stream) | `/api/v1/conversations/{id}/messages/stream` | POST |
| Health check | `/health` | GET |

---

## Troubleshooting

**Docker can't reach host PostgreSQL:**
Your host PostgreSQL must listen on the Docker bridge IP. Check with:
```bash
docker network inspect sql-chatbot_default | grep Gateway
```
Then add that IP to `listen_addresses` in `postgresql.conf` and add a line to `pg_hba.conf`:
```
host all all 172.19.0.0/16 md5
```
Restart PostgreSQL after changes.

**Widget not appearing:**
- Check browser console for errors
- Verify the `data-api-url` is reachable from the browser
- Verify the API key is correct (401 errors = bad key)

**Wrong SQL results:**
- Add more `enum_mappings` for integer-coded columns
- Add `business_rules` for default filters (soft deletes, completion statuses)
- Add `verified_queries` for common questions the LLM gets wrong
- Re-run auto-discovery if schema has changed

**Stale schema after DB changes:**
Re-run discovery: `POST /api/v1/projects/{id}/discovery/run`
