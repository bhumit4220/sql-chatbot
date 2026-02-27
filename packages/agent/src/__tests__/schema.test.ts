import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchemaService } from '../services/schema.js';

const mockQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => {
  return {
    Pool: vi.fn(() => ({
      query: mockQuery,
      end: mockEnd,
    })),
  };
});

// Standard mock data for most tests
const tablesResult = {
  rows: [
    { table_name: 'customers' },
    { table_name: 'jobs' },
  ],
};

const columnsResult = {
  rows: [
    { table_name: 'customers', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
    { table_name: 'customers', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
    { table_name: 'customers', column_name: 'email', data_type: 'character varying', is_nullable: 'YES', column_default: null },
    { table_name: 'customers', column_name: 'status', data_type: 'integer', is_nullable: 'NO', column_default: '1' },
    { table_name: 'customers', column_name: 'created_at', data_type: 'timestamp without time zone', is_nullable: 'NO', column_default: null },
    { table_name: 'jobs', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
    { table_name: 'jobs', column_name: 'customer_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
    { table_name: 'jobs', column_name: 'title', data_type: 'character varying', is_nullable: 'YES', column_default: null },
    { table_name: 'jobs', column_name: 'total', data_type: 'numeric', is_nullable: 'YES', column_default: null },
  ],
};

const primaryKeysResult = {
  rows: [
    { table_name: 'customers', column_name: 'id' },
    { table_name: 'jobs', column_name: 'id' },
  ],
};

const foreignKeysResult = {
  rows: [
    { from_table: 'jobs', from_column: 'customer_id', to_table: 'customers', to_column: 'id' },
  ],
};

function setupMockQuery(
  overrides: {
    tables?: typeof tablesResult;
    columns?: typeof columnsResult;
    primaryKeys?: typeof primaryKeysResult;
    foreignKeys?: typeof foreignKeysResult;
  } = {}
) {
  const tables = overrides.tables ?? tablesResult;
  const columns = overrides.columns ?? columnsResult;
  const pks = overrides.primaryKeys ?? primaryKeysResult;
  const fks = overrides.foreignKeys ?? foreignKeysResult;

  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('information_schema.tables')) return Promise.resolve(tables);
    if (sql.includes('information_schema.columns')) return Promise.resolve(columns);
    if (sql.includes("'PRIMARY KEY'")) return Promise.resolve(pks);
    if (sql.includes("'FOREIGN KEY'")) return Promise.resolve(fks);
    return Promise.resolve({ rows: [] });
  });
}

describe('SchemaService', () => {
  let service: SchemaService;

  beforeEach(() => {
    service = new SchemaService();
    mockQuery.mockReset();
    mockEnd.mockReset();
  });

  it('discovers tables and columns, produces correct summary format', async () => {
    setupMockQuery();

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('TABLE customers (');
    expect(summary).toContain('TABLE jobs (');
    expect(summary).toContain('name VARCHAR');
    expect(summary).toContain('email VARCHAR');
    expect(summary).toContain('title VARCHAR');
    expect(summary).toContain('total DECIMAL');
    expect(summary).toContain('created_at TIMESTAMP');
  });

  it('marks primary keys with PK', async () => {
    setupMockQuery();

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toMatch(/id INT PK/);
  });

  it('marks foreign keys with FK→target.column', async () => {
    setupMockQuery();

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('customer_id INT FK→customers.id');
  });

  it('filters out sensitive columns (password, token, secret, etc.)', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'users' }] },
      columns: {
        rows: [
          { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { table_name: 'users', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          { table_name: 'users', column_name: 'password_digest', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          { table_name: 'users', column_name: 'auth_token', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'api_key', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'secret_question', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'ssn', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'credit_card', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'encrypted_data', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'password_hash', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'salt', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'private_key', data_type: 'character varying', is_nullable: 'YES', column_default: null },
        ],
      },
      primaryKeys: { rows: [{ table_name: 'users', column_name: 'id' }] },
      foreignKeys: { rows: [] },
    });

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('id INT PK');
    expect(summary).toContain('name VARCHAR');
    expect(summary).not.toContain('password');
    expect(summary).not.toContain('token');
    expect(summary).not.toContain('api_key');
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('ssn');
    expect(summary).not.toContain('credit_card');
    expect(summary).not.toContain('encrypted');
    expect(summary).not.toContain('hash');
    expect(summary).not.toContain('salt');
    expect(summary).not.toContain('private_key');
  });

  it('sensitive column filtering is case-insensitive', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'users' }] },
      columns: {
        rows: [
          { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { table_name: 'users', column_name: 'PASSWORD', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          { table_name: 'users', column_name: 'Auth_Token', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'users', column_name: 'API_KEY', data_type: 'character varying', is_nullable: 'YES', column_default: null },
        ],
      },
      primaryKeys: { rows: [{ table_name: 'users', column_name: 'id' }] },
      foreignKeys: { rows: [] },
    });

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('id INT PK');
    expect(summary).not.toMatch(/PASSWORD/i);
    expect(summary).not.toMatch(/Auth_Token/i);
    expect(summary).not.toMatch(/API_KEY/i);
  });

  it('returns correct tableCount', async () => {
    setupMockQuery();

    await service.discover('postgres://localhost:5432/testdb');

    expect(service.tableCount()).toBe(2);
  });

  it('getSummary returns empty string before discover() is called', () => {
    expect(service.getSummary()).toBe('');
  });

  it('refresh() re-discovers and updates the summary', async () => {
    // First discover with two tables
    setupMockQuery();
    await service.discover('postgres://localhost:5432/testdb');
    expect(service.tableCount()).toBe(2);

    // Now refresh with three tables
    mockQuery.mockReset();
    setupMockQuery({
      tables: {
        rows: [
          { table_name: 'customers' },
          { table_name: 'jobs' },
          { table_name: 'invoices' },
        ],
      },
      columns: {
        rows: [
          ...columnsResult.rows,
          { table_name: 'invoices', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { table_name: 'invoices', column_name: 'amount', data_type: 'numeric', is_nullable: 'NO', column_default: null },
        ],
      },
      primaryKeys: {
        rows: [
          ...primaryKeysResult.rows,
          { table_name: 'invoices', column_name: 'id' },
        ],
      },
    });

    await service.refresh('postgres://localhost:5432/testdb');

    expect(service.tableCount()).toBe(3);
    expect(service.getSummary()).toContain('TABLE invoices (');
  });

  it('maps PostgreSQL data types to readable names', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'test_types' }] },
      columns: {
        rows: [
          { table_name: 'test_types', column_name: 'varchar_col', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'test_types', column_name: 'int_col', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { table_name: 'test_types', column_name: 'ts_col', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
          { table_name: 'test_types', column_name: 'num_col', data_type: 'numeric', is_nullable: 'YES', column_default: null },
          { table_name: 'test_types', column_name: 'bool_col', data_type: 'boolean', is_nullable: 'YES', column_default: null },
        ],
      },
      primaryKeys: { rows: [] },
      foreignKeys: { rows: [] },
    });

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('varchar_col VARCHAR');
    expect(summary).toContain('int_col INT');
    expect(summary).toContain('ts_col TIMESTAMP');
    expect(summary).toContain('num_col DECIMAL');
    expect(summary).toContain('bool_col BOOL');
  });
});
