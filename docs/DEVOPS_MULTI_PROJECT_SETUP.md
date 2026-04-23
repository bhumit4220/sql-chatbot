# SQL Chatbot — Multi-Project Setup Guide (dev1.spaceo.in)

> **For:** DevOps engineers setting up multiple chatbot instances on the same server.

---

## Overview

All projects on the same server share:
- One `.env` file at `/etc/sql-chatbot/.env`
- One `start-all.sh` script at `/etc/sql-chatbot/start-all.sh`

Each project runs as a separate PM2 process on its own port.

---

## Step 1: Create the env file

```bash
sudo mkdir -p /etc/sql-chatbot
sudo nano /etc/sql-chatbot/.env
```

```
https://dev2.spaceo.in/sql-chatbot-cartaman-qa/
https://dev1.spaceo.in/sql-chatbot-english-learning-qa/
https://dev1.spaceo.in/sql-chatbot-zendy-qa/
https://dev1.spaceo.in/sql-chatbot-zendy-merchant-qa/
https://dev1.spaceo.in/sql-chatbot-mombucks-qa/
https://dev1.spaceo.in/sql-chatbot-garbago-qa/
```

Add:

```bash
# Shared — same for all projects
LLM_API_KEY="your-api-key"
LLM_PROVIDER="openai"
LLM_MODEL="gpt-4o-mini"

# Gym App / Cardano
GYMAPP_DB="postgresql://chatbot_reader:PASSWORD@localhost:5432/gymapp_qa"
GYMAPP_SECRET="your-secret"
GYMAPP_PORT=3456

# Zendy
ZENDY_DB="postgresql://chatbot_reader:PASSWORD@localhost:5432/zendy_qa"
ZENDY_SECRET="your-secret"
ZENDY_PORT=3457

# Mom Bucks
MOMBUCKS_DB="postgresql://chatbot_reader:PASSWORD@localhost:5432/mombucks_qa"
MOMBUCKS_SECRET="your-secret"
MOMBUCKS_PORT=3458

# Garbago
GARBAGO_DB="postgresql://chatbot_reader:PASSWORD@localhost:5432/garbago_qa"
GARBAGO_SECRET="your-secret"
GARBAGO_PORT=3460

# English Learning
ENGLISH_DB="postgresql://chatbot_reader:PASSWORD@localhost:5432/english_qa"
ENGLISH_SECRET="your-secret"
ENGLISH_PORT=3459
```

> To generate a random secret: `openssl rand -hex 32`

---

## Step 2: Create the start-all script

```bash
sudo nano /etc/sql-chatbot/start-all.sh
```

Add:

```bash
#!/bin/bash
source /etc/sql-chatbot/.env

pm2 start "sql-chatbot-agent \
  --db $GYMAPP_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $GYMAPP_SECRET \
  --port $GYMAPP_PORT \
  --code /path/to/gymapp-backend/src \
  --code /path/to/gymapp-frontend/src" \
  --name chatbot-gymapp

pm2 start "sql-chatbot-agent \
  --db $ZENDY_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $ZENDY_SECRET \
  --port $ZENDY_PORT \
  --code /path/to/zendy-backend/src \
  --code /path/to/zendy-frontend/src" \
  --name chatbot-zendy

pm2 start "sql-chatbot-agent \
  --db $MOMBUCKS_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $MOMBUCKS_SECRET \
  --port $MOMBUCKS_PORT \
  --code /path/to/mombucks-backend/src \
  --code /path/to/mombucks-frontend/src" \
  --name chatbot-mombucks

pm2 start "sql-chatbot-agent \
  --db $GARBAGO_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $GARBAGO_SECRET \
  --port $GARBAGO_PORT \
  --code /path/to/garbago-backend/src \
  --code /path/to/garbago-frontend/src" \
  --name chatbot-garbago

pm2 start "sql-chatbot-agent \
  --db $ENGLISH_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $ENGLISH_SECRET \
  --port $ENGLISH_PORT \
  --code /path/to/english-learning-backend/src \
  --code /path/to/english-learning-frontend/src" \
  --name chatbot-english

pm2 save
```

> Replace each `/path/to/PROJECT-backend/src` and `/path/to/PROJECT-frontend/src` with the actual paths on your server. See the **Code Paths by Framework** section below for which folders to point `--code` at.

Make it executable:

```bash
sudo chmod +x /etc/sql-chatbot/start-all.sh
```

---

## Step 3: Run it

```bash
bash /etc/sql-chatbot/start-all.sh
```

Check all processes are running:

```bash
pm2 status
```

---

## Step 4: Survive reboots

```bash
pm2 startup   # follow the command it prints
pm2 save
```

---

## Adding a new project later

1. Add its variables to `/etc/sql-chatbot/.env`
2. Run its `pm2 start` command directly (no need to re-run start-all.sh):

```bash
source /etc/sql-chatbot/.env

pm2 start "sql-chatbot-agent \
  --db $NEWPROJECT_DB \
  --key $LLM_API_KEY \
  --provider $LLM_PROVIDER \
  --model $LLM_MODEL \
  --secret $NEWPROJECT_SECRET \
  --port NEW_PORT \
  --code /path/to/newproject-backend/src \
  --code /path/to/newproject-frontend/src" \
  --name chatbot-newproject

pm2 save
```

---

## Useful PM2 Commands

```bash
pm2 status                          # see all running processes
pm2 logs chatbot-zendy              # live logs
pm2 restart chatbot-zendy           # restart one project
pm2 restart all                     # restart all
pm2 stop chatbot-zendy              # stop one project
pm2 delete chatbot-zendy            # remove from PM2
```

---

## Code Paths by Framework

The `--code` flag should point to the folders where your app's source code lives. This depends on the framework:

### Backend

| Framework | Language | `--code` path(s) |
|-----------|----------|-------------------|
| **Rails** | Ruby | `--code /path/to/project/app` |
| **Laravel** | PHP | `--code /path/to/project/app --code /path/to/project/routes` |
| **Django** | Python | `--code /path/to/project` (root, it scans `.py` files) |
| **Express / NestJS** | Node.js | `--code /path/to/project/src` |
| **Spring Boot** | Java/Kotlin | `--code /path/to/project/src/main/java` |
| **ASP.NET** | C# | `--code /path/to/project/Controllers --code /path/to/project/Models` |
| **Phoenix** | Elixir | `--code /path/to/project/lib` |
| **Gin / Echo** | Go | `--code /path/to/project` (root, it scans `.go` files) |

### Frontend

| Framework | `--code` path |
|-----------|---------------|
| **React / Next.js** | `--code /path/to/project/src` |
| **Vue / Nuxt** | `--code /path/to/project/src` |
| **Angular** | `--code /path/to/project/src/app` |
| **Svelte / SvelteKit** | `--code /path/to/project/src` |

### Example: Rails backend + React frontend

```bash
pm2 start "sql-chatbot-agent \
  --db $ZENDY_DB \
  --key $LLM_API_KEY \
  --secret $ZENDY_SECRET \
  --port $ZENDY_PORT \
  --code /var/www/html/zendy-api/app \
  --code /var/www/html/zendy-admin/src" \
  --name chatbot-zendy
```

> **Tip:** When in doubt, point `--code` at the project root. The chatbot only scans supported file extensions (`.rb`, `.py`, `.js`, `.ts`, `.php`, `.java`, `.go`, `.kt`, `.rs`, `.dart`, `.scala`, `.cs`, `.ex`, `.vue`, `.svelte`, `.jsx`, `.tsx`, `.erb`) and ignores everything else.

---

## Update to a new version

```bash
npm install -g sql-chatbot-agent@latest
pm2 restart all
```
