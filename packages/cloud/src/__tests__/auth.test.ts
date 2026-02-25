import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyAuth } from '../middleware/auth.js';
import { initApiKeyDb, addApiKey } from '../db/api-keys.js';

describe('API Key Auth Middleware', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    initApiKeyDb(':memory:');
    app.use(apiKeyAuth);
    app.get('/test', (req, res) => res.json({ ok: true }));
  });

  it('rejects requests without Authorization header', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing API key');
  });

  it('rejects invalid API keys', async () => {
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer invalid-key');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('allows valid API keys', async () => {
    addApiKey('test-key-123', 'test-customer');
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
