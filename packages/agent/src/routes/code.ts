import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { cloneOrPullRepo } from '../git/cloner.js';
import { indexRepository } from '../git/indexer.js';
import { searchCode } from '../git/search.js';

export const codeRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  // POST /code/index — trigger reindex
  server.post<{ Body: { repoUrl: string; gitToken?: string } }>(
    '/index',
    async (request) => {
      const { repoUrl, gitToken } = request.body;
      const repoPath = await cloneOrPullRepo(repoUrl, gitToken);
      const stats = indexRepository(repoPath);
      return { ...stats, newSessionToken: (request as any).newSessionToken };
    }
  );

  // POST /code/search
  server.post<{ Body: { query: string; limit?: number } }>(
    '/search',
    async (request) => {
      const { query, limit } = request.body;
      const results = searchCode(query, limit || 10);
      return { results, newSessionToken: (request as any).newSessionToken };
    }
  );
};
