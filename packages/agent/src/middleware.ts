import express from 'express';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { initLLM } from './llm/client.js';
import { SchemaService } from './services/schema.js';
import { CodeIndexer } from './services/code-indexer.js';
import { Orchestrator } from './services/orchestrator.js';
import type { AgentConfig } from './config.js';

export function sqlChatbot(
  userConfig: Partial<AgentConfig> & { databaseUrl: string; groqApiKey?: string },
) {
  const router = express.Router();
  const config = resolveConfig(userConfig);

  // Parse JSON bodies for POST routes
  router.use(express.json());

  const schemaService = new SchemaService();
  const codeIndexer = new CodeIndexer();
  let orchestrator: Orchestrator;

  // Lazy init on first request
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  async function ensureInit(): Promise<void> {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        initLLM(config.llmBaseUrl, config.llmApiKey, config.llmModel);
        await schemaService.discover(config.databaseUrl);
        await codeIndexer.index(config.codePaths);
        orchestrator = new Orchestrator({ schemaService, codeIndexer, databaseUrl: config.databaseUrl });
        initialized = true;
      } catch (err) {
        // Reset so next request can retry initialization
        initPromise = null;
        throw err;
      }
    })();
    return initPromise;
  }

  // Serve widget bundle
  router.get('/widget.js', (_req, res) => {
    res.sendFile(path.join(__dirname, '../widget/widget.js'));
  });

  // Health check
  router.get('/api/health', async (_req, res) => {
    try {
      await ensureInit();
      res.json({
        status: 'ok',
        tables: schemaService.tableCount(),
        codeFiles: codeIndexer.fileCount(),
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Ask endpoint — SSE streaming
  router.post('/api/ask', async (req, res) => {
    try {
      await ensureInit();

      const { question, pageContext, history } = req.body;
      if (typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'question is required' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      for await (const event of orchestrator.handleQuestion({ question, pageContext, history })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      } else {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) })}\n\n`,
        );
        res.end();
      }
    }
  });

  // Refresh endpoint
  router.post('/api/refresh', async (_req, res) => {
    try {
      await ensureInit();
      await schemaService.discover(config.databaseUrl);
      await codeIndexer.index(config.codePaths);
      res.json({ status: 'refreshed' });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
