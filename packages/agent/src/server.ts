import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AGENT_HOST, AGENT_PORT, RATE_LIMIT_PER_MINUTE } from '@chatbot/shared';
import { Vault } from './vault/index.js';
import { SessionManager } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { codeRoutes } from './routes/code.js';
import { discoveryRoutes } from './routes/discovery.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.chatbot-agent');

export async function buildServer() {
  const vault = new Vault(DATA_DIR);
  const sessionManager = new SessionManager();

  const server = Fastify({ logger: true });

  // CORS: only allow chrome-extension:// origins
  await server.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin.startsWith('chrome-extension://')) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed'), false);
      }
    },
  });

  // Rate limiting
  await server.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
  });

  // Decorate with shared state
  server.decorate('vault', vault);
  server.decorate('sessionManager', sessionManager);

  // Public routes (no auth required)
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(setupRoutes, { prefix: '/setup' });

  // Protected routes
  // server.register(dbRoutes, { prefix: '/db' });
  // server.register(llmRoutes, { prefix: '/llm' });
  await server.register(codeRoutes, { prefix: '/code' });
  await server.register(discoveryRoutes, { prefix: '/discovery' });

  return server;
}

// Start server if run directly
const server = await buildServer();
server.listen({ host: AGENT_HOST, port: AGENT_PORT }, (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  console.log(`Agent listening on ${address}`);
});
