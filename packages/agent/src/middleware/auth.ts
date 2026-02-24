import type { FastifyRequest, FastifyReply } from 'fastify';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
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

  // Attach new token to response
  (request as any).newSessionToken = result.newToken;
}
