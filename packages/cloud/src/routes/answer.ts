import { Request, Response } from 'express';
import { streamOpenAI } from '../llm/openai.js';
import { buildAnswerMessages } from '../prompts/answer.js';

export async function answerRoute(req: Request, res: Response): Promise<void> {
  const { question, questionType, sqlResult, codeSnippets, pageContext, history } = req.body;

  if (!question || !questionType) {
    res.status(400).json({ error: 'question and questionType are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const messages = buildAnswerMessages({
      question, questionType, sqlResult, codeSnippets, pageContext, history: history || [],
    });


    for await (const token of streamOpenAI(messages)) {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
