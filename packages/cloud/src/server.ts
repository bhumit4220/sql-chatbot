import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiKeyAuth } from './middleware/auth.js';
import { apiRateLimiter } from './middleware/rate-limit.js';
import { initApiKeyDb } from './db/api-keys.js';

const app = express();
const PORT = process.env.PORT || 3100;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Public health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Authenticated routes
app.use('/api/v1/', apiRateLimiter);
app.use('/api/v1/', apiKeyAuth);

// Route stubs — will be replaced in Tasks 2.2-2.4
app.post('/api/v1/classify', (_req, res) => res.status(501).json({ error: 'Not implemented' }));
app.post('/api/v1/generate-sql', (_req, res) => res.status(501).json({ error: 'Not implemented' }));
app.post('/api/v1/answer', (_req, res) => res.status(501).json({ error: 'Not implemented' }));

export function startServer() {
  const dbPath = process.env.API_KEYS_DB || './data/api-keys.sqlite3';
  initApiKeyDb(dbPath);
  app.listen(PORT, () => console.log(`Cloud LLM service listening on :${PORT}`));
}

export { app };

// Start if run directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  startServer();
}
