import type { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { OpenAIEngine } from '../llm/openai-engine.js';

let llm: OpenAIEngine | null = null;

export function initLLM(apiKey: string): void {
  llm = new OpenAIEngine(apiKey);
}

function getLLM(): OpenAIEngine {
  if (!llm) throw new Error('LLM engine not initialized. Unlock vault first.');
  return llm;
}

export const llmRoutes: FastifyPluginAsync = async (server) => {
  server.addHook('preHandler', authMiddleware);

  // POST /llm/classify
  server.post<{ Body: { question: string; schemaSummary: string; pageContext?: string; history: any[] } }>(
    '/classify',
    async (request) => {
      const { question, schemaSummary, pageContext, history } = request.body;
      const result = await getLLM().classify(question, { schemaSummary, pageContext, history });
      return { ...result, newSessionToken: (request as any).newSessionToken };
    }
  );

  // POST /llm/generate-sql
  server.post<{ Body: { question: string; schema: string; codeContext?: string; enums?: string; history: any[] } }>(
    '/generate-sql',
    async (request) => {
      const { question, schema, codeContext, enums, history } = request.body;
      const result = await getLLM().generateSQL(question, { schema, codeContext, enums, history });
      return { ...result, newSessionToken: (request as any).newSessionToken };
    }
  );

  // POST /llm/answer — SSE stream
  server.post<{ Body: { question: string; sqlResults?: string; questionType: string; history: any[]; pageContext?: string } }>(
    '/answer',
    async (request, reply) => {
      const { question, sqlResults, questionType, pageContext, history } = request.body;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-New-Session-Token': (request as any).newSessionToken || '',
      });

      for await (const chunk of getLLM().streamAnswer(question, {
        question,
        sqlResults: sqlResults || '',
        questionType: questionType as any,
        pageContext,
        history,
      })) {
        reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  );

  // POST /llm/answer-from-code — SSE stream
  server.post<{ Body: { question: string; codeChunks: any[]; history: any[]; pageContext?: string } }>(
    '/answer-from-code',
    async (request, reply) => {
      const { question, codeChunks, pageContext, history } = request.body;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-New-Session-Token': (request as any).newSessionToken || '',
      });

      for await (const chunk of getLLM().streamAnswerFromCode(question, {
        question,
        codeChunks,
        pageContext,
        history,
      })) {
        reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  );
};
