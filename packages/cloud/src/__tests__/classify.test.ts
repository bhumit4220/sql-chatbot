import { describe, it, expect } from 'vitest';
import { buildClassifyMessages } from '../prompts/classify.js';

describe('Classify Prompt Builder', () => {
  it('builds classify messages with schema summary', () => {
    const messages = buildClassifyMessages({
      question: 'How many active customers?',
      schemaSummary: 'TABLE customers (id, name, status, created_at)',
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content as string).toContain('Classify');
    expect(messages[1].role).toBe('user');
    expect((messages[1].content as string)).toContain('How many active customers?');
    expect((messages[1].content as string)).toContain('TABLE customers');
  });

  it('includes page context when provided', () => {
    const messages = buildClassifyMessages({
      question: 'Where is the settings page?',
      schemaSummary: 'TABLE users (id)',
      pageContext: 'Nav: [Dashboard, Settings, Users]',
    });
    expect((messages[1].content as string)).toContain('Nav: [Dashboard, Settings, Users]');
  });
});
