import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiKeyAuth } from './middleware/auth.js';
import { apiRateLimiter } from './middleware/rate-limit.js';
import { initApiKeyDb } from './db/api-keys.js';
import { initOpenAI } from './llm/openai.js';
import { classifyRoute } from './routes/classify.js';
import { generateSqlRoute } from './routes/generate-sql.js';

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

// Routes
app.post('/api/v1/classify', classifyRoute);
app.post('/api/v1/generate-sql', generateSqlRoute);
app.post('/api/v1/answer', (_req, res) => res.status(501).json({ error: 'Not implemented' }));

export function startServer() {
  const dbPath = process.env.API_KEYS_DB || './data/api-keys.sqlite3';
  initApiKeyDb(dbPath);
  initOpenAI();
  app.listen(PORT, () => console.log(`Cloud LLM service listening on :${PORT}`));
}

export { app };

// Start if run directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  startServer();
}
