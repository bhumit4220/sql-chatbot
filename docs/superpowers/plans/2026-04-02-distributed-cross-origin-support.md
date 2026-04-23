# Distributed / Cross-Origin Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-origin support to both the npm package and Rails gem so the chatbot works when frontend and backend are on different servers — with minimal developer configuration and bulletproof security.

**Architecture:** Same-origin token proxy. Token requests are always same-origin (browser → its own server). Cross-origin API calls use JWT Bearer tokens, never cookies. Widget auto-detects same-origin vs cross-origin. See `docs/plans/2026-04-01-distributed-architecture-plan.md` for full architecture decisions.

**Tech Stack:** jsonwebtoken (npm), jwt gem (Rails), existing Express middleware, existing Rails Engine, existing React widget (Shadow DOM)

---

## File Structure

### npm package (`packages/agent/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/auth/jwt.ts` | CREATE | JWT token generation and verification |
| `src/auth/cors.ts` | CREATE | CORS middleware for Express |
| `src/config.ts` | MODIFY | Add `allowedOrigins`, `tokenLifetime`, `tokenSecret` to AgentConfig |
| `src/middleware.ts` | MODIFY | Add `/api/session` route, CORS middleware, JWT auth on existing routes |
| `src/helpers/next.ts` | CREATE | Next.js App Router token proxy helper |
| `src/helpers/express.ts` | CREATE | Express BFF token proxy helper |
| `src/__tests__/jwt.test.ts` | CREATE | JWT generation/verification tests |
| `src/__tests__/cors.test.ts` | CREATE | CORS middleware tests |
| `src/__tests__/session.test.ts` | CREATE | Session endpoint integration tests |
| `package.json` | MODIFY | Add `jsonwebtoken` dependency, add `exports` subpaths for helpers |

### Rails gem (`sql-chatbot-rails/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/sql_chatbot/auth/jwt.rb` | CREATE | JWT token generation and verification |
| `lib/sql_chatbot/auth/cors.rb` | CREATE | CORS before_action and OPTIONS handling |
| `lib/sql_chatbot/configuration.rb` | MODIFY | Add `allowed_origins`, `token_lifetime`, `token_secret` |
| `lib/sql_chatbot_rails.rb` | MODIFY | Require new auth files |
| `app/controllers/sql_chatbot/chatbot_controller.rb` | MODIFY | Add `session` action, CORS handling, JWT auth |
| `config/routes.rb` | MODIFY | Add session route, OPTIONS routes |
| `spec/sql_chatbot/auth/jwt_spec.rb` | CREATE | JWT tests |
| `spec/sql_chatbot/auth/cors_spec.rb` | CREATE | CORS tests |
| `spec/integration/engine_spec.rb` | MODIFY | Add session + cross-origin integration tests |
| `sql-chatbot-rails.gemspec` | MODIFY | Add `jwt` gem dependency |

### Widget (`packages/agent/widget-src/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `index.ts` | MODIFY | Cross-origin detection, pass tokenUrl + auth mode to component |
| `ChatWidget.tsx` | MODIFY | Token acquisition, Bearer auth headers, silent refresh |

---

## Task 1: npm — JWT Module

**Files:**
- Create: `packages/agent/src/auth/jwt.ts`
- Create: `packages/agent/src/__tests__/jwt.test.ts`
- Modify: `packages/agent/package.json`

- [ ] **Step 1: Install jsonwebtoken**

```bash
cd packages/agent && npm install jsonwebtoken && npm install -D @types/jsonwebtoken
```

- [ ] **Step 2: Write failing tests**

```bash
# Create test file
```

```typescript
// packages/agent/src/__tests__/jwt.test.ts
import { generateToken, verifyToken } from '../auth/jwt';

describe('JWT Auth', () => {
  const secret = 'test-secret-key-at-least-32-chars!!';

  describe('generateToken', () => {
    it('generates a valid JWT with default 15min expiry', () => {
      const token = generateToken({ secret });
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // header.payload.signature
    });

    it('includes origin in payload when provided', () => {
      const token = generateToken({ secret, origin: 'https://example.com' });
      const decoded = verifyToken({ token, secret });
      expect(decoded.origin).toBe('https://example.com');
    });

    it('includes sub in payload when provided', () => {
      const token = generateToken({ secret, sub: 'user_123' });
      const decoded = verifyToken({ token, secret });
      expect(decoded.sub).toBe('user_123');
    });

    it('respects custom lifetime in seconds', () => {
      const token = generateToken({ secret, lifetimeSeconds: 60 });
      const decoded = verifyToken({ token, secret });
      expect(decoded.exp! - decoded.iat!).toBe(60);
    });

    it('defaults to 900 seconds (15 min) lifetime', () => {
      const token = generateToken({ secret });
      const decoded = verifyToken({ token, secret });
      expect(decoded.exp! - decoded.iat!).toBe(900);
    });
  });

  describe('verifyToken', () => {
    it('returns decoded payload for valid token', () => {
      const token = generateToken({ secret });
      const decoded = verifyToken({ token, secret });
      expect(decoded).toBeDefined();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
    });

    it('throws for expired token', () => {
      const token = generateToken({ secret, lifetimeSeconds: -1 });
      expect(() => verifyToken({ token, secret })).toThrow('Token expired');
    });

    it('throws for invalid signature', () => {
      const token = generateToken({ secret });
      expect(() => verifyToken({ token, secret: 'wrong-secret' })).toThrow('Invalid token');
    });

    it('throws for malformed token', () => {
      expect(() => verifyToken({ token: 'not-a-jwt', secret })).toThrow('Invalid token');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/agent && npx jest src/__tests__/jwt.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '../auth/jwt'`

- [ ] **Step 4: Implement JWT module**

```typescript
// packages/agent/src/auth/jwt.ts
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub?: string;
  origin?: string;
  iat?: number;
  exp?: number;
}

export interface GenerateTokenOptions {
  secret: string;
  sub?: string;
  origin?: string;
  lifetimeSeconds?: number;
}

export interface VerifyTokenOptions {
  token: string;
  secret: string;
}

export function generateToken(options: GenerateTokenOptions): string {
  const { secret, sub, origin, lifetimeSeconds = 900 } = options;
  const payload: Record<string, unknown> = {};
  if (sub) payload.sub = sub;
  if (origin) payload.origin = origin;
  return jwt.sign(payload, secret, { expiresIn: lifetimeSeconds });
}

export function verifyToken(options: VerifyTokenOptions): TokenPayload {
  const { token, secret } = options;
  try {
    return jwt.verify(token, secret) as TokenPayload;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('expired')) {
      throw new Error('Token expired');
    }
    throw new Error('Invalid token');
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/agent && npx jest src/__tests__/jwt.test.ts --no-coverage
```

Expected: 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/auth/jwt.ts packages/agent/src/__tests__/jwt.test.ts packages/agent/package.json packages/agent/package-lock.json
git commit -m "feat: add JWT token generation and verification module (npm)"
```

---

## Task 2: npm — CORS Middleware

**Files:**
- Create: `packages/agent/src/auth/cors.ts`
- Create: `packages/agent/src/__tests__/cors.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agent/src/__tests__/cors.test.ts
import express from 'express';
import request from 'supertest';
import { corsMiddleware } from '../auth/cors';

function createApp(allowedOrigins?: string[]) {
  const app = express();
  app.use(corsMiddleware({ allowedOrigins }));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.post('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('CORS Middleware', () => {
  describe('when allowedOrigins is not set', () => {
    it('allows any origin in development', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const app = createApp();
      return request(app)
        .get('/test')
        .set('Origin', 'http://localhost:5173')
        .expect(200)
        .expect('Access-Control-Allow-Origin', 'http://localhost:5173')
        .then(() => { process.env.NODE_ENV = origEnv; });
    });

    it('allows localhost origins in development', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const app = createApp();
      return request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000')
        .expect('Access-Control-Allow-Origin', 'http://localhost:3000')
        .then(() => { process.env.NODE_ENV = origEnv; });
    });

    it('rejects non-localhost origins in production when no allowedOrigins', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const app = createApp();
      return request(app)
        .get('/test')
        .set('Origin', 'https://evil.com')
        .expect(200)
        .then((res) => {
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
          process.env.NODE_ENV = origEnv;
        });
    });
  });

  describe('when allowedOrigins is set', () => {
    const origins = ['https://admin.myapp.com', 'https://staging.myapp.com'];

    it('sets CORS headers for allowed origin', () => {
      const app = createApp(origins);
      return request(app)
        .get('/test')
        .set('Origin', 'https://admin.myapp.com')
        .expect('Access-Control-Allow-Origin', 'https://admin.myapp.com');
    });

    it('does not set CORS headers for disallowed origin', () => {
      const app = createApp(origins);
      return request(app)
        .get('/test')
        .set('Origin', 'https://evil.com')
        .then((res) => {
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });

    it('handles OPTIONS preflight requests', () => {
      const app = createApp(origins);
      return request(app)
        .options('/test')
        .set('Origin', 'https://admin.myapp.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204)
        .expect('Access-Control-Allow-Origin', 'https://admin.myapp.com')
        .expect('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .expect('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    });

    it('rejects preflight for disallowed origin', () => {
      const app = createApp(origins);
      return request(app)
        .options('/test')
        .set('Origin', 'https://evil.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204)
        .then((res) => {
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });
  });

  describe('same-origin requests (no Origin header)', () => {
    it('passes through without CORS headers', () => {
      const app = createApp(['https://admin.myapp.com']);
      return request(app)
        .get('/test')
        .expect(200)
        .then((res) => {
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/agent && npx jest src/__tests__/cors.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '../auth/cors'`

- [ ] **Step 3: Implement CORS middleware**

```typescript
// packages/agent/src/auth/cors.ts
import { Request, Response, NextFunction } from 'express';

export interface CorsOptions {
  allowedOrigins?: string[];
}

function isOriginAllowed(origin: string, allowedOrigins?: string[]): boolean {
  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }
  // No allowedOrigins configured: allow localhost in development only
  const env = process.env.NODE_ENV || 'development';
  if (env === 'development' || env === 'test') {
    return /^https?:\/\/localhost(:\d+)?$/.test(origin);
  }
  return false;
}

export function corsMiddleware(options: CorsOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    const allowed = isOriginAllowed(origin, options.allowedOrigins);

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/agent && npx jest src/__tests__/cors.test.ts --no-coverage
```

Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/auth/cors.ts packages/agent/src/__tests__/cors.test.ts
git commit -m "feat: add CORS middleware with origin allowlist (npm)"
```

---

## Task 3: npm — Config + Session Endpoint + JWT Auth

**Files:**
- Modify: `packages/agent/src/config.ts`
- Modify: `packages/agent/src/middleware.ts`
- Create: `packages/agent/src/__tests__/session.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/agent/src/__tests__/session.test.ts
import express from 'express';
import request from 'supertest';
import { verifyToken } from '../auth/jwt';

// We need to test the session endpoint and JWT auth on /api/ask
// This requires the full middleware, so we'll test via the router

describe('Session Endpoint', () => {
  // We'll import and configure the middleware once config changes are done
  // For now, these tests verify the contract

  describe('POST /api/session', () => {
    it('returns a JWT token with expires_in', async () => {
      // Will be implemented after middleware changes
      expect(true).toBe(true); // placeholder until middleware is updated
    });
  });
});

// The actual integration tests will be written inline with the middleware changes
// See Step 3 for the real test code
```

Note: The real tests are written in Step 3 below alongside the implementation, because they require the full middleware setup.

- [ ] **Step 2: Add config options to AgentConfig**

Read `packages/agent/src/config.ts` first. Then add these fields to the `AgentConfig` interface and `resolveConfig` function:

Add to `AgentConfig` interface:
```typescript
  allowedOrigins?: string[];   // Allowed cross-origin domains
  tokenLifetime?: number;      // JWT lifetime in seconds (default: 900)
  tokenSecret?: string;        // JWT signing secret (auto-generated if not set)
```

Add to `resolveConfig` function, after existing resolution logic:
```typescript
  const tokenSecret = userConfig.tokenSecret
    || process.env.CHATBOT_TOKEN_SECRET
    || require('crypto').randomBytes(32).toString('hex');
```

Return these in the resolved config object:
```typescript
  return {
    // ... existing fields ...
    allowedOrigins: userConfig.allowedOrigins,
    tokenLifetime: userConfig.tokenLifetime || 900,
    tokenSecret,
  };
```

- [ ] **Step 3: Add session endpoint and JWT auth to middleware**

Read `packages/agent/src/middleware.ts` first. Then make these changes:

1. Import the new modules at the top:
```typescript
import { generateToken, verifyToken } from './auth/jwt';
import { corsMiddleware } from './auth/cors';
```

2. Add CORS middleware right after `router` creation (before any routes):
```typescript
  router.use(corsMiddleware({ allowedOrigins: config.allowedOrigins }));
```

3. Add the session endpoint (before the `/api/ask` route):
```typescript
  router.post('/api/session', (req, res) => {
    // For same-origin: check existing secret-based auth
    // For cross-origin: check Authorization header forwarded by frontend proxy
    const origin = req.headers.origin;

    // Validate origin if allowedOrigins is configured
    if (config.allowedOrigins && config.allowedOrigins.length > 0 && origin) {
      if (!config.allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
    }

    // Check auth: Bearer token from frontend proxy, or cookie from same-origin
    if (config.secret) {
      const authHeader = req.headers.authorization;
      const cookieToken = req.cookies?.chatbot_token;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (bearerToken !== config.secret && cookieToken !== config.secret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const token = generateToken({
      secret: config.tokenSecret!,
      origin: origin || undefined,
      lifetimeSeconds: config.tokenLifetime,
    });

    res.json({ token, expires_in: config.tokenLifetime });
  });
```

4. Update the auth check on `/api/ask` and `/api/refresh` to ALSO accept JWT tokens. Modify the existing `authorized` helper function (or inline auth check) to:
```typescript
  function isAuthorized(req: express.Request): boolean {
    // Check JWT Bearer token first (cross-origin flow)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);

      // Try JWT verification
      try {
        verifyToken({ token: bearerToken, secret: config.tokenSecret! });
        return true;
      } catch {
        // Not a JWT, fall through to secret check
      }

      // Try secret-based auth (existing behavior)
      if (config.secret && bearerToken === config.secret) {
        return true;
      }
    }

    // Check cookie (existing behavior, same-origin)
    if (config.secret && req.cookies?.chatbot_token === config.secret) {
      return true;
    }

    // No secret configured = open access (existing behavior)
    if (!config.secret) return true;

    return false;
  }
```

Replace existing auth checks in `/api/ask` and `/api/refresh` to use `isAuthorized(req)`.

- [ ] **Step 4: Write proper integration tests**

Replace the placeholder in `packages/agent/src/__tests__/session.test.ts`:

```typescript
// packages/agent/src/__tests__/session.test.ts
import { sqlChatbot } from '../index';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { verifyToken } from '../auth/jwt';

function createTestApp(config: Record<string, unknown> = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgresql://localhost/test_db',
    secret: 'test-secret',
    ...config,
  } as any));
  return app;
}

describe('POST /chatbot/api/session', () => {
  it('returns JWT when authorized via Bearer secret', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(res.body.token).toBeDefined();
    expect(res.body.expires_in).toBe(900);
    expect(res.body.token.split('.')).toHaveLength(3);
  });

  it('returns 401 when no auth provided', async () => {
    const app = createTestApp();
    await request(app)
      .post('/chatbot/api/session')
      .expect(401);
  });

  it('returns 401 when wrong secret', async () => {
    const app = createTestApp();
    await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer wrong-secret')
      .expect(401);
  });

  it('returns 403 when origin not in allowedOrigins', async () => {
    const app = createTestApp({ allowedOrigins: ['https://admin.myapp.com'] });
    await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .set('Origin', 'https://evil.com')
      .expect(403);
  });

  it('returns JWT when origin is in allowedOrigins', async () => {
    const app = createTestApp({ allowedOrigins: ['https://admin.myapp.com'] });
    const res = await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .set('Origin', 'https://admin.myapp.com')
      .expect(200);

    expect(res.body.token).toBeDefined();
  });

  it('respects custom tokenLifetime', async () => {
    const app = createTestApp({ tokenLifetime: 300 });
    const res = await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    expect(res.body.expires_in).toBe(300);
  });

  it('allows session without secret when no secret configured', async () => {
    const app = createTestApp({ secret: undefined });
    const res = await request(app)
      .post('/chatbot/api/session')
      .expect(200);

    expect(res.body.token).toBeDefined();
  });
});

describe('JWT auth on /chatbot/api/ask', () => {
  it('accepts JWT token from /api/session', async () => {
    const app = createTestApp();

    // Get token
    const sessionRes = await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    // Use token on /api/ask — will fail on LLM init but should NOT fail on auth
    const askRes = await request(app)
      .post('/chatbot/api/ask')
      .set('Authorization', `Bearer ${sessionRes.body.token}`)
      .send({ question: 'test' });

    // Should not be 401 — auth passed, may fail on other things (LLM, DB)
    expect(askRes.status).not.toBe(401);
  });

  it('rejects expired JWT', async () => {
    const app = createTestApp({ tokenLifetime: -1 });

    const sessionRes = await request(app)
      .post('/chatbot/api/session')
      .set('Authorization', 'Bearer test-secret')
      .expect(200);

    const askRes = await request(app)
      .post('/chatbot/api/ask')
      .set('Authorization', `Bearer ${sessionRes.body.token}`)
      .send({ question: 'test' });

    expect(askRes.status).toBe(401);
  });
});
```

- [ ] **Step 5: Run all tests**

```bash
cd packages/agent && npx jest src/__tests__/jwt.test.ts src/__tests__/cors.test.ts src/__tests__/session.test.ts --no-coverage
```

Expected: All tests PASS

- [ ] **Step 6: Run full test suite to verify no regressions**

```bash
cd packages/agent && npm test
```

Expected: All 247+ tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/config.ts packages/agent/src/middleware.ts packages/agent/src/__tests__/session.test.ts
git commit -m "feat: add /api/session endpoint with JWT auth and CORS (npm)"
```

---

## Task 4: Rails Gem — JWT Module

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/auth/jwt.rb`
- Create: `sql-chatbot-rails/spec/sql_chatbot/auth/jwt_spec.rb`
- Modify: `sql-chatbot-rails/sql-chatbot-rails.gemspec`
- Modify: `sql-chatbot-rails/lib/sql_chatbot_rails.rb`

- [ ] **Step 1: Add jwt gem dependency**

Read `sql-chatbot-rails/sql-chatbot-rails.gemspec` first. Add to dependencies:

```ruby
  spec.add_dependency "jwt", "~> 2.7"
```

Then run:
```bash
cd sql-chatbot-rails && bundle install
```

- [ ] **Step 2: Write failing tests**

```ruby
# sql-chatbot-rails/spec/sql_chatbot/auth/jwt_spec.rb
require "spec_helper"
require "sql_chatbot/auth/jwt"

RSpec.describe SqlChatbot::Auth::Jwt do
  let(:secret) { "test-secret-key-at-least-32-chars!!" }

  describe ".generate_token" do
    it "generates a valid JWT string" do
      token = described_class.generate_token(secret: secret)
      expect(token).to be_a(String)
      expect(token.split(".").length).to eq(3)
    end

    it "includes origin in payload when provided" do
      token = described_class.generate_token(secret: secret, origin: "https://example.com")
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["origin"]).to eq("https://example.com")
    end

    it "includes sub in payload when provided" do
      token = described_class.generate_token(secret: secret, sub: "user_123")
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["sub"]).to eq("user_123")
    end

    it "defaults to 900 seconds (15 min) lifetime" do
      token = described_class.generate_token(secret: secret)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["exp"] - decoded["iat"]).to eq(900)
    end

    it "respects custom lifetime_seconds" do
      token = described_class.generate_token(secret: secret, lifetime_seconds: 60)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded["exp"] - decoded["iat"]).to eq(60)
    end
  end

  describe ".verify_token" do
    it "returns decoded payload for valid token" do
      token = described_class.generate_token(secret: secret)
      decoded = described_class.verify_token(token: token, secret: secret)
      expect(decoded).to be_a(Hash)
      expect(decoded["iat"]).to be_a(Integer)
      expect(decoded["exp"]).to be_a(Integer)
    end

    it "raises TokenExpired for expired token" do
      token = described_class.generate_token(secret: secret, lifetime_seconds: -1)
      expect {
        described_class.verify_token(token: token, secret: secret)
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenExpired)
    end

    it "raises TokenInvalid for wrong secret" do
      token = described_class.generate_token(secret: secret)
      expect {
        described_class.verify_token(token: token, secret: "wrong-secret")
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenInvalid)
    end

    it "raises TokenInvalid for malformed token" do
      expect {
        described_class.verify_token(token: "not-a-jwt", secret: secret)
      }.to raise_error(SqlChatbot::Auth::Jwt::TokenInvalid)
    end
  end
end
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/auth/jwt_spec.rb
```

Expected: FAIL — `cannot load such file -- sql_chatbot/auth/jwt`

- [ ] **Step 4: Implement JWT module**

```ruby
# sql-chatbot-rails/lib/sql_chatbot/auth/jwt.rb
require "jwt"

module SqlChatbot
  module Auth
    module Jwt
      class TokenExpired < StandardError; end
      class TokenInvalid < StandardError; end

      ALGORITHM = "HS256"
      DEFAULT_LIFETIME = 900 # 15 minutes

      def self.generate_token(secret:, sub: nil, origin: nil, lifetime_seconds: DEFAULT_LIFETIME)
        now = Time.now.to_i
        payload = {
          "iat" => now,
          "exp" => now + lifetime_seconds
        }
        payload["sub"] = sub if sub
        payload["origin"] = origin if origin
        ::JWT.encode(payload, secret, ALGORITHM)
      end

      def self.verify_token(token:, secret:)
        ::JWT.decode(token, secret, true, algorithm: ALGORITHM).first
      rescue ::JWT::ExpiredSignature
        raise TokenExpired, "Token expired"
      rescue ::JWT::DecodeError
        raise TokenInvalid, "Invalid token"
      end
    end
  end
end
```

- [ ] **Step 5: Add require to main file**

Read `sql-chatbot-rails/lib/sql_chatbot_rails.rb`. Add after the existing requires:

```ruby
require "sql_chatbot/auth/jwt"
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/auth/jwt_spec.rb
```

Expected: 8 tests PASS

- [ ] **Step 7: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/auth/jwt.rb sql-chatbot-rails/spec/sql_chatbot/auth/jwt_spec.rb sql-chatbot-rails/sql-chatbot-rails.gemspec sql-chatbot-rails/lib/sql_chatbot_rails.rb sql-chatbot-rails/Gemfile.lock
git commit -m "feat(rails): add JWT token generation and verification module"
```

---

## Task 5: Rails Gem — CORS + Config + Session Endpoint

**Files:**
- Create: `sql-chatbot-rails/lib/sql_chatbot/auth/cors.rb`
- Create: `sql-chatbot-rails/spec/sql_chatbot/auth/cors_spec.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot/configuration.rb`
- Modify: `sql-chatbot-rails/lib/sql_chatbot_rails.rb`
- Modify: `sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb`
- Modify: `sql-chatbot-rails/config/routes.rb`
- Modify: `sql-chatbot-rails/spec/integration/engine_spec.rb`

- [ ] **Step 1: Write CORS module tests**

```ruby
# sql-chatbot-rails/spec/sql_chatbot/auth/cors_spec.rb
require "spec_helper"
require "sql_chatbot/auth/cors"

RSpec.describe SqlChatbot::Auth::Cors do
  describe ".origin_allowed?" do
    it "allows listed origins" do
      expect(described_class.origin_allowed?("https://admin.myapp.com", ["https://admin.myapp.com"])).to be true
    end

    it "rejects unlisted origins" do
      expect(described_class.origin_allowed?("https://evil.com", ["https://admin.myapp.com"])).to be false
    end

    it "allows localhost in development when no allowlist" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("development"))
      expect(described_class.origin_allowed?("http://localhost:5173", nil)).to be true
    end

    it "allows localhost with port in development" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("development"))
      expect(described_class.origin_allowed?("http://localhost:3000", nil)).to be true
    end

    it "rejects non-localhost in production when no allowlist" do
      allow(Rails).to receive(:env).and_return(ActiveSupport::StringInquirer.new("production"))
      expect(described_class.origin_allowed?("https://evil.com", nil)).to be false
    end

    it "returns false when origin is nil" do
      expect(described_class.origin_allowed?(nil, ["https://admin.myapp.com"])).to be false
    end
  end
end
```

- [ ] **Step 2: Implement CORS module**

```ruby
# sql-chatbot-rails/lib/sql_chatbot/auth/cors.rb
module SqlChatbot
  module Auth
    module Cors
      ALLOWED_METHODS = "GET, POST, OPTIONS"
      ALLOWED_HEADERS = "Authorization, Content-Type"
      MAX_AGE = "86400"

      def self.origin_allowed?(origin, allowed_origins)
        return false if origin.nil?

        if allowed_origins.is_a?(Array) && allowed_origins.any?
          return allowed_origins.include?(origin)
        end

        # No allowlist: allow localhost in development/test only
        if Rails.env.development? || Rails.env.test?
          return origin.match?(/\Ahttps?:\/\/localhost(:\d+)?\z/)
        end

        false
      end

      def self.set_headers(response, origin)
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS
        response.headers["Access-Control-Allow-Headers"] = ALLOWED_HEADERS
        response.headers["Access-Control-Max-Age"] = MAX_AGE
      end
    end
  end
end
```

- [ ] **Step 3: Add config options**

Read `sql-chatbot-rails/lib/sql_chatbot/configuration.rb`. Add new `attr_accessor` fields:

```ruby
attr_accessor :allowed_origins,  # Array of allowed cross-origin domains
              :token_lifetime,   # JWT lifetime in seconds (default: 900)
              :token_secret      # JWT signing secret (auto-generated if nil)
```

In `initialize`, add defaults:
```ruby
@token_lifetime = 900
```

Add a method to resolve the token secret:
```ruby
def resolved_token_secret
  @token_secret || ENV["CHATBOT_TOKEN_SECRET"] || SecureRandom.hex(32)
end
```

Note: the resolved secret should be memoized so it stays the same across requests. Add to `initialize`:
```ruby
@_resolved_token_secret = nil
```

And change the method to:
```ruby
def resolved_token_secret
  @_resolved_token_secret ||= (@token_secret || ENV["CHATBOT_TOKEN_SECRET"] || SecureRandom.hex(32))
end
```

- [ ] **Step 4: Add require for CORS module**

In `sql-chatbot-rails/lib/sql_chatbot_rails.rb`, add after the JWT require:

```ruby
require "sql_chatbot/auth/cors"
```

- [ ] **Step 5: Add session route**

Read `sql-chatbot-rails/config/routes.rb`. Add:

```ruby
post "api/session", to: "chatbot#session"
match "api/*path",  to: "chatbot#preflight", via: :options
```

- [ ] **Step 6: Update controller with session action, CORS, and JWT auth**

Read `sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb`. Make these changes:

Add a `before_action` for CORS:
```ruby
before_action :handle_cors
```

Add the `session` action:
```ruby
def session
  origin = request.headers["Origin"]

  # Validate origin
  allowed_origins = SqlChatbot.config&.allowed_origins
  if origin && !Auth::Cors.origin_allowed?(origin, allowed_origins)
    return render json: { error: "Origin not allowed" }, status: 403
  end

  # Check auth (same as existing authorized? but for session creation)
  unless authorized?
    return render_unauthorized
  end

  config = SqlChatbot.config
  token = Auth::Jwt.generate_token(
    secret: config.resolved_token_secret,
    origin: origin,
    lifetime_seconds: config.token_lifetime
  )

  render json: { token: token, expires_in: config.token_lifetime }
end
```

Add the `preflight` action for OPTIONS:
```ruby
def preflight
  head :no_content
end
```

Update the existing `authorized?` method to ALSO check JWT tokens:
```ruby
def authorized?
  return true unless SqlChatbot.config&.secret

  auth_header = request.headers["Authorization"]
  if auth_header
    scheme, token = auth_header.split(" ", 2)
    if scheme == "Bearer" && token
      # Try JWT verification first
      begin
        Auth::Jwt.verify_token(token: token, secret: SqlChatbot.config.resolved_token_secret)
        return true
      rescue Auth::Jwt::TokenExpired, Auth::Jwt::TokenInvalid
        # Not a JWT, try secret match
      end

      # Try secret match (existing behavior)
      return true if token == SqlChatbot.config.secret
    end
  end

  # Check cookie (existing behavior)
  return true if cookies[:chatbot_token] == SqlChatbot.config.secret

  false
end
```

Add the CORS `before_action`:
```ruby
def handle_cors
  origin = request.headers["Origin"]
  return unless origin

  allowed_origins = SqlChatbot.config&.allowed_origins
  if Auth::Cors.origin_allowed?(origin, allowed_origins)
    Auth::Cors.set_headers(response, origin)
  end
end
```

- [ ] **Step 7: Write integration tests**

Read `sql-chatbot-rails/spec/integration/engine_spec.rb`. Add these test blocks:

```ruby
describe "POST /chatbot/api/session" do
  before do
    SqlChatbot.configure do |c|
      c.secret = "test-secret"
    end
    allow(SqlChatbot).to receive(:ensure_initialized!)
  end

  after { SqlChatbot.reset! }

  it "returns JWT when authorized via Bearer secret" do
    post "/chatbot/api/session", headers: { "Authorization" => "Bearer test-secret" }
    expect(response).to have_http_status(:ok)
    body = JSON.parse(response.body)
    expect(body["token"]).to be_present
    expect(body["token"].split(".").length).to eq(3)
    expect(body["expires_in"]).to eq(900)
  end

  it "returns 401 when unauthorized" do
    post "/chatbot/api/session"
    expect(response).to have_http_status(:unauthorized)
  end

  it "returns 401 when wrong secret" do
    post "/chatbot/api/session", headers: { "Authorization" => "Bearer wrong" }
    expect(response).to have_http_status(:unauthorized)
  end

  it "returns 403 when origin not allowed" do
    SqlChatbot.config.allowed_origins = ["https://admin.myapp.com"]
    post "/chatbot/api/session",
      headers: { "Authorization" => "Bearer test-secret", "Origin" => "https://evil.com" }
    expect(response).to have_http_status(:forbidden)
  end

  it "returns JWT when origin is allowed" do
    SqlChatbot.config.allowed_origins = ["https://admin.myapp.com"]
    post "/chatbot/api/session",
      headers: { "Authorization" => "Bearer test-secret", "Origin" => "https://admin.myapp.com" }
    expect(response).to have_http_status(:ok)
    body = JSON.parse(response.body)
    expect(body["token"]).to be_present
  end

  it "accepts JWT token on /api/ask" do
    # Get a token
    post "/chatbot/api/session", headers: { "Authorization" => "Bearer test-secret" }
    token = JSON.parse(response.body)["token"]

    # Mock orchestrator for the ask request
    events = [{ type: "done" }]
    orchestrator = double("orchestrator", handle_question: events)
    SqlChatbot.orchestrator = orchestrator

    # Use JWT on /api/ask
    post "/chatbot/api/ask",
      params: { question: "test" },
      headers: { "Authorization" => "Bearer #{token}" }
    expect(response).not_to have_http_status(:unauthorized)
  end
end

describe "CORS headers" do
  before do
    SqlChatbot.configure do |c|
      c.allowed_origins = ["https://admin.myapp.com"]
    end
    allow(SqlChatbot).to receive(:ensure_initialized!)
  end

  after { SqlChatbot.reset! }

  it "sets CORS headers for allowed origin" do
    get "/chatbot/api/health", headers: { "Origin" => "https://admin.myapp.com" }
    expect(response.headers["Access-Control-Allow-Origin"]).to eq("https://admin.myapp.com")
  end

  it "does not set CORS headers for disallowed origin" do
    get "/chatbot/api/health", headers: { "Origin" => "https://evil.com" }
    expect(response.headers["Access-Control-Allow-Origin"]).to be_nil
  end

  it "handles OPTIONS preflight" do
    process :options, "/chatbot/api/ask",
      headers: { "Origin" => "https://admin.myapp.com", "Access-Control-Request-Method" => "POST" }
    expect(response).to have_http_status(:no_content)
    expect(response.headers["Access-Control-Allow-Origin"]).to eq("https://admin.myapp.com")
  end
end
```

- [ ] **Step 8: Run CORS unit tests**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/sql_chatbot/auth/cors_spec.rb
```

Expected: 6 tests PASS

- [ ] **Step 9: Run integration tests**

```bash
cd sql-chatbot-rails && bundle exec rspec spec/integration/engine_spec.rb
```

Expected: All tests PASS (existing + new)

- [ ] **Step 10: Run full gem test suite**

```bash
cd sql-chatbot-rails && bundle exec rspec
```

Expected: 242+ tests PASS (existing) + new tests PASS

- [ ] **Step 11: Commit**

```bash
git add sql-chatbot-rails/lib/sql_chatbot/auth/ sql-chatbot-rails/spec/sql_chatbot/auth/ sql-chatbot-rails/lib/sql_chatbot/configuration.rb sql-chatbot-rails/lib/sql_chatbot_rails.rb sql-chatbot-rails/app/controllers/sql_chatbot/chatbot_controller.rb sql-chatbot-rails/config/routes.rb sql-chatbot-rails/spec/integration/engine_spec.rb
git commit -m "feat(rails): add session endpoint, CORS, and JWT auth for cross-origin support"
```

---

## Task 6: Widget — Cross-Origin Detection + Token Management

**Files:**
- Modify: `packages/agent/widget-src/index.ts`
- Modify: `packages/agent/widget-src/ChatWidget.tsx`

- [ ] **Step 1: Update widget entry point for cross-origin detection**

Read `packages/agent/widget-src/index.ts`. Make these changes:

After extracting `baseUrl` from the script `src`, add cross-origin detection:

```typescript
const scriptOrigin = baseUrl ? new URL(baseUrl).origin : window.location.origin;
const pageOrigin = window.location.origin;
const isCrossOrigin = scriptOrigin !== pageOrigin;
const tokenUrl = script?.getAttribute('data-token-url') || null;
```

Pass these as props to the React component:

```typescript
root.render(
  React.createElement(ChatWidget, {
    baseUrl,
    position,
    isCrossOrigin,
    tokenUrl,
  })
);
```

- [ ] **Step 2: Update ChatWidget for token management**

Read `packages/agent/widget-src/ChatWidget.tsx`. Make these changes:

Add to component props interface:
```typescript
interface ChatWidgetProps {
  baseUrl: string;
  position?: string;
  isCrossOrigin?: boolean;
  tokenUrl?: string | null;
}
```

Add token state inside the component:
```typescript
const [authToken, setAuthToken] = useState<string | null>(null);
const [tokenExpiresAt, setTokenExpiresAt] = useState<number>(0);
const tokenRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Add token acquisition function:
```typescript
async function acquireToken(): Promise<string | null> {
  if (!isCrossOrigin || !tokenUrl) return null;

  try {
    const resp = await fetch(tokenUrl, { credentials: 'include' });
    if (!resp.ok) return null;
    const data = await resp.json();
    setAuthToken(data.token);
    setTokenExpiresAt(Date.now() + (data.expires_in * 1000));

    // Schedule refresh at 80% lifetime
    const refreshMs = data.expires_in * 800; // 80% in milliseconds
    if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
    tokenRefreshTimer.current = setTimeout(() => { acquireToken(); }, refreshMs);

    return data.token;
  } catch {
    return null;
  }
}
```

Add useEffect to acquire token on mount (when cross-origin):
```typescript
useEffect(() => {
  if (isCrossOrigin && tokenUrl) {
    acquireToken();
  }
  return () => {
    if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
  };
}, [isCrossOrigin, tokenUrl]);
```

Modify the `fetch` call in the send-message handler to include auth headers when cross-origin:
```typescript
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (isCrossOrigin && authToken) {
  headers['Authorization'] = `Bearer ${authToken}`;
}

const resp = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    question,
    pageContext: JSON.stringify(getPageContext()),
    history: messages.slice(-4),
  }),
});
```

Remove the `credentials: 'include'` from cross-origin fetch calls (we use Bearer, not cookies).

- [ ] **Step 3: Build the widget**

```bash
cd packages/agent && npm run build:widget
```

Expected: Widget builds successfully to `packages/agent/widget/widget.js`

- [ ] **Step 4: Run full npm test suite**

```bash
cd packages/agent && npm test
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/widget-src/index.ts packages/agent/widget-src/ChatWidget.tsx packages/agent/widget/widget.js
git commit -m "feat(widget): add cross-origin detection, token acquisition, and Bearer auth"
```

---

## Task 7: Frontend Proxy Helpers

**Files:**
- Create: `packages/agent/src/helpers/next.ts`
- Create: `packages/agent/src/helpers/express.ts`
- Modify: `packages/agent/package.json` (add exports)

- [ ] **Step 1: Create Next.js App Router helper**

```typescript
// packages/agent/src/helpers/next.ts

interface ChatbotProxyOptions {
  backendUrl: string;  // e.g. "https://api.myapp.com/chatbot"
}

/**
 * Next.js App Router token proxy.
 *
 * Usage:
 *   // app/api/chatbot-token/route.ts
 *   import { chatbotTokenProxy } from 'sql-chatbot-agent/helpers/next';
 *   export const GET = chatbotTokenProxy({ backendUrl: process.env.CHATBOT_BACKEND_URL! });
 */
export function chatbotTokenProxy(options: ChatbotProxyOptions) {
  return async function GET(request: Request): Promise<Response> {
    const { backendUrl } = options;
    const sessionUrl = `${backendUrl.replace(/\/$/, '')}/api/session`;

    // Forward the user's auth headers to the backend
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authHeader = request.headers.get('Authorization');
    if (authHeader) headers['Authorization'] = authHeader;
    const cookieHeader = request.headers.get('Cookie');
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    try {
      const resp = await fetch(sessionUrl, {
        method: 'POST',
        headers,
      });

      const data = await resp.json();

      if (!resp.ok) {
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to reach chatbot backend' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
```

- [ ] **Step 2: Create Express BFF helper**

```typescript
// packages/agent/src/helpers/express.ts
import { Request, Response } from 'express';

interface ChatbotProxyOptions {
  backendUrl: string;  // e.g. "https://api.myapp.com/chatbot"
}

/**
 * Express token proxy middleware.
 *
 * Usage:
 *   import { chatbotTokenProxy } from 'sql-chatbot-agent/helpers/express';
 *   app.get('/api/chatbot-token', chatbotTokenProxy({ backendUrl: process.env.CHATBOT_BACKEND_URL }));
 */
export function chatbotTokenProxy(options: ChatbotProxyOptions) {
  return async function handler(req: Request, res: Response) {
    const { backendUrl } = options;
    const sessionUrl = `${backendUrl.replace(/\/$/, '')}/api/session`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;

    try {
      const resp = await fetch(sessionUrl, {
        method: 'POST',
        headers,
      });

      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch {
      res.status(502).json({ error: 'Failed to reach chatbot backend' });
    }
  };
}
```

- [ ] **Step 3: Add exports to package.json**

Read `packages/agent/package.json`. Add an `exports` field (if not present) or extend it:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./helpers/next": {
      "import": "./dist/helpers/next.js",
      "require": "./dist/helpers/next.js",
      "types": "./dist/helpers/next.d.ts"
    },
    "./helpers/express": {
      "import": "./dist/helpers/express.js",
      "require": "./dist/helpers/express.js",
      "types": "./dist/helpers/express.d.ts"
    }
  }
}
```

- [ ] **Step 4: Build and verify**

```bash
cd packages/agent && npm run build
```

Expected: Compiles without errors, `dist/helpers/next.js` and `dist/helpers/express.js` exist

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/helpers/ packages/agent/package.json
git commit -m "feat: add frontend token proxy helpers for Next.js and Express"
```

---

## Task 8: Rails Gem — Update Install Generator

**Files:**
- Modify: `sql-chatbot-rails/lib/generators/sql_chatbot/templates/initializer.rb`

- [ ] **Step 1: Update the initializer template**

Read the current template. Add the new config options as comments:

```ruby
SqlChatbot.configure do |c|
  # LLM provider: "openrouter" (default, free), "openai", "groq", "ollama"
  c.llm_provider = "openrouter"
  c.llm_api_key = ENV["OPENROUTER_API_KEY"]

  # Optional: override model or base URL
  # c.llm_model = "gpt-4o-mini"
  # c.llm_base_url = "https://api.openai.com/v1"

  # Optional: restrict chatbot access (Bearer token or cookie)
  # c.secret = ENV["CHATBOT_SECRET"]

  # Optional: domain-specific context for better SQL generation
  # c.custom_context = "status=3 means Deleted, always exclude deleted records"

  # Cross-origin support (for distributed frontend/backend setups):
  # c.allowed_origins = ["https://your-frontend-domain.com"]
  # c.token_lifetime = 900  # JWT lifetime in seconds (default: 15 minutes)

  # Code paths to index (default: ["./app"])
  # c.code_paths = ["./app", "./lib"]
end
```

- [ ] **Step 2: Commit**

```bash
git add sql-chatbot-rails/lib/generators/sql_chatbot/templates/initializer.rb
git commit -m "feat(rails): update install generator with cross-origin config options"
```

---

## Task 9: Full Test Suite Verification

- [ ] **Step 1: Run npm package full test suite**

```bash
cd packages/agent && npm test
```

Expected: All tests PASS (247 existing + new jwt/cors/session tests)

- [ ] **Step 2: Run Rails gem full test suite**

```bash
cd sql-chatbot-rails && bundle exec rspec
```

Expected: All tests PASS (242 existing + new jwt/cors/session/integration tests)

- [ ] **Step 3: Build widget and verify**

```bash
cd packages/agent && npm run build:widget && npm run build
```

Expected: Both build successfully

- [ ] **Step 4: Final commit with test count update**

If any test adjustments were needed, commit them:

```bash
git add -A
git commit -m "test: verify all tests pass for cross-origin support"
```

---

## What's NOT in This Plan

- **Browser E2E testing** — requires actual cross-origin server setup (separate task)
- **Nuxt helper** — same pattern as Next.js, add when needed
- **Rate limiting on session endpoint** — can be added as enhancement
- **Per-user data scoping** — all authenticated users get same access
- **Build-time Vite/Webpack plugin** — future enhancement for frontend code indexing
- **Mobile app testing** — tokens work without browser restrictions, test when needed
