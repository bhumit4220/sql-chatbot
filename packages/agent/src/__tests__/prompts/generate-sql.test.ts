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

  it('should include SOFT DELETE rule in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('SOFT DELETE');
    expect(systemContent).toContain('IS NULL');
  });

  it('should include POLYMORPHIC JOINS rule in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('POLYMORPHIC');
    expect(systemContent).toContain('X_type');
    expect(systemContent).toContain('X_id');
  });

  it('should include LOOKUP VALUES rule in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('FK LOOKUP VALUES');
    expect(systemContent).toContain('FK LOOKUP: column values');
  });

  it('should include ENUM VALUES rule in system prompt', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('ENUM VALUES');
    expect(systemContent).toContain('exact values (case-sensitive)');
    expect(systemContent).toContain('Never guess enum values');
  });

  it('should include lookup hints in user content when provided', () => {
    const hints = [
      "The user mentions 'movies'. In the titles table, use WHERE category_id = 2 (Movie).",
      "The user mentions 'active'. In the contractors table, use WHERE status = 1 (Active).",
    ];

    const messages = buildGenerateSqlMessages({
      question: 'Show me active movies',
      schema: baseSchema,
      history: [],
      lookupHints: hints,
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('IMPORTANT LOOKUP HINTS');
    expect(userContent).toContain('use these exact columns and IDs');
    expect(userContent).toContain(hints[0]);
    expect(userContent).toContain(hints[1]);
    // Hints should appear before the Question line
    const hintsIndex = userContent.indexOf('IMPORTANT LOOKUP HINTS');
    const questionIndex = userContent.indexOf('Question:');
    expect(hintsIndex).toBeLessThan(questionIndex);
  });

  it('should not include lookup hints section when lookupHints is empty', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
      lookupHints: [],
    });

    const userContent = messages[1].content as string;
    expect(userContent).not.toContain('IMPORTANT LOOKUP HINTS');
  });

  it('should not include lookup hints section when lookupHints is not provided', () => {
    const messages = buildGenerateSqlMessages({
      question: 'test',
      schema: baseSchema,
      history: [],
    });

    const userContent = messages[1].content as string;
    expect(userContent).not.toContain('IMPORTANT LOOKUP HINTS');
  });
});
