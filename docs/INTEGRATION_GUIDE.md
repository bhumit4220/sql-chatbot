# sql-chatbot-agent: Production Integration Guide

How to add the AI chatbot to your live project server.

## Table of Contents

- [Option A: Standalone Server (Recommended)](#option-a-standalone-server-recommended)
- [Option B: Express Middleware](#option-b-express-middleware)
- [Choosing a Provider](#choosing-a-provider)
- [Production Deployment](#production-deployment)
- [Security Checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Option A: Standalone Server (Recommended)

Run the chatbot as a separate service alongside your existing app. No code changes to your project needed.

### Step 1: Install

```bash
npm install -g sql-chatbot-agent
```

Or use `npx` without installing (shown below).

### Step 2: Get an API Key

Pick a provider and get a key:

| Provider | Get Key At | Free? |
|----------|-----------|-------|
| **OpenRouter** | https://openrouter.ai/keys | Yes (50 req/day, 1000/day with $10 credit) |
| **Groq** | https://console.groq.com | Yes (100K tokens/day) |
| **Ollama** | https://ollama.com (install locally) | Yes (unlimited, runs on your machine) |
| **OpenAI** | https://platform.openai.com | No (pay-per-use) |

### Step 3: Set Environment Variables

```bash
# Required
export DATABASE_URL="postgresql://user:password@your-db-host:5432/your_database"

# Pick ONE of these depending on your provider:
export OPENROUTER_API_KEY="sk-or-v1-xxx"   # OpenRouter
# OR
export LLM_API_KEY="gsk_xxx"               # Groq
# OR
export LLM_API_KEY="sk-xxx"                # OpenAI

# Recommended for production
export CHATBOT_SECRET="a-long-random-string-here"
```

### Step 4: Start the Server

```bash
# OpenRouter (default)
npx sql-chatbot-agent --db "$DATABASE_URL" --code /path/to/your/project/src

# Groq
npx sql-chatbot-agent --db "$DATABASE_URL" --provider groq --code /path/to/your/project/src

# Ollama (local)
npx sql-chatbot-agent --db "$DATABASE_URL" --provider ollama --code /path/to/your/project/src

# Custom port
npx sql-chatbot-agent --db "$DATABASE_URL" --code ./src --port 4000
```

You should see:

```
SQL Chatbot Agent running at http://localhost:3456
  Provider:     openrouter
  Chat widget:  http://localhost:3456
  Health check: http://localhost:3456/chatbot/api/health
  Auth: enabled
```

### Step 5: Add Widget to Your Frontend

Add this single script tag to your HTML (e.g., in your layout/index file):

```html
<!-- Before </body> tag -->
<script src="http://your-server-ip:3456/chatbot/widget.js"></script>
```

If your chatbot is on the same domain behind a reverse proxy:

```html
<script src="/chatbot/widget.js"></script>
```

A chat bubble will appear in the bottom-right corner of your page. That's it.

### Step 6: Verify

```bash
# Check health
curl http://localhost:3456/chatbot/api/health
# Returns: {"status":"ok","tables":25,"codeFiles":150}

# Test a question (without auth)
curl -N http://localhost:3456/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How many users are there?"}'

# Test with auth (if secret is set)
curl -N http://localhost:3456/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"question":"How many users are there?"}'
```

---

## Option B: Express Middleware

Embed the chatbot directly into your existing Express/Node.js app.

### Step 1: Install

```bash
npm install sql-chatbot-agent
```

### Step 2: Add to Your App

```javascript
const express = require('express');
const { sqlChatbot } = require('sql-chatbot-agent');

const app = express();

// Mount the chatbot at /chatbot
app.use('/chatbot', sqlChatbot({
  databaseUrl: process.env.DATABASE_URL,
  provider: 'openrouter',                    // or 'groq', 'ollama', 'openai'
  llmApiKey: process.env.OPENROUTER_API_KEY,  // or LLM_API_KEY
  codePaths: ['./app', './src'],              // directories with your source code
  secret: process.env.CHATBOT_SECRET,         // optional, recommended for production
}));

// Your other routes...
app.get('/', (req, res) => res.send('My App'));

app.listen(3000);
```

### Step 3: Add Widget to Your HTML

```html
<script src="/chatbot/widget.js"></script>
```

### Endpoints Created

| Path | Description |
|------|-------------|
| `GET /chatbot/widget.js` | Chat widget JavaScript bundle |
| `POST /chatbot/api/ask` | Main chat endpoint (SSE streaming) |
| `GET /chatbot/api/health` | Health check (table count, code file count) |
| `POST /chatbot/api/refresh` | Re-discover schema and re-index code |

---

## Choosing a Provider

### OpenRouter (Recommended for Getting Started)

- **Cost:** Free (50 requests/day). Add $10 credit for 1000/day. Credit is NOT consumed by free models.
- **Quality:** Routes across multiple free models automatically
- **Setup:** Get key at https://openrouter.ai/keys
- **Env var:** `OPENROUTER_API_KEY`

```bash
export OPENROUTER_API_KEY=sk-or-v1-xxx
npx sql-chatbot-agent --db "$DATABASE_URL" --code ./src
```

### Groq (Best Free Quality)

- **Cost:** Free (100K tokens/day, ~30-50 chatbot questions)
- **Quality:** High -- uses Llama 3.3 70B
- **Setup:** Get key at https://console.groq.com
- **Env var:** `LLM_API_KEY` or `GROQ_API_KEY`

```bash
export LLM_API_KEY=gsk_xxx
npx sql-chatbot-agent --db "$DATABASE_URL" --provider groq --code ./src
```

### Ollama (Best for Production / Unlimited)

- **Cost:** Free, unlimited (uses your server's GPU/CPU)
- **Quality:** Depends on model and hardware
- **Setup:** Install Ollama, pull a model

```bash
# On your server
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
ollama serve

# Then run chatbot
npx sql-chatbot-agent --db "$DATABASE_URL" --provider ollama --code ./src
```

### OpenAI (Best Quality, Paid)

- **Cost:** ~$0.15 per 1M input tokens, ~$0.60 per 1M output tokens (gpt-4o-mini)
- **Quality:** Highest
- **Env var:** `LLM_API_KEY`

```bash
export LLM_API_KEY=sk-xxx
npx sql-chatbot-agent --db "$DATABASE_URL" --provider openai --code ./src
```

---

## Production Deployment

### Using PM2 (Process Manager)

```bash
npm install -g pm2

# Start
pm2 start "npx sql-chatbot-agent --db $DATABASE_URL --code ./src --secret $CHATBOT_SECRET" --name chatbot

# Auto-restart on crash + persist across reboots
pm2 save
pm2 startup
```

### Using systemd

Create `/etc/systemd/system/sql-chatbot.service`:

```ini
[Unit]
Description=SQL Chatbot Agent
After=network.target postgresql.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/your/project
Environment=DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
Environment=OPENROUTER_API_KEY=sk-or-v1-xxx
Environment=CHATBOT_SECRET=your-secret-here
ExecStart=/usr/bin/npx sql-chatbot-agent --code ./src
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable sql-chatbot
sudo systemctl start sql-chatbot
sudo journalctl -u sql-chatbot -f  # view logs
```

### Using Docker

```dockerfile
FROM node:20-slim
RUN npm install -g sql-chatbot-agent
WORKDIR /app
COPY ./src ./src
CMD ["sql-chatbot-agent", "--code", "./src"]
```

```bash
docker run -d \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e OPENROUTER_API_KEY="sk-or-v1-xxx" \
  -e CHATBOT_SECRET="your-secret" \
  -p 3456:3456 \
  your-chatbot-image
```

### Nginx Reverse Proxy

To serve the chatbot on the same domain as your app:

```nginx
# In your nginx server block
location /chatbot/ {
    proxy_pass http://127.0.0.1:3456/chatbot/;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;           # Required for SSE streaming
    proxy_cache off;
    proxy_read_timeout 300s;       # LLM responses can be slow
}
```

Then your widget tag becomes:

```html
<script src="/chatbot/widget.js"></script>
```

---

## Security Checklist

- [ ] **Set a secret token** -- `--secret` or `CHATBOT_SECRET` env var. Without it, anyone can query your database.
- [ ] **Never hardcode API keys** in source code. Always use environment variables.
- [ ] **Add `chatbot.config.json` to `.gitignore`** -- the `init` command does this automatically.
- [ ] **Use HTTPS** in production (via reverse proxy like Nginx/Caddy).
- [ ] **SQL is read-only** -- all queries run inside `SET TRANSACTION READ ONLY`. Destructive keywords (`DROP`, `DELETE`, etc.) are blocked.
- [ ] **Sensitive columns are hidden** -- columns matching patterns like `password`, `secret`, `api_key`, `ssn` are automatically excluded from the schema sent to the LLM.

---

## Troubleshooting

### "Error: API key is required"

You need to provide an API key. Set one of:
- `OPENROUTER_API_KEY` (get free at https://openrouter.ai/keys)
- `LLM_API_KEY` or `GROQ_API_KEY`
- Or use `--provider ollama` (no key needed, but requires Ollama running locally)

### "429 Rate limit exceeded: free-models-per-day"

OpenRouter free tier is 50 requests/day without credits. Each chatbot question uses 2-3 API calls (classify + SQL + answer), so that's ~16-25 questions/day.

**Options:**
- Add $10 credit at https://openrouter.ai/settings/credits (unlocks 1000/day, credit NOT consumed by free models)
- Switch to Groq: `--provider groq --key gsk_xxx`
- Use Ollama locally: `--provider ollama` (unlimited)

### "Error: Ollama is not running"

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model and start
ollama pull llama3.1:8b
ollama serve
```

### Widget not appearing

1. Check the script tag URL is correct and reachable
2. Open browser DevTools > Console for errors
3. Check the health endpoint: `curl http://your-server:3456/chatbot/api/health`

### Widget shows "..." and never responds

1. Check server logs for errors
2. Test the API directly: `curl -N http://localhost:3456/chatbot/api/ask -H "Content-Type: application/json" -d '{"question":"hello"}'`
3. If you see 429 errors, you've hit the rate limit (see above)
4. If you see 401 errors, your secret token isn't matching

### "EADDRINUSE: address already in use"

Another process is using the port. Either kill it or use a different port:

```bash
# Find what's using port 3456
lsof -ti:3456

# Use a different port
npx sql-chatbot-agent --port 4000
```
