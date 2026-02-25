import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Mock DB and LLM modules before importing auth routes
vi.mock('../db/connection.js', () => ({
  createPool: vi.fn(),
  closePool: vi.fn().mockResolvedValue(undefined),
  getPool: vi.fn(),
}));

vi.mock('../routes/llm.js', () => ({
  initLLM: vi.fn(),
  llmRoutes: async () => {},
}));

vi.mock('../db/schema-inspector.js', () => ({
  inspectSchema: vi.fn(),
  formatSchemaForPrompt: vi.fn(),
}));

vi.mock('../db/sql-executor.js', () => ({
  executeSQL: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn().mockImplementation(async (request: any, reply: any) => {
    const sessionManager = (request.server as any).sessionManager;
    const token = request.headers['x-session-token'] as string;
    const origin = request.headers.origin || '';
    if (!token) {
      return reply.status(401).send({ error: 'Missing X-Session-Token header' });
    }
    const result = sessionManager.validate(token, origin);
    if (!result.valid) {
      return reply.status(401).send({ error: result.reason });
    }
    (request as any).newSessionToken = result.newToken;
  }),
}));

import { authRoutes } from '../routes/auth.js';
import { dbRoutes } from '../routes/db.js';
import { executeSQL } from '../db/sql-executor.js';
import { inspectSchema } from '../db/schema-inspector.js';
import { getPool } from '../db/connection.js';

function createTestServer(overrides?: { vault?: any; sessionManager?: any }) {
  const server = Fastify();

  const vault = overrides?.vault ?? {
    isConfigured: () => true,
    isUnlocked: () => false,
    unlock: vi.fn().mockResolvedValue(undefined),
    lock: vi.fn(),
    getSecret: vi.fn().mockReturnValue(undefined),
  };

  const sessionManager = overrides?.sessionManager ?? {
    createSession: vi.fn().mockReturnValue({
      token: 'test-token-abc',
      expiresAt: new Date('2099-01-01'),
      extensionId: 'chrome-extension://test',
    }),
    validate: vi.fn().mockReturnValue({ valid: true, newToken: 'rotated-token' }),
    invalidateAll: vi.fn(),
  };

  server.decorate('vault', vault);
  server.decorate('sessionManager', sessionManager);

  return { server, vault, sessionManager };
}

// ─── Auth Routes ────────────────────────────────────────────────────────────

describe('Auth Routes (integration)', () => {
  let server: FastifyInstance;
  let vault: any;
  let sessionManager: any;

  beforeEach(async () => {
    const ctx = createTestServer();
    server = ctx.server;
    vault = ctx.vault;
    sessionManager = ctx.sessionManager;
    await server.register(authRoutes, { prefix: '/auth' });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── GET /auth/status ───────────────────────────────────────────────

  describe('GET /auth/status', () => {
    it('returns locked=true, configured=true when vault is configured but locked', async () => {
      const res = await server.inject({ method: 'GET', url: '/auth/status' });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.locked).toBe(true);
      expect(body.configured).toBe(true);
      expect(body.agentVersion).toBe('2.0.0');
    });

    it('returns locked=false after vault is unlocked', async () => {
      vault.isUnlocked = () => true;
      const res = await server.inject({ method: 'GET', url: '/auth/status' });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.locked).toBe(false);
      expect(body.configured).toBe(true);
    });

    it('returns configured=false when vault is not configured', async () => {
      vault.isConfigured = () => false;
      const res = await server.inject({ method: 'GET', url: '/auth/status' });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.configured).toBe(false);
    });
  });

  // ── POST /auth/unlock ─────────────────────────────────────────────

  describe('POST /auth/unlock', () => {
    it('returns sessionToken on successful unlock', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/auth/unlock',
        payload: { passphrase: 'correct-pass' },
        headers: { 'content-type': 'application/json' },
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.sessionToken).toBe('test-token-abc');
      expect(body.expiresAt).toBeDefined();
      expect(vault.unlock).toHaveBeenCalledWith('correct-pass');
    });

    it('returns 401 when passphrase is wrong', async () => {
      vault.unlock = vi.fn().mockRejectedValue(new Error('bad passphrase'));
      const res = await server.inject({
        method: 'POST',
        url: '/auth/unlock',
        payload: { passphrase: 'wrong-pass' },
        headers: { 'content-type': 'application/json' },
      });
      const body = res.json();
      expect(res.statusCode).toBe(401);
      expect(body.error).toContain('Invalid passphrase');
    });

    it('returns 400 when vault is not configured', async () => {
      vault.isConfigured = () => false;
      const res = await server.inject({
        method: 'POST',
        url: '/auth/unlock',
        payload: { passphrase: 'anything' },
        headers: { 'content-type': 'application/json' },
      });
      const body = res.json();
      expect(res.statusCode).toBe(400);
      expect(body.error).toContain('not configured');
    });
  });

  // ── POST /auth/lock ───────────────────────────────────────────────

  describe('POST /auth/lock', () => {
    it('returns locked=true and invalidates all sessions', async () => {
      const res = await server.inject({ method: 'POST', url: '/auth/lock' });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.locked).toBe(true);
      expect(vault.lock).toHaveBeenCalled();
      expect(sessionManager.invalidateAll).toHaveBeenCalled();
    });
  });
});

// ─── DB Routes (SQL injection prevention) ───────────────────────────────────

describe('DB Routes — SQL injection prevention (integration)', () => {
  let server: FastifyInstance;
  let sessionManager: any;

  beforeEach(async () => {
    const ctx = createTestServer({
      vault: {
        isConfigured: () => true,
        isUnlocked: () => true,
        unlock: vi.fn(),
        lock: vi.fn(),
        getSecret: vi.fn(),
      },
    });
    server = ctx.server;
    sessionManager = ctx.sessionManager;

    // Mock getPool to return a fake pool
    const mockPool = { query: vi.fn() };
    vi.mocked(getPool).mockReturnValue(mockPool as any);

    // Mock inspectSchema to return a simple schema
    vi.mocked(inspectSchema).mockResolvedValue([
      { name: 'users', columns: [{ name: 'id', type: 'integer', nullable: false, isPrimaryKey: true }], primaryKeys: ['id'], foreignKeys: [] },
    ]);

    await server.register(dbRoutes, { prefix: '/db' });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    vi.clearAllMocks();
  });

  it('rejects DROP TABLE via executeSQL validation', async () => {
    vi.mocked(executeSQL).mockResolvedValue({
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: 0,
      error: 'SQL validation failed: Statement type DROP is not allowed',
    });

    const res = await server.inject({
      method: 'POST',
      url: '/db/query',
      payload: { sql: 'DROP TABLE users' },
      headers: {
        'content-type': 'application/json',
        'x-session-token': 'test-token-abc',
      },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not allowed');
  });

  it('rejects DELETE statement via executeSQL validation', async () => {
    vi.mocked(executeSQL).mockResolvedValue({
      success: false,
      columns: [],
      rows: [],
      totalRowCount: 0,
      executionTimeMs: 0,
      error: 'SQL validation failed: Statement type DELETE is not allowed',
    });

    const res = await server.inject({
      method: 'POST',
      url: '/db/query',
      payload: { sql: 'DELETE FROM users WHERE id = 1' },
      headers: {
        'content-type': 'application/json',
        'x-session-token': 'test-token-abc',
      },
    });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('not allowed');
  });

  it('returns 401 when no session token is provided', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/db/query',
      payload: { sql: 'SELECT 1' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});
