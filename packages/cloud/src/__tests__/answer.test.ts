import { describe, it, expect } from 'vitest';
import { buildAnswerMessages } from '../prompts/answer.js';

describe('Answer Prompt Builder', () => {
  it('builds data answer with SQL result', () => {
    const messages = buildAnswerMessages({
      question: 'How many active customers?',
      questionType: 'data',
      sqlResult: JSON.stringify({ columns: ['count'], rows: [{ count: 342 }] }),
      history: [],
    });
    expect((messages[0].content as string)).toContain('Trust the query results');
    expect((messages[1].content as string)).toContain('342');
  });

  it('builds code answer with snippets', () => {
    const messages = buildAnswerMessages({
      question: 'How is net sales calculated?',
      questionType: 'code',
      codeSnippets: 'File: app/models/job.rb:45\ndef net_sales\n  total - discount\nend',
      history: [],
    });
    expect((messages[0].content as string)).toContain('code');
    expect((messages[1].content as string)).toContain('net_sales');
  });

  it('builds navigation answer with page context', () => {
    const messages = buildAnswerMessages({
      question: 'Where is user management?',
      questionType: 'navigation',
      pageContext: 'Nav: [Dashboard (/), Users (/admin/users), Settings (/admin/settings)]',
      history: [],
    });
    expect((messages[1].content as string)).toContain('/admin/users');
  });

  it('includes conversation history', () => {
    const messages = buildAnswerMessages({
      question: 'How many of them are active?',
      questionType: 'data',
      sqlResult: '{"columns":["count"],"rows":[{"count":100}]}',
      history: [
        { role: 'user', content: 'How many customers?' },
        { role: 'assistant', content: 'There are 500 customers.' },
      ],
    });
    // History should appear before the current question
    expect(messages.length).toBeGreaterThan(2);
    const historyMsg = messages.find(m => (m.content as string).includes('500 customers'));
    expect(historyMsg).toBeDefined();
  });
});
