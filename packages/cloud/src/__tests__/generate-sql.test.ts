import { describe, it, expect } from 'vitest';
import { buildGenerateSqlMessages } from '../prompts/generate-sql.js';

describe('Generate SQL Prompt Builder', () => {
  it('includes schema, enums, and discovered context', () => {
    const messages = buildGenerateSqlMessages({
      question: 'How many active customers?',
      schema: 'TABLE customers (id INT, name TEXT, status INT, created_at TIMESTAMP)',
      enums: 'customers.status: 1=Active, 2=Inactive, 3=Deleted',
      discoveredContext: 'Default scope excludes status=3 (Deleted)',
      history: [],
    });
    expect((messages[0].content as string)).toContain('SELECT');
    expect((messages[0].content as string)).toContain('READ ONLY');
    expect((messages[1].content as string)).toContain('customers.status: 1=Active');
    expect((messages[1].content as string)).toContain('Default scope excludes status=3');
  });

  it('includes code context for data_with_code', () => {
    const messages = buildGenerateSqlMessages({
      question: 'Jobs where net sales > $500',
      schema: 'TABLE jobs (id, total, discount)',
      enums: '',
      discoveredContext: '',
      codeContext: 'def net_sales; total - discount; end',
      history: [],
    });
    expect((messages[1].content as string)).toContain('net_sales');
    expect((messages[1].content as string)).toContain('total - discount');
  });

  it('includes retry context when SQL was rejected', () => {
    const messages = buildGenerateSqlMessages({
      question: 'Show all users',
      schema: 'TABLE users (id, name)',
      enums: '',
      discoveredContext: '',
      history: [],
      retryWithContext: {
        originalSql: 'SELECT * FROM pg_roles',
        rejectionReason: 'Access to system catalog pg_roles is blocked',
      },
    });
    const lastMsg = messages[messages.length - 1].content as string;
    expect(lastMsg).toContain('pg_roles');
    expect(lastMsg).toContain('blocked');
  });
});
