# sql-chatbot-agent: Integration & Deployment Guide

How to integrate the AI chatbot into any PostgreSQL web app and keep it running on a server.

> **Note:** All features (schema enrichment, enum introspection, CLI standalone, 17-framework route detection) are available in `sql-chatbot-agent@1.1.2` on npm. The **npm approach** is the simplest way to get started.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Approach 1: npm / npx (Simplest)](#approach-1-npm--npx-simplest)
  - [Approach 2: From Git (Latest Features)](#approach-2-from-git-latest-features)
- [Integration Options](#integration-options)
  - [Option A: Standalone Server (Recommended)](#option-a-standalone-server-recommended)
  - [Option B: Express Middleware](#option-b-express-middleware)
- [Choosing a Provider](#choosing-a-provider)
- [Keeping It Running on a Server](#keeping-it-running-on-a-server)
  - [Option 1: PM2 (Easiest)](#option-1-pm2-easiest)
  - [Option 2: systemd (Native Linux)](#option-2-systemd-native-linux)
  - [Option 3: Docker](#option-3-docker)
- [Nginx Reverse Proxy](#nginx-reverse-proxy)
- [Security Checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 18+** (`node --version`)
- **PostgreSQL** running and accessible
- **Git** (only needed for Approach 2)

```bash
# Verify
node --version        # must be v18+
psql "$DATABASE_URL" -c "SELECT 1"   # database is reachable
```

---

## Installation

### Approach 1: npm / npx (Simplest)

The easiest way. No cloning, no building. Works once the package is published to npm.

**Install globally:**

```bash
npm install -g sql-chatbot-agent
```

**Or run directly with npx (no install):**

```bash
npx sql-chatbot-agent --db "$DATABASE_URL" --code ./src
```

**Or use the init wizard:**

```bash
# Creates a chatbot.config.json in the current directory
npx sql-chatbot-agent init

# Edit chatbot.config.json with your database URL and API key, then:
npx sql-chatbot-agent
```

The `chatbot.config.json` looks like:

```json
{
  "databaseUrl": "postgresql://user:password@localhost:5432/your_database",
  "provider": "openrouter",
  "llmApiKey": "",
  "codePaths": ["./src"],
  "port": 3456,
  "secret": ""
}
```

**Quick one-liners with different providers:**

```bash
# OpenRouter (free, default)
npx sql-chatbot-agent --db postgresql://localhost/mydb --key sk-or-v1-xxx --code ./src

# Groq (free, fast)
npx sql-chatbot-agent --db postgresql://localhost/mydb --provider groq --key gsk_xxx --code ./src

# OpenAI (paid, best quality)
npx sql-chatbot-agent --db postgresql://localhost/mydb --provider openai --key sk-xxx --model gpt-4o-mini --code ./src

# Ollama (free, local, no key)
npx sql-chatbot-agent --db postgresql://localhost/mydb --provider ollama --code ./src
```

> **When to use this:** After the npm package is published with the latest version. Check with `npm view sql-chatbot-agent version`.

---

### Approach 2: From Git (Latest Features)

Use this to get the latest unreleased features from the `v1-development` branch.

```bash
# 1. Clone the repo
git clone https://github.com/bhumit4220/sql-chatbot.git
cd sql-chatbot

# 2. Checkout the development branch
git checkout v1-development

# 3. Install dependencies
npm install

# 4. Build the agent
cd packages/agent
npm run build
```

After this, the CLI entry point is at `packages/agent/dist/cli.js`.

**Run it:**

```bash
node dist/cli.js --db "$DATABASE_URL" --code /path/to/your/project/src
```

> **When to use this:** When you need the latest features not yet on npm, or want to contribute/customize.

---

## Integration Options

### Option A: Standalone Server (Recommended)

Run the chatbot as a separate process alongside your existing app. No code changes needed.

#### Step 1: Get an API Key

| Provider | Free? | Get Key At |
|----------|-------|-----------|
| **OpenRouter** (recommended) | Yes (50 req/day, 1000/day with $10 credit) | https://openrouter.ai/keys |
| **Groq** | Yes (100K tokens/day) | https://console.groq.com |
| **OpenAI** | No (pay-per-use) | https://platform.openai.com |
| **Ollama** | Yes (unlimited, local) | https://ollama.com |

#### Step 2: Set Environment Variables

```bash
# Required -- your PostgreSQL connection
export DATABASE_URL="postgresql://user:password@localhost:5432/your_database"

# Pick ONE provider key:
export OPENROUTER_API_KEY="sk-or-v1-xxx"    # OpenRouter
# OR
export LLM_API_KEY="gsk_xxx"               # Groq
# OR
export LLM_API_KEY="sk-xxx"                # OpenAI
# (Ollama needs no key)

# Recommended for production -- protects the API
export CHATBOT_SECRET="a-long-random-string-here"
```

#### The `--code` Flag: Point to Your Source Code

The `--code` flag tells the chatbot where your source code lives. It's used for:

- **Route detection** — navigation and guidance answers
- **Enum & constant discovery** — model-level enums (Rails `enum`, Django `choices`, TypeORM decorators, etc.) are surfaced as context for accurate SQL generation
- **Business logic context** — calculations, validation rules, and domain logic help the LLM generate better queries

It's **not** limited to `./src` — use whatever directory your framework keeps code in. You can pass multiple `--code` flags.

| Framework | Typical `--code` value |
|-----------|----------------------|
| **Express / React / Next.js / Hono** | `--code ./src` |
| **Rails** | `--code ./app --code ./config` |
| **Django** | `--code ./myapp` (your app directories) |
| **Laravel** | `--code ./app --code ./routes` |
| **Flask / FastAPI** | `--code ./app` or `--code .` |
| **Spring Boot** | `--code ./src/main/java` |
| **Go (Gin / Echo / Fiber)** | `--code ./cmd --code ./internal` |
| **Phoenix / Elixir** | `--code ./lib` |
| **SvelteKit / Nuxt** | `--code ./src` |
| **ASP.NET** | `--code ./Controllers --code ./Program.cs` |
| **Sinatra** | `--code .` |

**Tip:** When in doubt, just point to your project root: `--code /path/to/your/project`. The chatbot automatically skips `node_modules`, `.git`, `dist`, `build`, `vendor`, `target`, `__pycache__`, etc.

#### Step 3: Start the Server

**If installed via npm:**

```bash
# OpenRouter (default, free)
npx sql-chatbot-agent --db "$DATABASE_URL" --code /path/to/your/project/src

# Groq
npx sql-chatbot-agent --db "$DATABASE_URL" --provider groq --code /path/to/your/project/src

# OpenAI (gpt-4o-mini)
npx sql-chatbot-agent --db "$DATABASE_URL" --provider openai --model gpt-4o-mini --code /path/to/your/project/src

# Ollama (local, no key needed)
npx sql-chatbot-agent --db "$DATABASE_URL" --provider ollama --code /path/to/your/project/src

# Custom port + auth
npx sql-chatbot-agent --db "$DATABASE_URL" --code ./src --port 4000 --secret "$CHATBOT_SECRET"
```

**If installed from git:**

```bash
cd /path/to/sql-chatbot/packages/agent

# OpenRouter (default, free)
node dist/cli.js --db "$DATABASE_URL" --code /path/to/your/project/src

# Groq
node dist/cli.js --db "$DATABASE_URL" --provider groq --code /path/to/your/project/src

# OpenAI (gpt-4o-mini)
node dist/cli.js --db "$DATABASE_URL" --provider openai --model gpt-4o-mini --code /path/to/your/project/src

# Ollama (local, no key needed)
node dist/cli.js --db "$DATABASE_URL" --provider ollama --code /path/to/your/project/src

# Custom port + auth
node dist/cli.js --db "$DATABASE_URL" --code ./src --port 4000 --secret "$CHATBOT_SECRET"
```

You should see:

```
SQL Chatbot Agent running at http://localhost:3456
  Provider:     openrouter
  Chat widget:  http://localhost:3456
  Health check: http://localhost:3456/chatbot/api/health
  Auth: enabled
```

#### Step 4: Add Widget to Your Frontend

Add one script tag to your HTML, before `</body>`:

```html
<script src="http://your-server-ip:3456/chatbot/widget.js"></script>
```

If behind a reverse proxy on the same domain:

```html
<script src="/chatbot/widget.js"></script>
```

A chat bubble appears in the bottom-right corner. That's it.

#### Step 5: Verify

```bash
# Health check
curl http://localhost:3456/chatbot/api/health
# Returns: {"status":"ok","tables":25,"codeFiles":150}

# Test a question (no auth)
curl -N http://localhost:3456/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How many users are there?"}'

# Test with auth (if secret is set)
curl -N http://localhost:3456/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-here" \
  -d '{"question":"How many users are there?"}'
```

---

### Option B: Express Middleware

Embed the chatbot directly into your existing Express/Node.js app.

#### Step 1: Install as a Local Dependency

```bash
cd your-project

# Via npm (once published):
npm install sql-chatbot-agent

# Or from local git clone:
npm install /path/to/sql-chatbot/packages/agent
```

#### Step 2: Add to Your App

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
  secret: process.env.CHATBOT_SECRET,         // optional, recommended
}));

// Your other routes...
app.get('/', (req, res) => res.send('My App'));

app.listen(3000);
```

#### Step 3: Add Widget to Your HTML

```html
<script src="/chatbot/widget.js"></script>
```

#### Endpoints Created

| Path | Description |
|------|-------------|
| `GET /chatbot/widget.js` | Chat widget JavaScript bundle |
| `POST /chatbot/api/ask` | Main chat endpoint (SSE streaming) |
| `GET /chatbot/api/health` | Health check (table count, code file count) |
| `POST /chatbot/api/refresh` | Re-discover schema and re-index code |

---

## Choosing a Provider

### OpenRouter (Recommended for Getting Started)

- **Cost:** Free (50 req/day). Add $10 credit for 1000/day -- credit is NOT consumed by free models.
- **Quality:** Routes across multiple free models automatically. Best with `meta-llama/llama-3.3-70b-instruct`.
- **Env var:** `OPENROUTER_API_KEY`

```bash
export OPENROUTER_API_KEY=sk-or-v1-xxx
node dist/cli.js --db "$DATABASE_URL" --code ./src
```

### Groq (Best Free Quality)

- **Cost:** Free (100K tokens/day, ~30-50 chatbot questions)
- **Quality:** High -- uses Llama 3.3 70B with fast inference
- **Env var:** `LLM_API_KEY` or `GROQ_API_KEY`

```bash
export LLM_API_KEY=gsk_xxx
node dist/cli.js --db "$DATABASE_URL" --provider groq --code ./src
```

### OpenAI (Best Quality, Paid)

- **Cost:** ~$0.15 per 1M input tokens, ~$0.60 per 1M output tokens (gpt-4o-mini)
- **Quality:** Highest -- best SQL generation accuracy
- **Env var:** `LLM_API_KEY`

```bash
export LLM_API_KEY=sk-xxx
node dist/cli.js --db "$DATABASE_URL" --provider openai --model gpt-4o-mini --code ./src
```

### Ollama (Best for Production / Unlimited)

- **Cost:** Free, unlimited (uses your server's GPU/CPU)
- **Quality:** Depends on model and hardware
- **Setup:** Install Ollama first

```bash
# Install Ollama on your server
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
ollama serve

# Then run chatbot (no key needed)
node dist/cli.js --db "$DATABASE_URL" --provider ollama --code ./src
```

---

## Keeping It Running on a Server

Running `node dist/cli.js` directly will stop when you close your terminal. Use one of these approaches to keep it running 24/7.

### Option 1: PM2 (Easiest)

PM2 is a Node.js process manager. Easiest to set up, good for most cases.

```bash
# Install PM2 globally (once)
npm install -g pm2
```

**Start the chatbot:**

```bash
# If installed via npm:
pm2 start "npx sql-chatbot-agent --db $DATABASE_URL --code /path/to/your/project/src --secret $CHATBOT_SECRET" --name chatbot

# If installed from git:
pm2 start /path/to/sql-chatbot/packages/agent/dist/cli.js \
  --name chatbot \
  -- --db "$DATABASE_URL" --code /path/to/your/project/src --secret "$CHATBOT_SECRET"
```

**Make it survive reboots:**

```bash
pm2 save          # saves current process list
pm2 startup       # generates startup script (follow the command it prints)
```

**Useful PM2 commands:**

```bash
pm2 status              # see all running processes
pm2 logs chatbot        # view chatbot logs (live tail)
pm2 logs chatbot --lines 100   # last 100 lines
pm2 restart chatbot     # restart the chatbot
pm2 stop chatbot        # stop it
pm2 delete chatbot      # remove from PM2
pm2 monit               # real-time CPU/memory dashboard
```

**Update after a git pull:**

```bash
cd /path/to/sql-chatbot/packages/agent
git pull origin v1-development
npm run build
pm2 restart chatbot
```

---

### Option 2: systemd (Native Linux)

No extra installs needed -- built into every Linux server. More "proper" for production.

**Create the service file:**

```bash
sudo nano /etc/systemd/system/sql-chatbot.service
```

Paste this (edit the paths and credentials):

```ini
[Unit]
Description=SQL Chatbot Agent
After=network.target postgresql.service

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/sql-chatbot/packages/agent

# Environment variables
Environment=DATABASE_URL=postgresql://user:password@localhost:5432/your_database
Environment=OPENROUTER_API_KEY=sk-or-v1-xxx
Environment=CHATBOT_SECRET=your-secret-here

# The command to run
# If installed via npm:
#   ExecStart=/usr/bin/npx sql-chatbot-agent --db postgresql://user:password@localhost:5432/your_database --code /path/to/your/project/src --secret your-secret-here
# If installed from git:
ExecStart=/usr/bin/node dist/cli.js --db postgresql://user:password@localhost:5432/your_database --code /path/to/your/project/src --secret your-secret-here

# Auto-restart on crash
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Enable and start:**

```bash
# Reload systemd (after creating/editing the service file)
sudo systemctl daemon-reload

# Enable (start on boot)
sudo systemctl enable sql-chatbot

# Start now
sudo systemctl start sql-chatbot

# Check status
sudo systemctl status sql-chatbot
```

**Useful systemd commands:**

```bash
sudo systemctl status sql-chatbot       # is it running?
sudo systemctl restart sql-chatbot      # restart
sudo systemctl stop sql-chatbot         # stop
sudo journalctl -u sql-chatbot -f       # view logs (live tail)
sudo journalctl -u sql-chatbot --since "1 hour ago"   # recent logs
```

**Update after a git pull:**

```bash
cd /path/to/sql-chatbot/packages/agent
git pull origin v1-development
npm run build
sudo systemctl restart sql-chatbot
```

---

### Option 3: Docker

Best for isolated, reproducible deployments.

**Dockerfile (npm approach — use once published):**

```dockerfile
FROM node:20-slim
RUN npm install -g sql-chatbot-agent
WORKDIR /app
COPY ./src ./src
EXPOSE 3456
CMD ["sql-chatbot-agent", "--code", "./src"]
```

**Dockerfile (git approach — use for latest features):**

```dockerfile
FROM node:20-slim

# Clone and build the chatbot
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/bhumit4220/sql-chatbot.git /opt/sql-chatbot
WORKDIR /opt/sql-chatbot
RUN git checkout v1-development
RUN npm install
WORKDIR /opt/sql-chatbot/packages/agent
RUN npm run build

# Copy your source code for route detection
WORKDIR /app
COPY ./src ./src

EXPOSE 3456

CMD ["node", "/opt/sql-chatbot/packages/agent/dist/cli.js", "--code", "./src"]
```

**Build and run:**

```bash
docker build -t sql-chatbot .

docker run -d \
  --name chatbot \
  --restart always \
  -e DATABASE_URL="postgresql://user:pass@host.docker.internal:5432/mydb" \
  -e OPENROUTER_API_KEY="sk-or-v1-xxx" \
  -e CHATBOT_SECRET="your-secret" \
  -p 3456:3456 \
  sql-chatbot
```

**With docker-compose:**

```yaml
# docker-compose.yml
services:
  chatbot:
    build: .
    restart: always
    ports:
      - "3456:3456"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/mydb
      - OPENROUTER_API_KEY=sk-or-v1-xxx
      - CHATBOT_SECRET=your-secret
    depends_on:
      - db
```

**Useful Docker commands:**

```bash
docker logs chatbot -f          # view logs
docker restart chatbot          # restart
docker stop chatbot             # stop
docker rm chatbot               # remove container
```

---

## Nginx Reverse Proxy

Serve the chatbot on the same domain as your app (recommended for production).

Add this to your Nginx server block:

```nginx
location /chatbot/ {
    proxy_pass http://127.0.0.1:3456/chatbot/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection '';
    proxy_buffering off;           # REQUIRED for SSE streaming
    proxy_cache off;
    proxy_read_timeout 300s;       # LLM responses can be slow
}
```

Then reload Nginx:

```bash
sudo nginx -t              # test config
sudo systemctl reload nginx
```

Your widget tag becomes:

```html
<script src="/chatbot/widget.js"></script>
```

---

## Database Best Practices

### Create a Read-Only Database User

**Never use your application's main database user for the chatbot.** Create a dedicated read-only user instead. This is defense-in-depth — even though the chatbot already enforces `READ ONLY` transactions and blocks destructive SQL, a restricted DB user adds another layer of protection.

**PostgreSQL:**

```sql
-- Connect as superuser/admin
psql -U postgres -d your_database

-- 1. Create the chatbot user
CREATE USER chatbot_reader WITH PASSWORD 'a-strong-password-here';

-- 2. Grant connect access
GRANT CONNECT ON DATABASE your_database TO chatbot_reader;

-- 3. Grant read-only access to all existing tables
GRANT USAGE ON SCHEMA public TO chatbot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_reader;

-- 4. Auto-grant SELECT on any future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO chatbot_reader;

-- 5. (Optional) Revoke access to specific sensitive tables
REVOKE SELECT ON sensitive_table FROM chatbot_reader;
```

Then use this user in your DATABASE_URL:

```bash
export DATABASE_URL="postgresql://chatbot_reader:a-strong-password-here@your-db-host:5432/your_database"
```

### Remote Database Connections

The database doesn't need to be on the same server as the chatbot. Just use the remote host in the URL:

```bash
# AWS RDS
export DATABASE_URL="postgresql://chatbot_reader:pass@mydb.abc123.us-east-1.rds.amazonaws.com:5432/mydb"

# DigitalOcean Managed DB
export DATABASE_URL="postgresql://chatbot_reader:pass@db-pool.ondigitalocean.com:25060/mydb?sslmode=require"

# Supabase
export DATABASE_URL="postgresql://chatbot_reader:pass@db.abcdefg.supabase.co:5432/postgres"

# Any remote server
export DATABASE_URL="postgresql://chatbot_reader:pass@203.0.113.50:5432/mydb"
```

**Requirements for remote DB:**
- The chatbot server can reach the DB host (check firewall/security groups)
- The DB user has `SELECT` permission
- If the DB requires SSL, add `?sslmode=require` to the URL

### Connection Security Tips

- **Use SSL** for remote connections: add `?sslmode=require` to your DATABASE_URL
- **Whitelist IPs** in your DB's firewall/security group — only allow the chatbot server's IP
- **Don't expose the DB publicly** — use private networking between your app server and DB if possible (e.g., VPC on AWS, private network on DigitalOcean)
- **Rotate passwords** periodically for the chatbot DB user

---

## Security Checklist

- [ ] **Create a read-only DB user** -- never use your app's main DB credentials (see [Database Best Practices](#database-best-practices) above)
- [ ] **Set a secret token** -- `--secret` flag or `CHATBOT_SECRET` env var. Without it, anyone can query your database through the chatbot.
- [ ] **Never hardcode API keys** in source code. Always use environment variables.
- [ ] **Use HTTPS** in production (via Nginx/Caddy with Let's Encrypt).
- [ ] **Use SSL for DB connections** -- add `?sslmode=require` to DATABASE_URL for remote databases.
- [ ] **Whitelist DB access** -- only allow the chatbot server's IP in your DB firewall/security groups.
- [ ] **SQL is read-only** -- all queries run inside `SET TRANSACTION READ ONLY`. Destructive keywords (`DROP`, `DELETE`, etc.) are blocked at the application level.
- [ ] **Sensitive columns are hidden** -- columns matching patterns like `password`, `secret`, `api_key`, `ssn` are automatically excluded from the schema sent to the LLM.
- [ ] **Restrict network access** -- don't expose port 3456 publicly. Use Nginx reverse proxy instead.
- [ ] **Keep it updated** -- `npm install -g sql-chatbot-agent@latest` or `git pull` to get security fixes.

---

## Troubleshooting

### "Error: API key is required"

You need to provide an API key. Set one of:
- `OPENROUTER_API_KEY` (get free at https://openrouter.ai/keys)
- `LLM_API_KEY` or `GROQ_API_KEY`
- Use `--key sk-xxx` flag directly
- Or use `--provider ollama` (no key needed, but requires Ollama running locally)

### "429 Rate limit exceeded"

OpenRouter free tier is 50 requests/day without credits. Each chatbot question uses 2-3 API calls, so ~16-25 questions/day.

**Options:**
- Add $10 credit at https://openrouter.ai/settings/credits (unlocks 1000/day, credit NOT consumed by free models)
- Switch to Groq: `--provider groq`
- Use Ollama locally: `--provider ollama` (unlimited)

### "ECONNREFUSED" or database connection errors

- Verify your DATABASE_URL is correct
- Check PostgreSQL is running: `sudo systemctl status postgresql`
- If using Docker, use `host.docker.internal` instead of `localhost`

### Widget not appearing

1. Check the script tag URL is correct and reachable from the browser
2. Open browser DevTools > Console for errors
3. Check the health endpoint: `curl http://your-server:3456/chatbot/api/health`
4. If behind Nginx, make sure `proxy_buffering off` is set

### Widget shows "..." and never responds

1. Check server logs (`pm2 logs chatbot` or `journalctl -u sql-chatbot -f`)
2. Test the API directly: `curl -N http://localhost:3456/chatbot/api/ask -H "Content-Type: application/json" -d '{"question":"hello"}'`
3. If 429 errors: rate limit (see above)
4. If 401 errors: secret token mismatch

### "EADDRINUSE: address already in use"

Another process is using the port:

```bash
# Find what's using port 3456
lsof -ti:3456

# Kill it
kill $(lsof -ti:3456)

# Or use a different port
node dist/cli.js --port 4000
```

### Updating to a new version

**If installed via npm:**

```bash
npm install -g sql-chatbot-agent@latest

# Then restart:
pm2 restart chatbot                     # if using PM2
sudo systemctl restart sql-chatbot      # if using systemd
docker rebuild & restart                # if using Docker
```

**If installed from git:**

```bash
cd /path/to/sql-chatbot
git pull origin v1-development
cd packages/agent
npm run build

# Then restart:
pm2 restart chatbot                     # if using PM2
sudo systemctl restart sql-chatbot      # if using systemd
docker restart chatbot                  # if using Docker
```
