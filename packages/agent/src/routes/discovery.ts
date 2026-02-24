import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { getState, getResults, runDiscovery, applyOverride } from '../discovery/pipeline.js';
import { getPool } from '../db/connection.js';

export const discoveryRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  // GET /discovery/status
  server.get('/status', async (request) => {
    return { ...getState(), newSessionToken: (request as any).newSessionToken };
  });

  // POST /discovery/run — trigger discovery pipeline
  server.post('/run', async (request) => {
    const pool = getPool();
    // Run async — don't block the response
    runDiscovery(pool).catch(err => {
      console.error('Discovery failed:', err);
    });
    return { started: true, newSessionToken: (request as any).newSessionToken };
  });

  // GET /discovery/results
  server.get('/results', async (request) => {
    const results = getResults();
    return { ...results, newSessionToken: (request as any).newSessionToken };
  });

  // POST /discovery/override
  server.post<{
    Body: {
      type: 'enum' | 'relationship' | 'business_term';
      table: string;
      column?: string;
      corrections: Record<string, string>;
    };
  }>('/override', async (request) => {
    applyOverride(request.body);
    return { applied: true, newSessionToken: (request as any).newSessionToken };
  });
};
