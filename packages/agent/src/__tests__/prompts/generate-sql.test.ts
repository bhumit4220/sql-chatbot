import { describe, it, expect } from 'vitest';
import { buildGenerateSqlMessages } from '../../prompts/generate-sql.js';

describe('buildGenerateSqlMessages', () => {
  const baseSchema = 'Table: users (id, name, email, created_at)\nTable: orders (id, user_id, total, status)';

  it('should return system and user messages', () => {
    const messages = buildGenerateSqlMessages({
      question: 'How many users are there?',
      schema: baseSchema,
      history: [],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('should include the question in user content', () => {
    const messages = buildGenerateSqlMessages({
      question: 'List all orders over $100',
      schema: baseSchema,
      history: [],
    });

    expect(messages[1].content).toContain('List all orders over $100');
  });

  it('should include schema in user content', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    expect(messages[1].content).toContain(baseSchema);
  });

  it('should include SQL generation rules in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('SELECT');
    expect(systemContent).toContain('LIMIT 100');
    expect(systemContent).toContain('JOIN');
  });

  it('should enforce SELECT-only in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('ONLY generate SELECT statements');
    expect(systemContent).toContain('never INSERT, UPDATE, DELETE, DROP');
  });

  it('should include code context when provided', () => {
    const messages = buildGenerateSqlMessages({
      question: 'What is the net sales?',
      schema: baseSchema,
      codeContext: 'function netSales(order) { return order.total - order.discount; }',
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('RELEVANT CODE CONTEXT');
    expect(systemContent).toContain('netSales');
  });

  it('should not include code context section when not provided', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).not.toContain('RELEVANT CODE CONTEXT');
  });

  it('should include conversation history when provided', () => {
    const messages = buildGenerateSqlMessages({
      question: 'And their totals?',
      schema: baseSchema,
      history: [
        { role: 'user', content: 'Show me all orders' },
        { role: 'assistant', content: 'Here are the orders...' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Conversation history:');
    expect(userContent).toContain('Show me all orders');
  });

  it('should request JSON response format', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('Respond with JSON only');
    expect(systemContent).toContain('"sql"');
    expect(systemContent).toContain('"explanation"');
  });
});
