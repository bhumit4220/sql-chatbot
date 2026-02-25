import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Mock OpenAI before importing anything that uses it
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(async (opts: any) => {
            if (opts.stream) {
              // Return an async iterable for streaming
              return (async function* () {
                yield { choices: [{ delta: { content: 'Hello ' } }] };
                yield { choices: [{ delta: { content: 'world!' } }] };
              })();
            }
            // Non-streaming: return based on the messages content
            const allContent = opts.messages?.map((m: any) => m.content || '').join(' ') || '';
            if (opts.response_format?.type === 'json_object') {
              // Check if it's a generate-sql request (has DATABASE SCHEMA in context)
              if (allContent.includes('DATABASE SCHEMA:')) {
                return {
                  choices: [{ message: { content: JSON.stringify({ sql: 'SELECT COUNT(*) FROM customers WHERE status = 1' }) } }],
                };
              }
              // Otherwise classify
              return {
                choices: [{ message: { content: JSON.stringify({ type: 'data', confidence: 0.95 }) } }],
              };
            }
            // Default
            return {
              choices: [{ message: { content: JSON.stringify({ type: 'data', confidence: 0.9 }) } }],
            };
          }),
        },
      };
    },
  };
});

import { app } from '../server.js';
import { initApiKeyDb, addApiKey } from '../db/api-keys.js';

describe('Cloud Server Integration', () => {
  beforeAll(() => {
    initApiKeyDb(':memory:');
    addApiKey('integration-test-key', 'test-customer');
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('POST /api/v1/classify', () => {
    it('returns 401 without API key', async () => {
      const res = await request(app)
        .post('/api/v1/classify')
        .send({ question: 'test', schemaSummary: 'TABLE t (id)' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Missing API key');
    });

    it('returns 401 with invalid API key', async () => {
      const res = await request(app)
        .post('/api/v1/classify')
        .set('Authorization', 'Bearer bad-key')
        .send({ question: 'test', schemaSummary: 'TABLE t (id)' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid API key');
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/classify')
        .set('Authorization', 'Bearer integration-test-key')
        .send({ question: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns classification with valid request', async () => {
      const res = await request(app)
        .post('/api/v1/classify')
        .set('Authorization', 'Bearer integration-test-key')
        .send({ question: 'How many active customers?', schemaSummary: 'TABLE customers (id, status)' });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('data');
      expect(res.body.confidence).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/generate-sql', () => {
    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/generate-sql')
        .set('Authorization', 'Bearer integration-test-key')
        .send({ question: 'test' });
      expect(res.status).toBe(400);
    });

    it('returns SQL with valid request', async () => {
      const res = await request(app)
        .post('/api/v1/generate-sql')
        .set('Authorization', 'Bearer integration-test-key')
        .send({
          question: 'How many active customers?',
          schema: 'TABLE customers (id INT, status INT)',
          enums: 'customers.status: 1=Active',
          discoveredContext: '',
          history: [],
        });
      expect(res.status).toBe(200);
      expect(res.body.sql).toContain('SELECT');
    });
  });

  describe('POST /api/v1/answer', () => {
    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/answer')
        .set('Authorization', 'Bearer integration-test-key')
        .send({ question: 'test' });
      expect(res.status).toBe(400);
    });

    it('returns SSE stream with valid request', async () => {
      const res = await request(app)
        .post('/api/v1/answer')
        .set('Authorization', 'Bearer integration-test-key')
        .send({
          question: 'How many active customers?',
          questionType: 'data',
          sqlResult: '{"columns":["count"],"rows":[{"count":342}]}',
          history: [],
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // SSE body should contain data events and [DONE]
      expect(res.text).toContain('data:');
      expect(res.text).toContain('[DONE]');
    });
  });
});
