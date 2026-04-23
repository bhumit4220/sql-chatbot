# CLI Standalone Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CLI to `sql-chatbot-agent` so users can run `npx sql-chatbot-agent` with zero boilerplate — one command starts the chatbot server with auth.

**Architecture:** Single `src/cli.ts` entry point that parses args, loads config file, merges with env vars, creates Express app, mounts the existing `sqlChatbot()` middleware, and listens. Auth via secret token validated in middleware. `init` subcommand scaffolds config file and updates `.gitignore`.

**Tech Stack:** Node.js `util.parseArgs`, Express (already a dep), existing `sqlChatbot()` middleware.

---

### Task 1: Add Secret Auth to Middleware

**Files:**
- Modify: `packages/agent/src/config.ts`
- Modify: `packages/agent/src/middleware.ts`
- Modify: `packages/agent/src/__tests__/middleware.test.ts`
- Modify: `packages/agent/src/__tests__/config.test.ts`

**Step 1: Write failing tests for secret auth**

Add to `packages/agent/src/__tests__/middleware.test.ts`:

```typescript
// In the describe('POST /api/ask') block, add:

it('returns 401 when secret is configured but request has no token', async () => {
  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgres://localhost/test',
    groqApiKey: 'test-key',
    secret: 'my-secret-token',
  }));

  const res = await request(app)
    .post('/chatbot/api/ask')
    .send({ question: 'How many users?' });

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'Unauthorized' });
});

it('allows request when secret matches via Authorization header', async () => {
  mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));

  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgres://localhost/test',
    groqApiKey: 'test-key',
    secret: 'my-secret-token',
  }));

  const res = await request(app)
    .post('/chatbot/api/ask')
    .set('Authorization', 'Bearer my-secret-token')
    .send({ question: 'How many users?' });

  expect(res.status).toBe(200);
});

it('allows request when secret matches via cookie', async () => {
  mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));

  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgres://localhost/test',
    groqApiKey: 'test-key',
    secret: 'my-secret-token',
  }));

  const res = await request(app)
    .post('/chatbot/api/ask')
    .set('Cookie', 'chatbot_token=my-secret-token')
    .send({ question: 'How many users?' });

  expect(res.status).toBe(200);
});

it('skips auth when no secret is configured', async () => {
  mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));
  const app = createApp(); // no secret

  const res = await request(app)
    .post('/chatbot/api/ask')
    .send({ question: 'How many users?' });

  expect(res.status).toBe(200);
});

// In describe('GET /widget.js') block, add:

it('sets auth cookie when secret is configured', async () => {
  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgres://localhost/test',
    groqApiKey: 'test-key',
    secret: 'my-secret-token',
  }));

  const res = await request(app).get('/chatbot/widget.js');

  const cookies = res.headers['set-cookie'];
  expect(cookies).toBeDefined();
  const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
  expect(cookieStr).toContain('chatbot_token=my-secret-token');
  expect(cookieStr).toContain('HttpOnly');
  expect(cookieStr).toContain('SameSite=Strict');
});

// In describe('POST /api/refresh') block, add:

it('returns 401 on refresh when secret is configured but missing', async () => {
  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({
    databaseUrl: 'postgres://localhost/test',
    groqApiKey: 'test-key',
    secret: 'my-secret-token',
  }));

  const res = await request(app).post('/chatbot/api/refresh');

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'Unauthorized' });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent && npx vitest run src/__tests__/middleware.test.ts`
Expected: FAIL — `secret` not recognized in config, no auth middleware exists.

**Step 3: Add `secret` to AgentConfig**

In `packages/agent/src/config.ts`, add `secret` field:

```typescript
export interface AgentConfig {
  databaseUrl: string;
  codePaths: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  secret?: string;
}

export function resolveConfig(
  userConfig: Partial<AgentConfig> & { databaseUrl: string; groqApiKey?: string }
): AgentConfig {
  if (!userConfig.databaseUrl) {
    throw new Error('databaseUrl is required');
  }

  const llmApiKey =
    userConfig.llmApiKey ||
    userConfig.groqApiKey ||
    process.env.LLM_API_KEY ||
    process.env.GROQ_API_KEY;

  if (!llmApiKey) {
    throw new Error(
      'An LLM API key is required. Provide llmApiKey, groqApiKey, or set LLM_API_KEY / GROQ_API_KEY environment variable.'
    );
  }

  return {
    databaseUrl: userConfig.databaseUrl,
    codePaths: userConfig.codePaths || ['./src'],
    llmBaseUrl: userConfig.llmBaseUrl || process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    llmApiKey,
    llmModel: userConfig.llmModel || process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
    secret: userConfig.secret || process.env.CHATBOT_SECRET || undefined,
  };
}
```

**Step 4: Add auth middleware to `middleware.ts`**

In `packages/agent/src/middleware.ts`, update `sqlChatbot()`:

- Accept `secret` in userConfig type
- Add cookie-setting on `GET /widget.js` when secret is set
- Add auth guard middleware on `/api/ask` and `/api/refresh` that checks:
  1. `Authorization: Bearer <token>` header
  2. `chatbot_token` cookie
- Skip auth if no secret configured

```typescript
import express from 'express';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { initLLM } from './llm/client.js';
import { SchemaService } from './services/schema.js';
import { CodeIndexer } from './services/code-indexer.js';
import { Orchestrator } from './services/orchestrator.js';
import type { AgentConfig } from './config.js';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export function sqlChatbot(
  userConfig: Partial<AgentConfig> & { databaseUrl: string; groqApiKey?: string },
) {
  const router = express.Router();
  const config = resolveConfig(userConfig);

  router.use(express.json());

  // --- Auth guard helper ---
  function requireAuth(req: express.Request, res: express.Response): boolean {
    if (!config.secret) return true; // no secret = no auth
    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${config.secret}`) return true;
    // Check cookie
    const cookies = parseCookies(req.headers.cookie);
    if (cookies['chatbot_token'] === config.secret) return true;
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  // ... (schemaService, codeIndexer, ensureInit stay the same) ...

  // Serve widget bundle — sets auth cookie if secret configured
  router.get('/widget.js', (_req, res) => {
    if (config.secret) {
      res.cookie('chatbot_token', config.secret, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      });
    }
    res.sendFile(path.join(__dirname, '../widget/widget.js'));
  });

  // Health check — no auth needed
  router.get('/api/health', async (_req, res) => { /* unchanged */ });

  // Ask endpoint — auth required
  router.post('/api/ask', async (req, res) => {
    if (!requireAuth(req, res)) return;
    // ... rest unchanged ...
  });

  // Refresh endpoint — auth required
  router.post('/api/refresh', async (_req, res) => {
    if (!requireAuth(_req, res)) return;
    // ... rest unchanged ...
  });

  return router;
}
```

**Step 5: Update mock in middleware.test.ts**

Update the `resolveConfig` mock to pass through the `secret` field:

```typescript
vi.mock('../config.js', () => ({
  resolveConfig: vi.fn((cfg: Record<string, unknown>) => ({
    databaseUrl: cfg.databaseUrl || 'postgres://localhost/test',
    codePaths: cfg.codePaths || ['./src'],
    llmBaseUrl: 'https://api.groq.com/openai/v1',
    llmApiKey: 'test-key',
    llmModel: 'llama-3.3-70b-versatile',
    secret: cfg.secret || undefined,
  })),
}));
```

**Step 6: Run tests to verify they pass**

Run: `cd packages/agent && npx vitest run src/__tests__/middleware.test.ts`
Expected: ALL PASS

**Step 7: Run full test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL 147+ tests PASS (existing tests unchanged since no-secret mode is default)

**Step 8: Commit**

```bash
git add packages/agent/src/config.ts packages/agent/src/middleware.ts packages/agent/src/__tests__/middleware.test.ts
git commit -m "feat: add secret token auth to middleware"
```

---

### Task 2: Create CLI Entry Point

**Files:**
- Create: `packages/agent/src/cli.ts`
- Create: `packages/agent/src/__tests__/cli.test.ts`
- Modify: `packages/agent/package.json`

**Step 1: Write failing tests for CLI**

Create `packages/agent/src/__tests__/cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCliArgs, loadConfigFile, mergeConfig } from '../cli.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('parseCliArgs', () => {
  it('parses --db flag', () => {
    const result = parseCliArgs(['--db', 'postgresql://localhost/test']);
    expect(result.db).toBe('postgresql://localhost/test');
  });

  it('parses --key flag', () => {
    const result = parseCliArgs(['--key', 'gsk_xxx']);
    expect(result.key).toBe('gsk_xxx');
  });

  it('parses --code flag', () => {
    const result = parseCliArgs(['--code', './app']);
    expect(result.code).toBe('./app');
  });

  it('parses --port flag', () => {
    const result = parseCliArgs(['--port', '5000']);
    expect(result.port).toBe('5000');
  });

  it('parses -p as alias for --port', () => {
    const result = parseCliArgs(['-p', '5000']);
    expect(result.port).toBe('5000');
  });

  it('parses --secret flag', () => {
    const result = parseCliArgs(['--secret', 'my-token']);
    expect(result.secret).toBe('my-token');
  });

  it('detects init subcommand', () => {
    const result = parseCliArgs(['init']);
    expect(result.subcommand).toBe('init');
  });

  it('returns undefined for missing flags', () => {
    const result = parseCliArgs([]);
    expect(result.db).toBeUndefined();
    expect(result.key).toBeUndefined();
    expect(result.subcommand).toBeUndefined();
  });
});

describe('loadConfigFile', () => {
  it('loads chatbot.config.json from a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    const configPath = path.join(tmpDir, 'chatbot.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      databaseUrl: 'postgresql://localhost/mydb',
      groqApiKey: 'gsk_test',
      codePaths: ['./models'],
      port: 4000,
      secret: 'file-secret',
    }));

    const config = loadConfigFile(tmpDir);
    expect(config).toEqual({
      databaseUrl: 'postgresql://localhost/mydb',
      groqApiKey: 'gsk_test',
      codePaths: ['./models'],
      port: 4000,
      secret: 'file-secret',
    });

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty object when no config file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    const config = loadConfigFile(tmpDir);
    expect(config).toEqual({});
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('mergeConfig', () => {
  it('CLI flags override env vars which override config file', () => {
    const result = mergeConfig(
      { databaseUrl: 'file-db', groqApiKey: 'file-key', port: 3000 },
      { DATABASE_URL: 'env-db', GROQ_API_KEY: 'env-key', PORT: '4000' },
      { db: 'cli-db' },
    );
    expect(result.databaseUrl).toBe('cli-db');
    expect(result.groqApiKey).toBe('env-key');
    expect(result.port).toBe(4000);
  });

  it('falls back through the priority chain', () => {
    const result = mergeConfig(
      { databaseUrl: 'file-db', groqApiKey: 'file-key', port: 3000 },
      {},
      {},
    );
    expect(result.databaseUrl).toBe('file-db');
    expect(result.groqApiKey).toBe('file-key');
    expect(result.port).toBe(3000);
  });

  it('uses default port 3456 when nothing specified', () => {
    const result = mergeConfig({}, {}, {});
    expect(result.port).toBe(3456);
  });

  it('uses default codePaths ["./src"] when nothing specified', () => {
    const result = mergeConfig({}, {}, {});
    expect(result.codePaths).toEqual(['./src']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent && npx vitest run src/__tests__/cli.test.ts`
Expected: FAIL — `cli.js` doesn't exist.

**Step 3: Create `src/cli.ts`**

```typescript
#!/usr/bin/env node

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { sqlChatbot } from './middleware.js';

// --- Exported for testing ---

export interface CliFlags {
  db?: string;
  key?: string;
  code?: string;
  port?: string;
  secret?: string;
  subcommand?: string;
}

export interface FileConfig {
  databaseUrl?: string;
  groqApiKey?: string;
  codePaths?: string[];
  port?: number;
  secret?: string;
}

export interface MergedConfig {
  databaseUrl?: string;
  groqApiKey?: string;
  codePaths: string[];
  port: number;
  secret?: string;
}

export function parseCliArgs(argv: string[]): CliFlags {
  // Check for subcommand first
  if (argv[0] && !argv[0].startsWith('-')) {
    return { subcommand: argv[0] };
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      key: { type: 'string' },
      code: { type: 'string' },
      port: { type: 'string', short: 'p' },
      secret: { type: 'string' },
    },
    strict: false,
  });

  return values as CliFlags;
}

export function loadConfigFile(dir: string): FileConfig {
  const configPath = path.join(dir, 'chatbot.config.json');
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as FileConfig;
}

export function mergeConfig(
  file: FileConfig,
  env: Record<string, string | undefined>,
  flags: CliFlags,
): MergedConfig {
  return {
    databaseUrl: flags.db || env.DATABASE_URL || file.databaseUrl,
    groqApiKey: flags.key || env.GROQ_API_KEY || file.groqApiKey,
    codePaths: flags.code ? [flags.code] : file.codePaths || ['./src'],
    port: flags.port ? parseInt(flags.port, 10) : env.PORT ? parseInt(env.PORT, 10) : file.port || 3456,
    secret: flags.secret || env.CHATBOT_SECRET || file.secret,
  };
}

// --- Init subcommand ---

function runInit(dir: string): void {
  const configPath = path.join(dir, 'chatbot.config.json');
  if (fs.existsSync(configPath)) {
    console.log('chatbot.config.json already exists, skipping.');
  } else {
    const template = {
      databaseUrl: 'postgresql://user:password@localhost:5432/your_database',
      groqApiKey: 'your-groq-api-key',
      codePaths: ['./src'],
      port: 3456,
      secret: '',
    };
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + '\n');
    console.log('Created chatbot.config.json');
  }

  // Append to .gitignore
  const gitignorePath = path.join(dir, '.gitignore');
  const entry = 'chatbot.config.json';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
      console.log('Added chatbot.config.json to .gitignore');
    } else {
      console.log('chatbot.config.json already in .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
    console.log('Created .gitignore with chatbot.config.json');
  }
}

// --- Main ---

function main(): void {
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.subcommand === 'init') {
    runInit(process.cwd());
    return;
  }

  const fileConfig = loadConfigFile(process.cwd());
  const config = mergeConfig(fileConfig, process.env, flags);

  if (!config.databaseUrl) {
    console.error('Error: Database URL is required.');
    console.error('Provide --db flag, set DATABASE_URL env var, or add databaseUrl to chatbot.config.json');
    process.exit(1);
  }

  if (!config.groqApiKey) {
    console.error('Error: API key is required.');
    console.error('Provide --key flag, set GROQ_API_KEY env var, or add groqApiKey to chatbot.config.json');
    process.exit(1);
  }

  if (!config.secret) {
    console.warn('Warning: No secret configured. The chatbot API is open to anyone.');
    console.warn('Set --secret flag, CHATBOT_SECRET env var, or add secret to chatbot.config.json');
  }

  const app = express();
  app.use(cors());

  app.use('/chatbot', sqlChatbot({
    databaseUrl: config.databaseUrl,
    groqApiKey: config.groqApiKey,
    codePaths: config.codePaths,
    secret: config.secret,
  }));

  // Test page at root
  app.get('/', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>SQL Chatbot</title></head>
<body>
  <h1>SQL Chatbot</h1>
  <p>The chat widget should appear in the bottom-right corner.</p>
  <script src="/chatbot/widget.js"></script>
</body>
</html>`);
  });

  app.listen(config.port, () => {
    console.log(`\nSQL Chatbot Agent running at http://localhost:${config.port}`);
    console.log(`  Chat widget:  http://localhost:${config.port}`);
    console.log(`  Health check: http://localhost:${config.port}/chatbot/api/health`);
    console.log(`  Auth: ${config.secret ? 'enabled' : 'DISABLED (no secret)'}\n`);
  });
}

main();
```

**Step 4: Run CLI tests to verify they pass**

Run: `cd packages/agent && npx vitest run src/__tests__/cli.test.ts`
Expected: ALL PASS

**Step 5: Update `package.json`**

Add `bin` field and `cors` dependency:

```json
{
  "bin": {
    "sql-chatbot-agent": "dist/cli.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.0.0",
    "openai": "^4.0.0",
    "pg": "^8.0.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.0",
    "@types/express": "^4.0.0",
    "@types/node": "^20.0.0",
    "@types/pg": "^8.0.0",
    "@types/supertest": "^7.2.0",
    "supertest": "^7.2.2",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

Also update `files` to include `dist` (which already covers `dist/cli.js`).

Also update `description`:
```
"description": "AI chatbot for any PostgreSQL app — auto-discovers schema, indexes code, executes SQL, streams answers via chat widget. Run with npx or use as Express middleware."
```

**Step 6: Install cors and @types/cors**

Run: `cd packages/agent && npm install cors && npm install -D @types/cors`

**Step 7: Build TypeScript**

Run: `cd packages/agent && npx tsc`
Expected: Clean compile, `dist/cli.js` exists with shebang.

**Step 8: Run full test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL tests PASS

**Step 9: Commit**

```bash
git add packages/agent/src/cli.ts packages/agent/src/__tests__/cli.test.ts packages/agent/package.json packages/agent/package-lock.json
git commit -m "feat: add CLI for standalone server mode"
```

---

### Task 3: Add Init Subcommand Tests

**Files:**
- Modify: `packages/agent/src/__tests__/cli.test.ts`

**Step 1: Add init subcommand tests**

Append to `packages/agent/src/__tests__/cli.test.ts`:

```typescript
import { runInit } from '../cli.js';

describe('runInit', () => {
  it('creates chatbot.config.json with template values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    runInit(tmpDir);

    const configPath = path.join(tmpDir, 'chatbot.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.databaseUrl).toContain('postgresql://');
    expect(config.groqApiKey).toBe('your-groq-api-key');
    expect(config.port).toBe(3456);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('does not overwrite existing chatbot.config.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    const configPath = path.join(tmpDir, 'chatbot.config.json');
    fs.writeFileSync(configPath, '{"custom": true}');

    runInit(tmpDir);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.custom).toBe(true); // unchanged
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('appends to existing .gitignore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n');

    runInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('chatbot.config.json');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates .gitignore if it does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    runInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('chatbot.config.json');
    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

**Step 2: Export `runInit` from cli.ts**

Make sure `runInit` is exported (add `export` keyword to the function).

**Step 3: Run tests**

Run: `cd packages/agent && npx vitest run src/__tests__/cli.test.ts`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/agent/src/cli.ts packages/agent/src/__tests__/cli.test.ts
git commit -m "test: add init subcommand tests"
```

---

### Task 4: Update README

**Files:**
- Modify: `packages/agent/README.md`

**Step 1: Rewrite README to lead with CLI usage**

The README should be restructured:

1. **Quick Start (CLI)** — the primary way, `npx sql-chatbot-agent`
2. **Config file** — `chatbot.config.json` format
3. **Init command** — `npx sql-chatbot-agent init`
4. **Authentication** — secret token setup, `.gitignore` note
5. **Express Middleware** — for advanced users who want to embed
6. **How It Works** — keep existing
7. **API Endpoints** — keep existing
8. **Configuration Reference** — CLI flags, env vars, config file
9. **Security** — update to mention auth
10. Rest stays the same

**Step 2: Commit**

```bash
git add packages/agent/README.md
git commit -m "docs: update README with CLI usage and auth docs"
```

---

### Task 5: Build, Test End-to-End with 2BNCHILL

**Files:** No new files — manual testing.

**Step 1: Build the package**

Run: `cd packages/agent && npm run build`
Expected: Clean compile.

**Step 2: Run full test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL tests PASS.

**Step 3: Test CLI with 2BNCHILL database**

Run:
```bash
cd /home/sotsys-322/2BNCHILL/2BNCHILL-DEV
GROQ_API_KEY=$GROQ_API_KEY \
node "/home/sotsys-322/Ruby Projects/sql-chatbot/packages/agent/dist/cli.js" \
  --db postgresql://postgres:postgres@localhost/twobnchill_development_may8 \
  --code ./app
```

Expected: Server starts, prints URL and health check endpoint.

**Step 4: Test health endpoint**

Run: `curl http://localhost:3456/chatbot/api/health`
Expected: `{"status":"ok","tables":63,...}`

**Step 5: Test via browser with Playwright MCP**

Navigate to `http://localhost:3456`, verify:
- Page loads with title
- Widget appears in bottom-right
- Click widget, ask a question
- SSE streaming works, answer appears

**Step 6: Test with secret**

Restart server with `--secret test123`, verify:
- Widget still works (gets cookie)
- Direct curl without token returns 401
- Direct curl with `Authorization: Bearer test123` works

**Step 7: Commit final state**

```bash
git add -A
git commit -m "feat: CLI standalone mode complete with auth"
```

---

### Task 6: Clean Up Chatbot Test Files from 2BNCHILL

**Files:**
- Delete: `/home/sotsys-322/2BNCHILL/2BNCHILL-DEV/chatbot/` (the Express sidecar we started creating earlier)

**Step 1: Remove leftover files**

```bash
rm -rf /home/sotsys-322/2BNCHILL/2BNCHILL-DEV/chatbot/
```

**Step 2: Verify no stray files**

Run: `ls /home/sotsys-322/2BNCHILL/2BNCHILL-DEV/chatbot/ 2>&1`
Expected: "No such file or directory"
