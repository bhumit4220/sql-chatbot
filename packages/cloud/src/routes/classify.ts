import { Request, Response } from 'express';
import { callOpenAI } from '../llm/openai.js';
import { buildClassifyMessages } from '../prompts/classify.js';

export async function classifyRoute(req: Request, res: Response): Promise<void> {
  const { question, schemaSummary, pageContext, history } = req.body;

  if (!question || !schemaSummary) {
    res.status(400).json({ error: 'question and schemaSummary are required' });
    return;
  }

  try {
    const messages = buildClassifyMessages({ question, schemaSummary, pageContext, history });
    const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
    const parsed = JSON.parse(result);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: `Classification failed: ${err.message}` });
  }
}
