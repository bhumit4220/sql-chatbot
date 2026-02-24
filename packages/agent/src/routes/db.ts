import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { inspectSchema, formatSchemaForPrompt } from '../db/schema-inspector.js';
import { executeSQL } from '../db/sql-executor.js';
import { getPool } from '../db/connection.js';

export const dbRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  server.get('/schema', async (request) => {
    const pool = getPool();
    const tables = await inspectSchema(pool);
    return { tables, newSessionToken: (request as any).newSessionToken };
  });

  server.post<{ Body: { sql: string } }>('/query', async (request) => {
    const pool = getPool();
    const tables = await inspectSchema(pool);
    const schemaMap: Record<string, string[]> = {};
    for (const t of tables) {
      schemaMap[t.name] = t.columns.map(c => c.name);
    }
    const result = await executeSQL(pool, request.body.sql, schemaMap);
    return { ...result, newSessionToken: (request as any).newSessionToken };
  });

  server.get('/health', async (request) => {
    const pool = getPool();
    const start = performance.now();
    try {
      await pool.query('SELECT 1');
      return {
        connected: true,
        latencyMs: Math.round(performance.now() - start),
        newSessionToken: (request as any).newSessionToken,
      };
    } catch {
      return { connected: false, latencyMs: 0, newSessionToken: (request as any).newSessionToken };
    }
  });
};
