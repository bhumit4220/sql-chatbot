import { describe, it, expect } from 'vitest';
import { buildClassifyMessages } from '../../prompts/classify.js';

describe('buildClassifyMessages', () => {
  const baseSchemaSummary = 'Table: users (id, name, email, created_at)\nTable: orders (id, user_id, total, status)';

  it('should return system and user messages', () => {
    const messages = buildClassifyMessages({
      question: 'How many users are there?',
      schemaSummary: baseSchemaSummary,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('should include the question in user content', () => {
    const messages = buildClassifyMessages({
      question: 'How many users are there?',
      schemaSummary: baseSchemaSummary,
    });

    expect(messages[1].content).toContain('How many users are there?');
  });

  it('should include schema summary in user content', () => {
    const messages = buildClassifyMessages({
      question: 'How many users?',
      schemaSummary: baseSchemaSummary,
    });

    expect(messages[1].content).toContain(baseSchemaSummary);
  });

  it('should include all classification types in system prompt', () => {
    const messages = buildClassifyMessages({
      question: 'test',
      schemaSummary: baseSchemaSummary,
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).toContain('"data"');
    expect(systemContent).toContain('"data_with_code"');
    expect(systemContent).toContain('"code"');
    expect(systemContent).toContain('"navigation"');
    expect(systemContent).toContain('"guidance"');
    expect(systemContent).toContain('"unsafe"');
  });

  it('should include conversation history when provided', () => {
    const messages = buildClassifyMessages({
      question: 'How many?',
      schemaSummary: baseSchemaSummary,
      history: [
        { role: 'user', content: 'Tell me about users' },
        { role: 'assistant', content: 'There are various user records in the database.' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Conversation history:');
    expect(userContent).toContain('Tell me about users');
  });

  it('should only include last 4 history messages', () => {
    const messages = buildClassifyMessages({
      question: 'latest?',
      schemaSummary: baseSchemaSummary,
      history: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'reply3' },
      ],
    });

    const userContent = messages[1].content as string;
    expect(userContent).not.toContain('msg1');
    expect(userContent).not.toContain('reply1');
    expect(userContent).toContain('msg2');
    expect(userContent).toContain('reply3');
  });

  it('should include page context when provided', () => {
    const messages = buildClassifyMessages({
      question: 'Where is the settings page?',
      schemaSummary: baseSchemaSummary,
      pageContext: 'Current page: /dashboard',
    });

    const userContent = messages[1].content as string;
    expect(userContent).toContain('Current page context:');
    expect(userContent).toContain('/dashboard');
  });

  it('should not include page context section when not provided', () => {
    const messages = buildClassifyMessages({
      question: 'How many users?',
      schemaSummary: baseSchemaSummary,
    });

    const userContent = messages[1].content as string;
    expect(userContent).not.toContain('Current page context:');
  });

  it('should not contain app-specific references', () => {
    const messages = buildClassifyMessages({
      question: 'test',
      schemaSummary: baseSchemaSummary,
    });

    const systemContent = messages[0].content as string;
    expect(systemContent).not.toContain('MSP');
    expect(systemContent).not.toContain('msp');
    expect(systemContent).not.toContain('service_type');
    expect(systemContent).not.toContain('login_type');
  });
});
