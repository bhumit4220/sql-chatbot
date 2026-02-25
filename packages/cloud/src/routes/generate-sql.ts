import { Request, Response } from 'express';
import { callOpenAI } from '../llm/openai.js';
import { buildGenerateSqlMessages } from '../prompts/generate-sql.js';

export async function generateSqlRoute(req: Request, res: Response): Promise<void> {
  const { question, schema, enums, discoveredContext, codeContext, history, retryWithContext } = req.body;

  if (!question || !schema) {
    res.status(400).json({ error: 'question and schema are required' });
    return;
  }

  try {
    const messages = buildGenerateSqlMessages({
      question, schema, enums: enums || '', discoveredContext: discoveredContext || '',
      codeContext, history: history || [], retryWithContext,
    });
    const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
    const parsed = JSON.parse(result);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: `SQL generation failed: ${err.message}` });
  }
}
