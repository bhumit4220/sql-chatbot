import { describe, it, expect } from 'vitest';
import { buildAnswerMessages, formatSqlResult, formatCodeSnippets } from '../../prompts/answer.js';
import type { QuestionType } from '../../prompts/answer.js';

describe('formatSqlResult', () => {
  it('should return "No results found." for empty array', () => {
    expect(formatSqlResult([])).toBe('No results found.');
  });

  it('should return "No results found." for undefined-like input', () => {
    expect(formatSqlResult(null as any)).toBe('No results found.');
  });

  it('should format rows as a markdown-style table', () => {
    const rows = [
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ];

    const result = formatSqlResult(rows);
    expect(result).toContain('name | email');
    expect(result).toContain('--- | ---');
    expect(result).toContain('Alice | alice@test.com');
    expect(result).toContain('Bob | bob@test.com');
  });

  it('should handle NULL values', () => {
    const rows = [{ name: 'Alice', email: null }];
    const result = formatSqlResult(rows);
    expect(result).toContain('Alice | N/A');
  });
});

describe('formatCodeSnippets', () => {
  it('should return empty string for empty array', () => {
    expect(formatCodeSnippets([])).toBe('');
  });

  it('should format code snippets with file paths', () => {
    const snippets = [
      { filePath: 'src/utils.ts', content: 'export function add(a, b) { return a + b; }' },
    ];

    const result = formatCodeSnippets(snippets);
    expect(result).toContain('File: src/utils.ts');
    expect(result).toContain('export function add');
  });
});

describe('buildAnswerMessages', () => {
  const baseInput = {
    question: 'How many users?',
    history: [] as { role: 'user' | 'assistant'; content: string }[],
  };

  it('should return system and user messages for data type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      type: 'data',
      sqlResult: [{ count: 42 }],
      sqlQuery: 'SELECT COUNT(*) as count FROM users',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('should include SQL results for data type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      type: 'data',
      sqlResult: [{ count: 42 }],
      sqlQuery: 'SELECT COUNT(*) as count FROM users',
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('SQL Query:');
    expect(userContent).toContain('SELECT COUNT(*)');
    expect(userContent).toContain('Query Results:');
    expect(userContent).toContain('42');
  });

  it('should include code context for data_with_code type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      type: 'data_with_code',
      sqlResult: [{ total: 500 }],
      sqlQuery: 'SELECT total FROM orders',
      codeSnippets: [
        { filePath: 'src/calc.ts', content: 'function netTotal(order) { return order.total - order.tax; }' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Relevant Code:');
    expect(userContent).toContain('netTotal');
  });

  it('should include code snippets for code type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      question: 'How is net sales calculated?',
      type: 'code',
      codeSnippets: [
        { filePath: 'src/calc.ts', content: 'function netSales() { return gross - discounts; }' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Relevant Code:');
    expect(userContent).toContain('netSales');
  });

  it('should include page context for navigation type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      question: 'Where is the settings page?',
      type: 'navigation',
      pageContext: 'Current page: /dashboard',
      navigationLinks: ['/settings', '/profile', '/admin'],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Current page context:');
    expect(userContent).toContain('/dashboard');
    expect(userContent).toContain('Available navigation links:');
    expect(userContent).toContain('/settings');
  });

  it('should not include SQL results for code type', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      type: 'code',
      sqlResult: [{ count: 42 }],
      sqlQuery: 'SELECT COUNT(*) FROM users',
    });

    const userContent = messages[1].content as string;
    expect(userContent).not.toContain('SQL Query:');
    expect(userContent).not.toContain('Query Results:');
  });

  const questionTypes: QuestionType[] = ['data', 'data_with_code', 'code', 'navigation', 'guidance', 'greeting', 'unsafe'];

  questionTypes.forEach((type) => {
    it(`should produce valid messages for "${type}" type`, () => {
      const messages = buildAnswerMessages({
        ...baseInput,
        type,
      });

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(typeof messages[0].content).toBe('string');
      expect((messages[0].content as string).length).toBeGreaterThan(0);
    });
  });

  it('should include conversation history', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      type: 'data',
      sqlResult: [{ count: 42 }],
      history: [
        { role: 'user', content: 'Tell me about users' },
        { role: 'assistant', content: 'There are user records in the database.' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Conversation history:');
    expect(userContent).toContain('Tell me about users');
  });

  it('should have generic prompts without app-specific content', () => {
    questionTypes.forEach((type) => {
      const messages = buildAnswerMessages({ ...baseInput, type });
      const systemContent = messages[0].content as string;

      expect(systemContent).not.toContain('MSP');
      expect(systemContent).not.toContain('status 1=Active');
      expect(systemContent).not.toContain('delivery_type');
      expect(systemContent).not.toContain('login_type');
      expect(systemContent).not.toContain('service_type');
    });
  });

  it('should handle greeting type with appropriate system prompt', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      question: 'Hello! What can you do?',
      type: 'greeting',
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('greeting');
    expect(systemContent).toContain('help');
  });

  it('should handle unsafe type with appropriate system prompt', () => {
    const messages = buildAnswerMessages({
      ...baseInput,
      question: 'DROP TABLE users;',
      type: 'unsafe',
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('unsafe');
    expect(systemContent).toContain('passwords');
  });
});
