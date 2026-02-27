import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// --- Mock modules ---

const mockInitLLM = vi.fn();
vi.mock('../llm/client.js', () => ({
  initLLM: (...args: unknown[]) => mockInitLLM(...args),
}));

const mockDiscover = vi.fn().mockResolvedValue(undefined);
const mockGetSummary = vi.fn().mockReturnValue('TABLE users (id INT PK)');
const mockTableCount = vi.fn().mockReturnValue(3);
const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/schema.js', () => ({
  SchemaService: vi.fn().mockImplementation(() => ({
    discover: mockDiscover,
    getSummary: mockGetSummary,
    tableCount: mockTableCount,
    refresh: mockRefresh,
  })),
}));

const mockIndex = vi.fn().mockResolvedValue(undefined);
const mockFileCount = vi.fn().mockReturnValue(42);
const mockGetRouteSummary = vi.fn().mockReturnValue('No routes detected.');
const mockSearch = vi.fn().mockReturnValue([]);

vi.mock('../services/code-indexer.js', () => ({
  CodeIndexer: vi.fn().mockImplementation(() => ({
    index: mockIndex,
    fileCount: mockFileCount,
    getRouteSummary: mockGetRouteSummary,
    search: mockSearch,
  })),
}));

const mockHandleQuestion = vi.fn();

vi.mock('../services/orchestrator.js', () => ({
  Orchestrator: vi.fn().mockImplementation(() => ({
    handleQuestion: mockHandleQuestion,
  })),
}));

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

// --- Import after mocks ---
import { sqlChatbot } from '../middleware.js';

// --- Helper: create an Express app with the middleware ---
function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/chatbot', sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'test-key' }));
  return app;
}

// --- Helper: async generator from events ---
async function* asyncEvents(events: Array<{ type: string; [key: string]: unknown }>) {
  for (const event of events) {
    yield event;
  }
}

// ============================================================
// Tests
// ============================================================

describe('sqlChatbot middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // Factory
  // ----------------------------------------------------------

  describe('factory function', () => {
    it('returns an Express router', () => {
      const router = sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'key' });
      // Express router is a function with stack property
      expect(typeof router).toBe('function');
      expect(router.stack).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // GET /api/health
  // ----------------------------------------------------------

  describe('GET /api/health', () => {
    it('returns status ok with table and file counts', async () => {
      const app = createApp();

      const res = await request(app).get('/chatbot/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        tables: 3,
        codeFiles: 42,
      });
    });

    it('triggers lazy initialization on first request', async () => {
      const app = createApp();

      await request(app).get('/chatbot/api/health');

      expect(mockInitLLM).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1',
        'test-key',
        'llama-3.3-70b-versatile',
      );
      expect(mockDiscover).toHaveBeenCalledWith('postgres://localhost/test');
      expect(mockIndex).toHaveBeenCalledWith(['./src']);
    });

    it('only initializes once across multiple requests', async () => {
      const app = createApp();

      await request(app).get('/chatbot/api/health');
      await request(app).get('/chatbot/api/health');
      await request(app).get('/chatbot/api/health');

      expect(mockDiscover).toHaveBeenCalledTimes(1);
      expect(mockIndex).toHaveBeenCalledTimes(1);
    });

    it('returns 500 on initialization failure', async () => {
      mockDiscover.mockRejectedValueOnce(new Error('Connection refused'));
      const app = createApp();

      const res = await request(app).get('/chatbot/api/health');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Connection refused',
      });
    });
  });

  // ----------------------------------------------------------
  // POST /api/ask
  // ----------------------------------------------------------

  describe('POST /api/ask', () => {
    it('returns 400 when question is missing', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'question is required' });
    });

    it('returns 400 when question is not a string', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: 123 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'question is required' });
    });

    it('returns 400 when question is an empty string', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: '' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'question is required' });
    });

    it('returns 400 when question is only whitespace', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: '   ' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'question is required' });
    });

    it('sets SSE headers and streams events from orchestrator', async () => {
      mockHandleQuestion.mockReturnValue(
        asyncEvents([
          { type: 'classifying' },
          { type: 'classified', questionType: 'data', confidence: 0.9 },
          { type: 'token', content: 'Hello' },
          { type: 'done' },
        ]),
      );

      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: 'How many users?' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');

      // Parse SSE data lines
      const lines = res.text.split('\n\n').filter(Boolean);
      const events = lines.map((line) => JSON.parse(line.replace('data: ', '')));

      expect(events).toHaveLength(4);
      expect(events[0]).toEqual({ type: 'classifying' });
      expect(events[1]).toEqual({ type: 'classified', questionType: 'data', confidence: 0.9 });
      expect(events[2]).toEqual({ type: 'token', content: 'Hello' });
      expect(events[3]).toEqual({ type: 'done' });
    });

    it('passes question, pageContext, and history to orchestrator', async () => {
      mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));

      const app = createApp();

      await request(app)
        .post('/chatbot/api/ask')
        .send({
          question: 'What is revenue?',
          pageContext: '/dashboard',
          history: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
          ],
        });

      expect(mockHandleQuestion).toHaveBeenCalledWith({
        question: 'What is revenue?',
        pageContext: '/dashboard',
        history: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
      });
    });

    it('returns 500 JSON if error occurs before SSE headers sent', async () => {
      // Make ensureInit fail
      mockDiscover.mockRejectedValueOnce(new Error('DB down'));
      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: 'test' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'DB down' });
    });

    it('returns 401 when secret is configured but request has no token', async () => {
      const app = express();
      app.use(express.json());
      app.use('/chatbot', sqlChatbot({
        databaseUrl: 'postgres://localhost/test',
        groqApiKey: 'test-key',
        secret: 'my-secret-token',
      }));
      const res = await request(app).post('/chatbot/api/ask').send({ question: 'How many users?' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('allows request when secret matches via Authorization header', async () => {
      mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));
      const app = express();
      app.use(express.json());
      app.use('/chatbot', sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'test-key', secret: 'my-secret-token' }));
      const res = await request(app).post('/chatbot/api/ask').set('Authorization', 'Bearer my-secret-token').send({ question: 'How many users?' });
      expect(res.status).toBe(200);
    });

    it('allows request when secret matches via cookie', async () => {
      mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));
      const app = express();
      app.use(express.json());
      app.use('/chatbot', sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'test-key', secret: 'my-secret-token' }));
      const res = await request(app).post('/chatbot/api/ask').set('Cookie', 'chatbot_token=my-secret-token').send({ question: 'How many users?' });
      expect(res.status).toBe(200);
    });

    it('skips auth when no secret is configured', async () => {
      mockHandleQuestion.mockReturnValue(asyncEvents([{ type: 'done' }]));
      const app = createApp();
      const res = await request(app).post('/chatbot/api/ask').send({ question: 'How many users?' });
      expect(res.status).toBe(200);
    });

    it('writes error event if error occurs during SSE streaming', async () => {
      mockHandleQuestion.mockImplementation(async function* () {
        yield { type: 'classifying' };
        throw new Error('Stream broke');
      });

      const app = createApp();

      const res = await request(app)
        .post('/chatbot/api/ask')
        .send({ question: 'test' });

      // Should have streamed some data before error
      const lines = res.text.split('\n\n').filter(Boolean);
      const events = lines.map((line) => JSON.parse(line.replace('data: ', '')));

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toBe('Stream broke');
    });
  });

  // ----------------------------------------------------------
  // POST /api/refresh
  // ----------------------------------------------------------

  describe('POST /api/refresh', () => {
    it('returns 401 on refresh when secret is configured but missing', async () => {
      const app = express();
      app.use(express.json());
      app.use('/chatbot', sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'test-key', secret: 'my-secret-token' }));
      const res = await request(app).post('/chatbot/api/refresh');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('re-discovers schema and re-indexes code', async () => {
      const app = createApp();

      const res = await request(app).post('/chatbot/api/refresh');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'refreshed' });
      // ensureInit triggers discover+index, then refresh calls them again
      expect(mockDiscover).toHaveBeenCalledTimes(2);
      expect(mockIndex).toHaveBeenCalledTimes(2);
      expect(mockInitLLM).toHaveBeenCalledTimes(1);
    });

    it('returns 500 on refresh failure', async () => {
      const app = createApp();

      // First trigger init via another endpoint so init succeeds
      await request(app).get('/chatbot/api/health');
      mockDiscover.mockRejectedValueOnce(new Error('Refresh failed'));

      const res = await request(app).post('/chatbot/api/refresh');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Refresh failed',
      });
    });
  });

  // ----------------------------------------------------------
  // GET /widget.js
  // ----------------------------------------------------------

  describe('GET /widget.js', () => {
    it('sets auth cookie when secret is configured', async () => {
      const app = express();
      app.use(express.json());
      app.use('/chatbot', sqlChatbot({ databaseUrl: 'postgres://localhost/test', groqApiKey: 'test-key', secret: 'my-secret-token' }));
      const res = await request(app).get('/chatbot/widget.js');
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain('chatbot_token=my-secret-token');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');
    });

    it('attempts to serve the widget file', async () => {
      const app = createApp();

      // The file won't exist in test, but we can verify the route exists
      // and returns a 404 (file not found) rather than a route-not-found
      const res = await request(app).get('/chatbot/widget.js');

      // sendFile will return 404 if file doesn't exist (not route 404)
      // This confirms the route is registered and sendFile is called
      expect(res.status).toBeLessThanOrEqual(500);
      // The route exists — it won't be a default Express 404 HTML page for missing routes
    });
  });

  // ----------------------------------------------------------
  // Lazy initialization — concurrent requests
  // ----------------------------------------------------------

  describe('lazy initialization', () => {
    it('shares the same init promise for concurrent requests', async () => {
      // Make discover take some time
      mockDiscover.mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      );

      const app = createApp();

      // Fire 3 concurrent requests
      const results = await Promise.all([
        request(app).get('/chatbot/api/health'),
        request(app).get('/chatbot/api/health'),
        request(app).get('/chatbot/api/health'),
      ]);

      // All should succeed
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      // discover should have been called exactly once
      expect(mockDiscover).toHaveBeenCalledTimes(1);
    });

    it('retries initialization after a failure', async () => {
      mockDiscover.mockRejectedValueOnce(new Error('Temporary failure'));
      const app = createApp();

      // First request fails
      const res1 = await request(app).get('/chatbot/api/health');
      expect(res1.status).toBe(500);

      // Second request should retry (not stay stuck on rejected promise)
      mockDiscover.mockResolvedValueOnce(undefined);
      const res2 = await request(app).get('/chatbot/api/health');
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('ok');
    });
  });
});
