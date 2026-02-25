import type { FastifyPluginAsync } from 'fastify';
import { createPool, closePool } from '../db/connection.js';
import { initLLM } from '../routes/llm.js';

export const authRoutes: FastifyPluginAsync = async (server) => {
  // GET /auth/status — no auth required
  server.get('/status', async () => {
    const vault = (server as any).vault;
    return {
      locked: !vault.isUnlocked(),
      configured: vault.isConfigured(),
      agentVersion: '2.0.0',
    };
  });

  // POST /auth/unlock
  server.post<{ Body: { passphrase: string } }>('/unlock', async (request, reply) => {
    const vault = (server as any).vault;
    const sessionManager = (server as any).sessionManager;
    const { passphrase } = request.body;

    if (!vault.isConfigured()) {
      return reply.status(400).send({ error: 'Agent not configured. Visit /setup first.' });
    }

    try {
      await vault.unlock(passphrase);
    } catch {
      return reply.status(401).send({ error: 'Invalid passphrase' });
    }

    // Initialize DB pool and LLM engine with secrets from the vault
    const dbUrl = vault.getSecret('dbUrl');
    if (dbUrl) createPool(dbUrl);
    const apiKey = vault.getSecret('llmApiKey');
    if (apiKey) initLLM(apiKey);

    const origin = request.headers.origin || (request.headers['x-extension-id'] as string) || '';
    const session = sessionManager.createSession(origin);

    return {
      sessionToken: session.token,
      expiresAt: session.expiresAt.toISOString(),
      extensionId: origin,
    };
  });

  // POST /auth/lock
  server.post('/lock', async () => {
    const vault = (server as any).vault;
    const sessionManager = (server as any).sessionManager;
    await closePool();
    vault.lock();
    sessionManager.invalidateAll();
    return { locked: true };
  });
};
