# SQL Chatbot Agent — DevOps Setup Guide

> **For:** DevOps engineers setting up the chatbot on dev servers.
> **Package:** `sql-chatbot-agent` on npm

---

## Overview

Each project gets its own chatbot process on a unique port, exposed via Apache reverse proxy over HTTPS.

| Project | Server | Port | Apache Path |
|---------|--------|------|------------|
| Cartaman (Abbas) | dev2.spaceo.in | 3456 | `/sql-chatbot-cartaman-qa/` |
| English Learning (Abbas) | dev1.spaceo.in | 3456 | `/sql-chatbot-english-learning-qa/` |
| Zendy Admin + Merchant (Gabrina) | dev1.spaceo.in | 3457 | `/sql-chatbot-zendy-qa/` |
| Mom Bucks (Krupa) | dev1.spaceo.in | 3458 | `/sql-chatbot-mombucks-qa/` |
| Gym App / Cardano (Krupa) | dev1.spaceo.in | 3459 | `/sql-chatbot-qa/` |
| Garbago (Rohit) | dev1.spaceo.in | 3460 | `/sql-chatbot-garbago-qa/` |

---

## One-Time Setup (Per Server)

Run these once on each server.

### 1. Install Node.js 18+ (if not already installed)

```bash
node --version   # must be v18+
```

If not installed:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install the chatbot package globally

```bash
npm install -g sql-chatbot-agent
```

### 3. Install PM2 globally

```bash
npm install -g pm2
```

### 4. Set environment variables

There are two types of env vars:
- **Shared** — same value for all projects on the server (API key)
- **Per-project** — different for each project (DB URL, secret, port)

#### Shared (set once per server)

Add to `~/.bashrc`:

```bash
# OpenRouter API key — shared across all projects (get free key at https://openrouter.ai/keys)
export OPENROUTER_API_KEY="sk-or-v1-xxx"
```

Then reload:
```bash
source ~/.bashrc
```

#### Per-project (set separately for each project)

Add all project-specific vars to `~/.bashrc` at once:

**dev1.spaceo.in:**
```bash
# English Learning
export CHATBOT_DB_ENGLISH_LEARNING="postgresql://chatbot_reader:PASSWORD@localhost:5432/english_learning_db"
export CHATBOT_SECRET_ENGLISH_LEARNING="generate-a-random-secret"

# Zendy
export CHATBOT_DB_ZENDY="postgresql://chatbot_reader:PASSWORD@localhost:5432/zendy_db"
export CHATBOT_SECRET_ZENDY="generate-a-random-secret"

# Mom Bucks
export CHATBOT_DB_MOMBUCKS="postgresql://chatbot_reader:PASSWORD@localhost:5432/mombucks_db"
export CHATBOT_SECRET_MOMBUCKS="generate-a-random-secret"

# Gym App / Cardano
export CHATBOT_DB_GYMAPP="postgresql://chatbot_reader:PASSWORD@localhost:5432/gymapp_db"
export CHATBOT_SECRET_GYMAPP="generate-a-random-secret"

# Garbago
export CHATBOT_DB_GARBAGO="postgresql://chatbot_reader:PASSWORD@localhost:5432/garbago_db"
export CHATBOT_SECRET_GARBAGO="generate-a-random-secret"
```

**dev2.spaceo.in:**
```bash
# Cartaman
export CHATBOT_DB_CARTAMAN="postgresql://chatbot_reader:PASSWORD@localhost:5432/cartaman_db"
export CHATBOT_SECRET_CARTAMAN="generate-a-random-secret"
```

Then reload:
```bash
source ~/.bashrc
```

Verify:
```bash
echo $OPENROUTER_API_KEY       # shared key
echo $CHATBOT_DB_ZENDY         # zendy db url
echo $CHATBOT_SECRET_ZENDY     # zendy secret
```

> To generate a random secret: `openssl rand -hex 32`

### 5. Enable Apache proxy modules (if not already enabled)

```bash
sudo a2enmod proxy proxy_http
sudo systemctl restart apache2
```

---

## Per-Project Setup

Repeat these steps for each project.

### Step 1: Create a read-only database user

Connect to that project's PostgreSQL database as superuser:

```sql
-- Replace 'project_db' with the actual database name
CREATE USER chatbot_reader WITH PASSWORD 'choose-a-strong-password';
GRANT CONNECT ON DATABASE project_db TO chatbot_reader;
GRANT USAGE ON SCHEMA public TO chatbot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO chatbot_reader;
```

### Step 2: Test the database connection

```bash
psql "postgresql://chatbot_reader:PASSWORD@localhost:5432/project_db" -c "SELECT 1"
# Should return: 1
```

### Step 3: Start the chatbot with PM2

```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_PROJECTNAME \
  --code /path/to/project/app \
  --code /path/to/project/frontend/src \
  --port PORT \
  --secret $CHATBOT_SECRET_PROJECTNAME" \
  --name chatbot-PROJECT_NAME
```

See project-specific commands below.

### Step 4: Add Apache config

Add a `Location` block inside your project's `VirtualHost` in Apache (see project-specific config below).

### Step 5: Save PM2 config

```bash
pm2 save
pm2 startup   # follow the command it prints to survive reboots
```

---

## Project-Specific Commands

---

### dev2.spaceo.in — Cartaman (Abbas)

**PM2:**
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_CARTAMAN \
  --code /path/to/cartaman/app \
  --code /path/to/cartaman/frontend/src \
  --port 3456 \
  --secret $CHATBOT_SECRET_CARTAMAN" \
  --name chatbot-cartaman
```

**Apache** (add inside dev2.spaceo.in VirtualHost):
```apache
<Location /sql-chatbot-cartaman-qa/>
    ProxyPass http://127.0.0.1:3456/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3456/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3456/chatbot/api/health
```

---

### dev1.spaceo.in — English Learning (Abbas)

**PM2:**
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_ENGLISH_LEARNING \
  --code /path/to/english-learning/app \
  --code /path/to/english-learning/frontend/src \
  --port 3456 \
  --secret $CHATBOT_SECRET_ENGLISH_LEARNING" \
  --name chatbot-english-learning
```

**Apache** (add inside dev1.spaceo.in VirtualHost):
```apache
<Location /sql-chatbot-english-learning-qa/>
    ProxyPass http://127.0.0.1:3456/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3456/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3456/chatbot/api/health
```

---

### dev1.spaceo.in — Zendy (Gabrina)

> Admin Panel and Merchant Panel share the same database → one chatbot process for both.

**PM2:**
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_ZENDY \
  --code /path/to/zendy/app \
  --code /path/to/zendy/frontend/src \
  --port 3457 \
  --secret $CHATBOT_SECRET_ZENDY" \
  --name chatbot-zendy
```

**Apache** (add inside dev1.spaceo.in VirtualHost):
```apache
<Location /sql-chatbot-zendy-qa/>
    ProxyPass http://127.0.0.1:3457/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3457/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3457/chatbot/api/health
```

---

### dev1.spaceo.in — Mom Bucks (Krupa)

**PM2:**
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_MOMBUCKS \
  --code /path/to/mombucks/app \
  --code /path/to/mombucks/frontend/src \
  --port 3458 \
  --secret $CHATBOT_SECRET_MOMBUCKS" \
  --name chatbot-mombucks
```

**Apache** (add inside dev1.spaceo.in VirtualHost):
```apache
<Location /sql-chatbot-mombucks-qa/>
    ProxyPass http://127.0.0.1:3458/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3458/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3458/chatbot/api/health
```

---

### dev1.spaceo.in — Gym App / Cardano (Krupa)

> Already configured. Apache path: `/sql-chatbot-qa/`, Port: `3459`

**PM2** (if not already running):
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_GYMAPP \
  --code /path/to/gymapp/app \
  --code /path/to/gymapp/frontend/src \
  --port 3459 \
  --secret $CHATBOT_SECRET_GYMAPP" \
  --name chatbot-gymapp
```

**Apache** (already configured — reference only):
```apache
<Location /sql-chatbot-qa/>
    ProxyPass http://127.0.0.1:3459/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3459/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3459/chatbot/api/health
```

---

### dev1.spaceo.in — Garbago (Rohit)

**PM2:**
```bash
pm2 start "sql-chatbot-agent \
  --db $CHATBOT_DB_GARBAGO \
  --code /path/to/garbago/app \
  --code /path/to/garbago/frontend/src \
  --port 3460 \
  --secret $CHATBOT_SECRET_GARBAGO" \
  --name chatbot-garbago
```

**Apache** (add inside dev1.spaceo.in VirtualHost):
```apache
<Location /sql-chatbot-garbago-qa/>
    ProxyPass http://127.0.0.1:3460/chatbot/ flushpackets=on
    ProxyPassReverse http://127.0.0.1:3460/chatbot/
</Location>
```

**Verify:**
```bash
curl http://localhost:3460/chatbot/api/health
```

---

## After Adding Apache Config

Always test and reload Apache after editing:

```bash
sudo apache2ctl configtest    # test config — must say "Syntax OK"
sudo systemctl reload apache2
```

---

## Update to a New Version

```bash
# Update the package
npm install -g sql-chatbot-agent@latest

# Restart all chatbot processes
pm2 restart all

# Or restart one specific project
pm2 restart chatbot-zendy
```

---

## Useful PM2 Commands

```bash
pm2 status                              # see all running processes
pm2 logs chatbot-zendy                  # view logs (live)
pm2 logs chatbot-zendy --lines 100      # last 100 lines
pm2 restart chatbot-zendy               # restart one project
pm2 stop chatbot-zendy                  # stop one project
pm2 delete chatbot-zendy                # remove from PM2
pm2 monit                               # real-time dashboard
```

---

## Troubleshooting

### "Error: API key is required"
Make sure `OPENROUTER_API_KEY` is set in `~/.bashrc` and sourced:
```bash
echo $OPENROUTER_API_KEY   # should print the key, not blank
source ~/.bashrc
pm2 restart all
```

### "ECONNREFUSED" — database connection failed
- Check the database URL is correct
- Check PostgreSQL is running: `sudo systemctl status postgresql`
- Check `chatbot_reader` user has access

### Port already in use
```bash
lsof -ti:3457
kill $(lsof -ti:3457)
pm2 restart chatbot-zendy
```

### SSE streaming not working (widget shows "..." forever)
Make sure `flushpackets=on` is in your Apache `ProxyPass` directive. This is required for Server-Sent Events (SSE) to work through Apache.

### Test API directly
```bash
curl -N http://localhost:3457/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ZENDY_SECRET" \
  -d '{"question":"How many users are there?"}'
```
