import type { FastifyPluginAsync } from 'fastify';

export const setupRoutes: FastifyPluginAsync = async (server) => {
  // POST /setup/configure — first-time setup
  server.post<{
    Body: {
      passphrase: string;
      dbUrl: string;
      gitToken?: string;
      llmApiKey?: string;
    };
  }>('/configure', async (request, reply) => {
    const vault = (server as any).vault;

    if (vault.isConfigured()) {
      return reply.status(400).send({ error: 'Agent already configured. Use /setup/reconfigure.' });
    }

    const { passphrase, dbUrl, gitToken, llmApiKey } = request.body;

    await vault.configure(passphrase, { dbUrl, gitToken, llmApiKey });

    return { configured: true };
  });

  // POST /setup/reconfigure — requires current passphrase
  server.post<{
    Body: {
      currentPassphrase: string;
      newPassphrase?: string;
      dbUrl: string;
      gitToken?: string;
      llmApiKey?: string;
    };
  }>('/reconfigure', async (request, reply) => {
    const vault = (server as any).vault;

    if (!vault.isConfigured()) {
      return reply.status(400).send({ error: 'Agent not configured. Use /setup/configure first.' });
    }

    const { currentPassphrase, newPassphrase, dbUrl, gitToken, llmApiKey } = request.body;

    // Verify current passphrase
    try {
      await vault.unlock(currentPassphrase);
    } catch {
      return reply.status(401).send({ error: 'Invalid current passphrase' });
    }

    // Lock and reconfigure
    vault.lock();
    const sessionManager = (server as any).sessionManager;
    sessionManager.invalidateAll();

    const passphrase = newPassphrase || currentPassphrase;
    await vault.configure(passphrase, { dbUrl, gitToken, llmApiKey });

    return { configured: true };
  });
};
