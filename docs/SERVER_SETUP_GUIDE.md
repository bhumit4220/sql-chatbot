# sql-chatbot-agent: Complete Server Setup Guide

Step-by-step guide to deploy the AI chatbot on a production server (Ubuntu/Debian). Covers everything from SSH to HTTPS.

---

## Step 1: SSH into Your Server

```bash
ssh your-user@your-server-ip
```

---

## Step 2: Install Node.js (v18+)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should show v20.x
npm -v    # should show 10.x
```

---

## Step 3: Install Nginx

```bash
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

## Step 4: Create a Read-Only Database User

Connect to your PostgreSQL database and create a restricted user:

```sql
-- Connect as superuser
psql -U postgres -d your_database

-- Create read-only user
CREATE USER chatbot_reader WITH PASSWORD 'strong-random-password';

-- Grant read-only access
GRANT CONNECT ON DATABASE your_database TO chatbot_reader;
GRANT USAGE ON SCHEMA public TO chatbot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_reader;

-- Auto-grant SELECT on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO chatbot_reader;
```

### Remote Database (AWS RDS, DigitalOcean, Supabase, etc.)

If your database is on a different server, use the full connection string:

```
postgresql://chatbot_reader:password@db-host.amazonaws.com:5432/your_database?sslmode=require
```

Make sure:
- The database server allows connections from your chatbot server's IP
- SSL is enabled for remote connections (`?sslmode=require`)

---

## Step 5: Get an API Key

Pick one LLM provider:

| Provider | Free Tier | Get Key |
|----------|-----------|---------|
| **OpenRouter** (recommended) | Yes, free models | https://openrouter.ai/keys |
| **Groq** | Yes, rate-limited | https://console.groq.com |
| **OpenAI** | No, paid | https://platform.openai.com/api-keys |
| **Ollama** | Free, self-hosted | No key needed |

---

## Step 6: Install sql-chatbot-agent

### Option A: npm (simplest)

```bash
sudo npm install -g sql-chatbot-agent
```

### Option B: From Git (latest features)

```bash
cd /opt
sudo git clone https://github.com/bhumit4220/sql-chatbot.git sql-chatbot
sudo chown -R $USER:$USER /opt/sql-chatbot
cd /opt/sql-chatbot/packages/agent
npm install
npm run build
```

---

## Step 7: Set Environment Variables

Create an env file:

```bash
sudo mkdir -p /etc/sql-chatbot
sudo nano /etc/sql-chatbot/.env
```

Add your configuration:

```bash
DATABASE_URL="postgresql://chatbot_reader:password@localhost:5432/your_database"
LLM_API_KEY="sk-or-v1-your-openrouter-key"
LLM_PROVIDER="openrouter"
CHATBOT_SECRET="a-long-random-string-for-auth"
PORT=3456
```

Secure the file:

```bash
sudo chmod 600 /etc/sql-chatbot/.env
```

---

## Step 8: Test It Works

Load env vars and start the chatbot:

```bash
# Load env vars
export $(cat /etc/sql-chatbot/.env | xargs)

# If using npm install (Option A):
sql-chatbot-agent --db "$DATABASE_URL" --key "$LLM_API_KEY" --secret "$CHATBOT_SECRET"

# If using git clone (Option B):
node /opt/sql-chatbot/packages/agent/dist/cli.js --db "$DATABASE_URL" --key "$LLM_API_KEY" --secret "$CHATBOT_SECRET"
```

Test from another terminal:

```bash
# Health check
curl http://localhost:3456/chatbot/api/health

# Ask a question
curl -X POST http://localhost:3456/chatbot/api/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret" \
  -d '{"message": "How many users are there?"}'
```

Stop the test server with `Ctrl+C` once confirmed working.

---

## Step 9: Keep It Running with PM2

Install PM2 (process manager):

```bash
sudo npm install -g pm2
```

### If using npm install (Option A):

```bash
# Load env vars and start
export $(cat /etc/sql-chatbot/.env | xargs)

pm2 start sql-chatbot-agent -- \
  --db "$DATABASE_URL" \
  --key "$LLM_API_KEY" \
  --secret "$CHATBOT_SECRET"
```

### If using git clone (Option B):

```bash
export $(cat /etc/sql-chatbot/.env | xargs)

pm2 start /opt/sql-chatbot/packages/agent/dist/cli.js \
  --name sql-chatbot -- \
  --db "$DATABASE_URL" \
  --key "$LLM_API_KEY" \
  --secret "$CHATBOT_SECRET"
```

### The `--code` Flag (Optional)

Point to your project's source code for route detection and code-aware answers:

| Framework | Example `--code` Value |
|-----------|----------------------|
| Express / Node.js | `--code /path/to/project/src` |
| Rails | `--code /path/to/project/app` |
| Django | `--code /path/to/project` |
| Laravel | `--code /path/to/project` |
| Go (Gin/Echo/Fiber) | `--code /path/to/project` |
| Spring Boot | `--code /path/to/project/src` |
| Flask / FastAPI | `--code /path/to/project` |
| Phoenix | `--code /path/to/project/lib` |

### Save PM2 config for auto-restart on reboot:

```bash
pm2 save
pm2 startup
# Run the command it outputs (starts PM2 on boot)
```

### Useful PM2 commands:

```bash
pm2 status          # check if running
pm2 logs sql-chatbot  # view logs
pm2 restart sql-chatbot
pm2 stop sql-chatbot
```

---

## Step 10: Configure Nginx Reverse Proxy

Create an Nginx config:

```bash
sudo nano /etc/nginx/sites-available/chatbot
```

Add:

```nginx
server {
    listen 80;
    server_name chatbot.yourdomain.com;  # or your server IP

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE streaming
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/
sudo nginx -t          # test config
sudo systemctl reload nginx
```

Now the chatbot is accessible at `http://chatbot.yourdomain.com` (or `http://your-server-ip`).

---

## Step 11: Add HTTPS with Let's Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chatbot.yourdomain.com
```

Follow the prompts. Certbot auto-renews certificates. After this, the chatbot is at `https://chatbot.yourdomain.com`.

> **Skip this step** if you're using an IP address without a domain name.

---

## Step 12: Configure Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
```

Port 3456 is NOT exposed — all traffic goes through Nginx.

---

## Step 13: Add the Chat Widget to Your Frontend

Add this script tag to your web app's HTML:

```html
<script
  src="https://chatbot.yourdomain.com/chatbot/widget.js"
  data-secret="your-chatbot-secret"
></script>
```

The widget appears as a floating chat bubble in the bottom-right corner.

---

## Step 14: Verify Everything

```bash
# Check PM2 is running
pm2 status

# Check Nginx is proxying
curl https://chatbot.yourdomain.com/chatbot/api/health

# Check logs for errors
pm2 logs sql-chatbot --lines 20
```

Expected health check response:

```json
{ "status": "ok", "schemaLoaded": true }
```

---

## Multiple Projects on One Server

You only install sql-chatbot-agent **once**. Then repeat Steps 7–13 for each project with a different port, database, and secret.

### What You Do Once (Steps 1–6)

- SSH, install Node.js, install Nginx, install PM2, install sql-chatbot-agent
- These are shared across all projects

### What You Repeat Per Project (Steps 7–13)

- Create env file, start PM2 instance, create Nginx config, add widget to frontend

### Example: 3 Projects

**1. Create separate env files:**

```bash
# /etc/sql-chatbot/ecommerce.env
DATABASE_URL="postgresql://reader:pass@localhost:5432/ecommerce_db"
LLM_API_KEY="sk-or-v1-your-key"
CHATBOT_SECRET="secret-ecommerce"
PORT=3456

# /etc/sql-chatbot/crm.env
DATABASE_URL="postgresql://reader:pass@localhost:5432/crm_db"
LLM_API_KEY="sk-or-v1-your-key"
CHATBOT_SECRET="secret-crm"
PORT=3457

# /etc/sql-chatbot/analytics.env
DATABASE_URL="postgresql://reader:pass@rds.amazonaws.com:5432/analytics_db"
LLM_API_KEY="sk-or-v1-your-key"
CHATBOT_SECRET="secret-analytics"
PORT=3458
```

> You can reuse the same API key across projects, or use different ones.

**2. Start each with PM2 (different name and port):**

```bash
# Project 1: E-commerce
export $(cat /etc/sql-chatbot/ecommerce.env | xargs)
pm2 start sql-chatbot-agent --name chatbot-ecommerce -- \
  --db "$DATABASE_URL" --key "$LLM_API_KEY" --secret "$CHATBOT_SECRET" -p 3456 \
  --code /opt/ecommerce-app/src

# Project 2: CRM
export $(cat /etc/sql-chatbot/crm.env | xargs)
pm2 start sql-chatbot-agent --name chatbot-crm -- \
  --db "$DATABASE_URL" --key "$LLM_API_KEY" --secret "$CHATBOT_SECRET" -p 3457 \
  --code /opt/crm-app/app

# Project 3: Analytics
export $(cat /etc/sql-chatbot/analytics.env | xargs)
pm2 start sql-chatbot-agent --name chatbot-analytics -- \
  --db "$DATABASE_URL" --key "$LLM_API_KEY" --secret "$CHATBOT_SECRET" -p 3458

pm2 save
```

**3. Nginx — one config per project:**

```bash
# /etc/nginx/sites-available/chatbot-ecommerce
server {
    listen 80;
    server_name chatbot-ecommerce.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}

# /etc/nginx/sites-available/chatbot-crm
server {
    listen 80;
    server_name chatbot-crm.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3457;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}

# /etc/nginx/sites-available/chatbot-analytics
server {
    listen 80;
    server_name chatbot-analytics.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3458;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Enable all:

```bash
sudo ln -s /etc/nginx/sites-available/chatbot-ecommerce /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/chatbot-crm /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/chatbot-analytics /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**4. HTTPS for all:**

```bash
sudo certbot --nginx -d chatbot-ecommerce.yourdomain.com
sudo certbot --nginx -d chatbot-crm.yourdomain.com
sudo certbot --nginx -d chatbot-analytics.yourdomain.com
```

**5. Widget in each frontend:**

```html
<!-- E-commerce app -->
<script src="https://chatbot-ecommerce.yourdomain.com/chatbot/widget.js"
  data-secret="secret-ecommerce"></script>

<!-- CRM app -->
<script src="https://chatbot-crm.yourdomain.com/chatbot/widget.js"
  data-secret="secret-crm"></script>

<!-- Analytics app -->
<script src="https://chatbot-analytics.yourdomain.com/chatbot/widget.js"
  data-secret="secret-analytics"></script>
```

**6. Manage all instances:**

```bash
pm2 status                      # see all instances
pm2 logs chatbot-ecommerce      # logs for one project
pm2 restart all                 # restart everything
```

### Quick Summary

| | Install Once | Repeat Per Project |
|-|---|---|
| Node.js | ✅ | |
| Nginx | ✅ | |
| PM2 | ✅ | |
| sql-chatbot-agent | ✅ | |
| Env file | | ✅ (different port, DB, secret) |
| PM2 instance | | ✅ (different name) |
| Nginx config | | ✅ (different subdomain → port) |
| HTTPS certificate | | ✅ (per subdomain) |
| Widget script tag | | ✅ (in each frontend) |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ECONNREFUSED` on health check | PM2 not running — `pm2 restart sql-chatbot` |
| `502 Bad Gateway` from Nginx | Chatbot not running on port 3456 — check `pm2 status` |
| SSL certificate errors | Run `sudo certbot renew --dry-run` |
| Database connection refused | Check `DATABASE_URL`, ensure DB allows connections from this server |
| Rate limited (429 errors) | Switch to a different provider or upgrade your API plan |
| Widget not loading | Check `data-secret` matches `CHATBOT_SECRET`, check browser console |
