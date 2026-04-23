# SQL Chatbot — Distributed Architecture Plan

## Problem

The current chatbot (npm middleware + Rails gem) only works when frontend and backend are on the **same server**. In modern distributed setups (React on Vercel/S3 + Rails API on Heroku/EC2), it breaks because:

- Session cookies are blocked cross-origin (Safari ITP, Firefox ETP)
- CORS with credentials requires `SameSite=None` (broken in Safari)
- `Origin` header can be faked from curl/Postman
- No way to auto-discover backend URL from the frontend

## Solution: Same-Origin Token Proxy

**Principle:** Token requests are always same-origin. Cross-origin API calls use Bearer tokens, never cookies.

### Architecture

```
SAME-SERVER SETUP (zero config):
┌─────────────────────────────────────────┐
│  Rails/Express App (one server)         │
│  ├── Frontend (views/SPA)              │
│  ├── API                                │
│  └── Chatbot (gem/middleware)           │
│      ├── /chatbot/widget.js            │
│      ├── /chatbot/api/session  ← same-origin, session cookie works │
│      └── /chatbot/api/ask              │
└─────────────────────────────────────────┘
Widget loads from same origin → session cookie sent → token issued → done.


DISTRIBUTED SETUP (1 config line + 1 helper file):
┌──────────────────────┐         ┌──────────────────────┐
│  Frontend Server     │         │  Backend Server      │
│  (Vercel/Netlify/S3) │         │  (Heroku/EC2/K8s)    │
│                      │         │                      │
│  React/Vue/Angular   │         │  Rails API           │
│  + Widget loaded     │         │  + Chatbot gem       │
│                      │         │                      │
│  /api/chatbot-token  │────────>│  /chatbot/api/session│
│  (same-origin proxy) │  JWT    │  /chatbot/api/ask    │
└──────────┬───────────┘         └──────────────────────┘
           │
    Browser calls /api/chatbot-token
    (same-origin → session cookie works in ALL browsers)
    Gets JWT → uses it for cross-origin /chatbot/api/ask calls
```

### Auth Flow (Distributed)

```
1. User logs into the admin panel normally
   → Session cookie set (same-origin, works everywhere)

2. Widget loads, detects cross-origin
   → Calls data-token-url (same-origin to frontend server)

3. Frontend server proxies to backend with user's auth
   → GET /api/chatbot-token (same-origin, cookie sent)
   → Frontend server calls backend: POST /chatbot/api/session

4. Backend verifies the user's identity
   → Issues JWT (15 min lifetime, signed with shared secret)

5. Widget stores JWT in memory
   → All chatbot API calls use: Authorization: Bearer <jwt>
   → No cookies cross-origin. Works in Safari, Firefox, everywhere.

6. At 12 min mark, widget silently refreshes the token

7. User closes tab → token dies (only in memory, not persisted)
```

### Security Model

```
NOT logged in   → no session → no token → BLOCKED
Curl (no auth)  → no session → no token → BLOCKED
Curl (fake Origin) → no session → no token → BLOCKED
Logged-in admin → valid session → gets token → ALLOWED (they already have data access)
Token from Network tab → same user, same access → NOT A NEW THREAT
Token expires   → 15 min → must re-authenticate
```

---

## What We're Building

### Component 1: Backend Token Endpoint (in gem/middleware)

**Purpose:** Issue JWT tokens to authenticated users.

**Endpoint:** `POST /chatbot/api/session`

**Behavior:**
- Same-origin request with valid session → issue JWT
- Cross-origin request with valid `Authorization` header from frontend proxy → issue JWT
- No auth → 401 Unauthorized
- Origin not in `allowed_origins` (production) → 403 Forbidden
- Development mode → auto-allow localhost:*

**JWT payload:**
```json
{
  "sub": "user_123",        // user identifier (optional, from session)
  "iat": 1711929600,        // issued at
  "exp": 1711930500,        // expires in 15 min
  "origin": "https://admin.myapp.com"  // requesting origin
}
```

**JWT signed with:** auto-generated secret stored in Rails credentials / .env

### Component 2: Widget Cross-Origin Support

**Purpose:** Auto-detect same-origin vs cross-origin and handle auth accordingly.

**Detection logic:**
```
script_origin = new URL(document.currentScript.src).origin
page_origin = window.location.origin

if (script_origin === page_origin) {
  // Same-origin: use relative paths, no token needed
  // Existing behavior, session cookies work
} else {
  // Cross-origin: use data-token-url to get JWT
  // All API calls use Authorization: Bearer header
}
```

**Attributes:**
```html
<!-- Same-origin: zero config -->
<script src="/chatbot/widget.js"></script>

<!-- Cross-origin: one attribute -->
<script src="https://backend.com/chatbot/widget.js"
        data-token-url="/api/chatbot-token"></script>
```

**Token lifecycle in widget:**
- On mount → call `data-token-url` → store token in memory
- On each API call → attach `Authorization: Bearer <token>` header
- At 80% lifetime (12 min) → silently call `data-token-url` again
- On token refresh failure → show "Reconnecting..." in widget
- On tab close → token gone (memory only)

### Component 3: Frontend Token Proxy Helpers

**Purpose:** One-file helpers the developer drops into their frontend to proxy token requests.

**Next.js (App Router):**
```js
// app/api/chatbot-token/route.js
import { chatbotTokenProxy } from 'sql-chatbot-widget/next';
export const GET = chatbotTokenProxy({
  backendUrl: process.env.CHATBOT_BACKEND_URL  // e.g. https://api.myapp.com/chatbot
});
```

**Nuxt:**
```js
// server/api/chatbot-token.js
import { chatbotTokenProxy } from 'sql-chatbot-widget/nuxt';
export default chatbotTokenProxy({
  backendUrl: process.env.CHATBOT_BACKEND_URL
});
```

**Express BFF:**
```js
import { chatbotTokenProxy } from 'sql-chatbot-widget/express';
app.get('/api/chatbot-token', chatbotTokenProxy({
  backendUrl: process.env.CHATBOT_BACKEND_URL
}));
```

**Generic (any server):**
```
GET /api/chatbot-token
→ Forward to: POST {CHATBOT_BACKEND_URL}/api/session
→ Pass through: Authorization header from the original request
→ Return: { token, expires_in }
```

### Component 4: Backend CORS Auto-Configuration

**Purpose:** Auto-handle CORS for cross-origin API calls (the ones using Bearer token).

**Behavior:**
- Read `allowed_origins` from config
- In development: auto-allow `localhost:*`
- In production: require explicit `allowed_origins`
- Dynamically set `Access-Control-Allow-Origin` to the requesting origin (if allowed)
- Set `Access-Control-Allow-Headers: Authorization, Content-Type`
- Handle OPTIONS preflight automatically
- NO `Access-Control-Allow-Credentials` needed (we use Bearer, not cookies)

### Component 5: Frontend Code Indexing

**Purpose:** Let the backend know about frontend routes/pages even when on a different server.

**Approach 1 — Runtime (built into widget, works immediately):**
Widget already scrapes:
- Current page URL, title, heading
- Navigation links from DOM
- Breadcrumbs

This is sent as `pageContext` with each `/api/ask` request. Already implemented.

**Approach 2 — Build-time plugin (richer data, future enhancement):**
Vite/Webpack plugin scans:
- All route definitions (React Router, Vue Router, Next.js pages)
- Page components and their purpose
- Generates `chatbot-manifest.json`
- Widget sends manifest to backend on first connection

Priority: Approach 1 is sufficient for now. Approach 2 is a future enhancement.

---

## Developer Experience

### Scenario 1: Rails Monolith (same server) — ZERO CONFIG

```ruby
# Gemfile
gem 'sql_chatbot'

# Run once:
rails generate sql_chatbot:install
# Creates config/initializers/sql_chatbot.rb with:
#   SqlChatbot.configure do |c|
#     c.llm_api_key = ENV['OPENAI_API_KEY']
#   end

# config/routes.rb
mount SqlChatbot::Engine => '/chatbot'

# In layout:
<script src="/chatbot/widget.js"></script>
```

**Done. 2 minutes. Zero cross-origin config.**

### Scenario 2: React (Vercel) + Rails API (Heroku) — MINIMAL CONFIG

**Backend (Rails):**
```ruby
# Gemfile
gem 'sql_chatbot'

# config/initializers/sql_chatbot.rb
SqlChatbot.configure do |c|
  c.llm_api_key = ENV['OPENAI_API_KEY']
  c.allowed_origins = [ENV['FRONTEND_URL']]  # 'https://admin.myapp.com'
end

# config/routes.rb
mount SqlChatbot::Engine => '/chatbot'
```

**Frontend (Next.js):**
```js
// app/api/chatbot-token/route.js (one file, copy-paste)
import { chatbotTokenProxy } from 'sql-chatbot-widget/next';
export const GET = chatbotTokenProxy({
  backendUrl: process.env.CHATBOT_BACKEND_URL
});
```

```html
<!-- In layout -->
<script src="https://api.myapp.com/chatbot/widget.js"
        data-token-url="/api/chatbot-token"></script>
```

**Done. 5 minutes. Fully secure. Works in all browsers.**

### Scenario 3: Express + React (same server) — ZERO CONFIG

```js
const { sqlChatbot } = require('sql-chatbot-agent');
app.use('/chatbot', sqlChatbot({ databaseUrl: process.env.DATABASE_URL }));
```

```html
<script src="/chatbot/widget.js"></script>
```

**Done. 1 minute.**

---

## Implementation Tasks

### Phase 1: Backend Token System (gem + npm)

| # | Task | Description |
|---|------|-------------|
| 1 | JWT token generation | Add `POST /chatbot/api/session` endpoint to gem and npm middleware. Verify session/auth, issue signed JWT with 15 min expiry. Auto-generate signing secret on install. |
| 2 | JWT token verification | Add middleware that validates Bearer token on `/api/ask` and `/api/refresh`. Fall back to existing session/cookie auth for same-origin. |
| 3 | CORS auto-configuration | Add `allowed_origins` config option. Auto-handle CORS headers and preflight. Auto-allow localhost in development. |
| 4 | Token endpoint security | Origin validation, rate limiting (10 token requests/min per IP), audit logging. |

### Phase 2: Widget Cross-Origin Support

| # | Task | Description |
|---|------|-------------|
| 5 | Cross-origin detection | Widget detects same-origin vs cross-origin from script src. |
| 6 | Token acquisition | Widget calls `data-token-url` to get JWT. Stores in memory. |
| 7 | Bearer token injection | All API calls include `Authorization: Bearer <token>` when cross-origin. |
| 8 | Token refresh | Silent refresh at 80% lifetime. Graceful degradation on failure. |
| 9 | SSE streaming with auth | Ensure `fetch()` streaming works with Authorization header cross-origin. |

### Phase 3: Frontend Helpers

| # | Task | Description |
|---|------|-------------|
| 10 | Next.js helper | `chatbotTokenProxy` for App Router and Pages Router. |
| 11 | Nuxt helper | `chatbotTokenProxy` for Nuxt server routes. |
| 12 | Express helper | `chatbotTokenProxy` for Express/Koa BFF. |
| 13 | Generic docs | Documentation for any framework (plain fetch proxy). |

### Phase 4: Testing

| # | Task | Description |
|---|------|-------------|
| 14 | Unit tests | Token generation, verification, CORS, origin validation. |
| 15 | Integration tests | Same-origin flow, cross-origin flow, token refresh, expired token. |
| 16 | Browser E2E | Test in Chrome, Safari, Firefox with actual cross-origin setup. |
| 17 | Security tests | No token without session, expired token rejected, invalid origin rejected, rate limiting works. |

---

## Configuration Reference

```ruby
# Rails gem — config/initializers/sql_chatbot.rb
SqlChatbot.configure do |c|
  # Required
  c.llm_api_key = ENV['OPENAI_API_KEY']

  # Required for cross-origin (production only)
  c.allowed_origins = ['https://admin.myapp.com']

  # Optional — all have sensible defaults
  c.llm_provider = 'openai'              # openai, openrouter, groq, ollama
  c.llm_model = 'gpt-4o-mini'            # default per provider
  c.token_lifetime = 900                  # 15 minutes (seconds)
  c.token_secret = Rails.application.credentials.chatbot_secret  # auto-generated
  c.code_paths = ['./app']               # auto-detected
  c.bind_token_to_ip = false             # optional: tie token to IP
end
```

```js
// npm middleware — config
sqlChatbot({
  databaseUrl: process.env.DATABASE_URL,

  // Required for cross-origin (production only)
  allowedOrigins: ['https://admin.myapp.com'],

  // Optional
  llmApiKey: process.env.OPENAI_API_KEY,
  llmProvider: 'openai',
  tokenLifetime: 900,
})
```

---

## What's NOT in This Plan

- **Cloud-hosted SaaS version** — not needed now, can add later
- **Build-time Vite/Webpack plugin** — future enhancement for richer frontend indexing
- **Mobile app support** — tokens already work (no browser-specific restrictions)
- **Multi-tenant** — each app installs its own gem/package, no shared service
- **Per-user data scoping** — all authenticated users get the same chatbot access
