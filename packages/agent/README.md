# sql-chatbot-agent

AI-powered database chatbot that runs as a **standalone CLI** or **Express middleware**. Point it at any PostgreSQL database and get an AI assistant that can query your data, explain your code, and help users navigate your app.

**Zero configuration required** -- it auto-discovers your database schema, indexes your codebase, and serves a chat widget.

## Quick Start (CLI)

The fastest way to get started is the standalone CLI. No existing Express app needed.

### Install globally

```bash
npm install -g sql-chatbot-agent
```

### Initialize a config file

```bash
sql-chatbot-agent init
```

This creates a `chatbot.config.json` in the current directory and adds it to `.gitignore`.

Edit the file with your database URL and Groq API key, then start the chatbot:

```bash
sql-chatbot-agent
```

The chatbot will be running at `http://localhost:3456` with a chat widget ready to use.

### One-liner with npx

Skip installation entirely:

```bash
npx sql-chatbot-agent --db postgresql://localhost/mydb --key gsk_xxx --code ./app
```

## Configuration

### chatbot.config.json

Created by `sql-chatbot-agent init`:

```json
{
  "databaseUrl": "postgresql://user:password@localhost:5432/your_database",
  "groqApiKey": "your-groq-api-key",
  "codePaths": ["./src"],
  "port": 3456,
  "secret": ""
}
```

| Field | Type | Description |
|-------|------|-------------|
| `databaseUrl` | string | PostgreSQL connection URL (required) |
| `groqApiKey` | string | Groq API key -- free at [console.groq.com](https://console.groq.com) (required) |
| `codePaths` | string[] | Directories to index for code questions (default: `["./src"]`) |
| `port` | number | Port for the standalone server (default: `3456`) |
| `secret` | string | Secret token for authentication (optional, recommended for production) |

### CLI Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--db` | | PostgreSQL connection URL |
| `--key` | | Groq API key |
| `--code` | | Directory to index (single path) |
| `--port` | `-p` | Port for the standalone server |
| `--secret` | | Secret token for authentication |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL |
| `GROQ_API_KEY` | Groq API key |
| `CHATBOT_SECRET` | Secret token for authentication |
| `PORT` | Port for the standalone server |

### Priority Order

Configuration is resolved in this order (highest priority first):

1. **CLI flags** (`--db`, `--key`, etc.)
2. **Environment variables** (`DATABASE_URL`, `GROQ_API_KEY`, etc.)
3. **Config file** (`chatbot.config.json`)

## Authentication

For production use, set a secret token to protect the chatbot API.

### Setup

Provide a secret via any configuration method:

```bash
# CLI flag
sql-chatbot-agent --secret my-secret-token

# Environment variable
CHATBOT_SECRET=my-secret-token sql-chatbot-agent

# Or in chatbot.config.json
# { "secret": "my-secret-token" }
```

### How It Works

When a secret is configured:

1. **Widget script** (`/chatbot/widget.js`) -- sets a `chatbot_token` cookie on load
2. **API endpoints** (`/chatbot/api/ask`, `/chatbot/api/refresh`) -- validate the cookie or a `Bearer` token in the `Authorization` header
3. **Health endpoint** (`/chatbot/api/health`) -- remains open (no sensitive data)

Requests without a valid token receive a `401 Unauthorized` response.

### Without a Secret

If no secret is configured, the chatbot API is open to anyone. The CLI prints a warning on startup:

```
Warning: No secret configured. The chatbot API is open to anyone.
```

This is fine for local development but should not be used in production.

### .gitignore

Add `chatbot.config.json` to your `.gitignore` to avoid committing secrets. The `init` command does this automatically.

## Express Middleware (Advanced)

If you already have an Express app and want to embed the chatbot into it, use the middleware directly:

### 1. Install

```bash
npm install sql-chatbot-agent
```

### 2. Add to your Express app

```js
const express = require('express');
const { sqlChatbot } = require('sql-chatbot-agent');

const app = express();

app.use('/chatbot', sqlChatbot({
  databaseUrl: process.env.DATABASE_URL,
  groqApiKey: process.env.GROQ_API_KEY,
  codePaths: ['./src'],
  secret: process.env.CHATBOT_SECRET,
}));

app.listen(3000);
```

### 3. Add the widget to your HTML

```html
<script src="/chatbot/widget.js"></script>
```

A chat bubble appears in the bottom-right corner of your page.

## How It Works

When a user asks a question, the chatbot:

1. **Classifies** the question (data query, code question, navigation, etc.)
2. **Routes** to the right handler:
   - **Data questions** -- generates SQL, executes it read-only, explains the results
   - **Code questions** -- searches your indexed codebase, explains the relevant code
   - **Navigation** -- uses detected routes and page context to guide the user
3. **Streams** the answer back via Server-Sent Events (SSE)

```
User: "How many active users signed up this month?"
  -> Classifies as "data" question
  -> Generates: SELECT COUNT(*) FROM users WHERE active = true AND created_at >= '2026-02-01'
  -> Executes read-only
  -> Streams: "There are 142 active users who signed up this month."
```

## API Endpoints

When mounted at `/chatbot` (or running standalone), the following endpoints are available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chatbot/widget.js` | GET | Serves the chat widget bundle |
| `/chatbot/api/ask` | POST | Main chat endpoint (SSE streaming) |
| `/chatbot/api/health` | GET | Health check with table/file counts |
| `/chatbot/api/refresh` | POST | Re-discover schema and re-index code |

### POST /api/ask

Request body:
```json
{
  "question": "How many users are there?",
  "pageContext": "{\"url\": \"...\", \"title\": \"...\"}",
  "history": [
    { "role": "user", "content": "previous question" },
    { "role": "assistant", "content": "previous answer" }
  ]
}
```

Response: SSE stream with events:
```
data: {"type":"classifying"}
data: {"type":"classified","questionType":"data","confidence":0.9}
data: {"type":"sql","sql":"SELECT COUNT(*) FROM users"}
data: {"type":"executing"}
data: {"type":"token","content":"There"}
data: {"type":"token","content":" are"}
data: {"type":"token","content":" 1,234"}
data: {"type":"token","content":" users."}
data: {"type":"done"}
```

### GET /api/health

```json
{
  "status": "ok",
  "tables": 25,
  "codeFiles": 150
}
```

## Features

- **CLI standalone mode** -- run as a standalone server with zero boilerplate
- **Built-in authentication** -- secret token authentication with cookie and Bearer token support
- **Auto-discovers your database schema** -- tables, columns, types, foreign keys, indexes
- **Indexes your codebase** -- scans JS/TS/Ruby/Python files, detects Express/React/Next.js/Rails routes
- **SQL safety** -- validates queries against blocklists, executes in READ ONLY transactions, blocks destructive operations
- **Sensitive data filtering** -- automatically hides columns matching patterns like `password`, `secret`, `api_key`, `ssn`
- **Chat widget with Shadow DOM** -- no CSS conflicts with your app
- **Conversation history** -- the widget sends message history for contextual follow-ups
- **Provider agnostic** -- defaults to Groq (free), works with any OpenAI-compatible API
- **Lazy initialization** -- schema discovery and code indexing happen on first request, not at startup

## Supported Frameworks

The code indexer detects routes from:
- Express.js (`app.get`, `router.post`, etc.)
- React Router (`<Route path="...">`)
- Next.js (pages/ and app/ directory conventions)
- Rails (`resources`, `get`, `post` in routes.rb)

## Security

- All SQL queries run inside `SET TRANSACTION READ ONLY` -- no writes possible
- Dangerous SQL keywords (`DROP`, `DELETE`, `TRUNCATE`, `ALTER`, etc.) are blocked before execution
- System catalogs (`pg_catalog`, `information_schema`) are blocked from queries
- Sensitive columns are automatically filtered from the schema summary sent to the LLM
- Built-in secret token authentication for production deployments
- `chatbot.config.json` is automatically added to `.gitignore` by the `init` command

## Requirements

- Node.js >= 18
- PostgreSQL database
- A Groq API key (free) or any OpenAI-compatible LLM API key

## License

MIT
