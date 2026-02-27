# sql-chatbot-agent

AI chatbot middleware for Express apps with PostgreSQL. Drop it into any Node.js web app and get an AI assistant that can query your database, explain your code, and help users navigate your app.

**Zero configuration required** — it auto-discovers your database schema, indexes your codebase, and serves a chat widget.

## Quick Start

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
}));

app.listen(3000);
```

### 3. Add the widget to your HTML

```html
<script src="/chatbot/widget.js"></script>
```

That's it. A chat bubble appears in the bottom-right corner of your page.

## How It Works

When a user asks a question, the chatbot:

1. **Classifies** the question (data query, code question, navigation, etc.)
2. **Routes** to the right handler:
   - **Data questions** → generates SQL, executes it read-only, explains the results
   - **Code questions** → searches your indexed codebase, explains the relevant code
   - **Navigation** → uses detected routes and page context to guide the user
3. **Streams** the answer back via Server-Sent Events (SSE)

```
User: "How many active users signed up this month?"
  → Classifies as "data" question
  → Generates: SELECT COUNT(*) FROM users WHERE active = true AND created_at >= '2026-02-01'
  → Executes read-only
  → Streams: "There are 142 active users who signed up this month."
```

## Configuration

```js
sqlChatbot({
  // Required
  databaseUrl: 'postgresql://user:pass@localhost/mydb',

  // LLM API key (one of these is required)
  groqApiKey: 'gsk_...',           // Groq API key (free tier)
  // OR
  llmApiKey: 'your-api-key',      // Any OpenAI-compatible provider

  // Optional
  codePaths: ['./src'],            // Directories to index (default: ['./src'])
  llmBaseUrl: 'https://...',       // Custom LLM endpoint (default: Groq)
  llmModel: 'llama-3.3-70b-versatile',  // Model name (default: Groq's llama-3.3-70b)
})
```

### Environment Variables

Instead of passing config directly, you can use environment variables:

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Groq API key (free at [console.groq.com](https://console.groq.com)) |
| `LLM_API_KEY` | Alternative: any OpenAI-compatible API key |
| `LLM_BASE_URL` | Custom LLM endpoint URL |
| `LLM_MODEL` | Model name to use |

## API Endpoints

When mounted at `/chatbot`, the middleware exposes:

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

- **Auto-discovers your database schema** — tables, columns, types, foreign keys, indexes
- **Indexes your codebase** — scans JS/TS/Ruby/Python files, detects Express/React/Next.js/Rails routes
- **SQL safety** — validates queries against blocklists, executes in READ ONLY transactions, blocks destructive operations
- **Sensitive data filtering** — automatically hides columns matching patterns like `password`, `secret`, `api_key`, `ssn`
- **Chat widget with Shadow DOM** — no CSS conflicts with your app
- **Conversation history** — the widget sends message history for contextual follow-ups
- **Provider agnostic** — defaults to Groq (free), works with any OpenAI-compatible API
- **Lazy initialization** — schema discovery and code indexing happen on first request, not at startup

## Supported Frameworks

The code indexer detects routes from:
- Express.js (`app.get`, `router.post`, etc.)
- React Router (`<Route path="...">`)
- Next.js (pages/ and app/ directory conventions)
- Rails (`resources`, `get`, `post` in routes.rb)

## Requirements

- Node.js >= 18
- PostgreSQL database
- A Groq API key (free) or any OpenAI-compatible LLM API key

## Security

- All SQL queries run inside `SET TRANSACTION READ ONLY` — no writes possible
- Dangerous SQL keywords (`DROP`, `DELETE`, `TRUNCATE`, `ALTER`, etc.) are blocked before execution
- System catalogs (`pg_catalog`, `information_schema`) are blocked from queries
- Sensitive columns are automatically filtered from the schema summary sent to the LLM
- No authentication built in — your app handles auth. The chatbot sees what your app sees.

## License

MIT
