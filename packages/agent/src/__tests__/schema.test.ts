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

// Soft delete column names to detect
const SOFT_DELETE_COLUMNS = ['deleted_at', 'discarded_at', 'archived_at', 'removed_at'];

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
    rowCounts?: { rows: { relname: string; n_live_tup: string }[] };
    lookupValues?: Record<string, { rows: Record<string, unknown>[] }>;
  } = {}
) {
  const tables = overrides.tables ?? tablesResult;
  const columns = overrides.columns ?? columnsResult;
  const pks = overrides.primaryKeys ?? primaryKeysResult;
  const fks = overrides.foreignKeys ?? foreignKeysResult;
  const rowCounts = overrides.rowCounts ?? { rows: [] };
  const lookupValues = overrides.lookupValues ?? {};

  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('information_schema.tables')) return Promise.resolve(tables);
    if (sql.includes('information_schema.columns')) return Promise.resolve(columns);
    if (sql.includes("'PRIMARY KEY'")) return Promise.resolve(pks);
    if (sql.includes("'FOREIGN KEY'")) return Promise.resolve(fks);
    if (sql.includes('pg_stat_user_tables')) return Promise.resolve(rowCounts);
    // Match lookup value queries: SELECT pk, display FROM table_name ORDER BY pk LIMIT 50
    for (const [tableName, result] of Object.entries(lookupValues)) {
      if (sql.includes(`FROM ${tableName}`) || sql.includes(`FROM "${tableName}"`)) {
        return Promise.resolve(result);
      }
    }
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
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('calls pool.end() even when a query throws', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));

    await expect(service.discover('postgres://localhost:5432/testdb')).rejects.toThrow('connection refused');
    expect(mockEnd).toHaveBeenCalledOnce();
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

  it('does not filter columns with sensitive substrings that are not word boundaries', async () => {
    setupMockQuery({
      tables: { rows: [{ table_name: 'items' }] },
      columns: {
        rows: [
          { table_name: 'items', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { table_name: 'items', column_name: 'pinned_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
          { table_name: 'items', column_name: 'spinning', data_type: 'boolean', is_nullable: 'YES', column_default: null },
          { table_name: 'items', column_name: 'hashtag', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { table_name: 'items', column_name: 'saltwater', data_type: 'boolean', is_nullable: 'YES', column_default: null },
        ],
      },
      primaryKeys: { rows: [{ table_name: 'items', column_name: 'id' }] },
      foreignKeys: { rows: [] },
    });

    await service.discover('postgres://localhost:5432/testdb');

    const summary = service.getSummary();
    expect(summary).toContain('pinned_at TIMESTAMP');
    expect(summary).toContain('spinning BOOL');
    expect(summary).toContain('hashtag VARCHAR');
    expect(summary).toContain('saltwater BOOL');
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

  // --- Schema Enrichment Tests ---

  describe('soft delete detection', () => {
    it('annotates table with deleted_at column', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'posts' }] },
        columns: {
          rows: [
            { table_name: 'posts', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'posts', column_name: 'title', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'posts', column_name: 'deleted_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'posts', column_name: 'id' }] },
        foreignKeys: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('-- SOFT DELETE: filter deleted_at IS NULL for active records');
    });

    it('detects all soft delete variants (discarded_at, archived_at, removed_at)', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'items' },
          { table_name: 'records' },
          { table_name: 'entries' },
        ] },
        columns: {
          rows: [
            { table_name: 'items', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'items', column_name: 'discarded_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
            { table_name: 'records', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'records', column_name: 'archived_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
            { table_name: 'entries', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'entries', column_name: 'removed_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'items', column_name: 'id' },
          { table_name: 'records', column_name: 'id' },
          { table_name: 'entries', column_name: 'id' },
        ] },
        foreignKeys: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('-- SOFT DELETE: filter discarded_at IS NULL for active records');
      expect(summary).toContain('-- SOFT DELETE: filter archived_at IS NULL for active records');
      expect(summary).toContain('-- SOFT DELETE: filter removed_at IS NULL for active records');
    });

    it('does NOT annotate updated_at or created_at as soft delete', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'users' }] },
        columns: {
          rows: [
            { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'users', column_name: 'updated_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
            { table_name: 'users', column_name: 'created_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'users', column_name: 'id' }] },
        foreignKeys: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('SOFT DELETE');
    });
  });

  describe('polymorphic association detection', () => {
    it('detects *_type + *_id pair as polymorphic', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'likes' }] },
        columns: {
          rows: [
            { table_name: 'likes', column_name: 'id', data_type: 'bigint', is_nullable: 'NO', column_default: null },
            { table_name: 'likes', column_name: 'user_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'likes', column_name: 'likeable_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'likes', column_name: 'likeable_type', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'likes', column_name: 'id' }] },
        foreignKeys: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('-- POLYMORPHIC: likeable_type + likeable_id (join target depends on type value)');
    });

    it('does NOT annotate *_type without matching *_id', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'files' }] },
        columns: {
          rows: [
            { table_name: 'files', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'files', column_name: 'content_type', data_type: 'character varying', is_nullable: 'YES', column_default: null },
            { table_name: 'files', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'files', column_name: 'id' }] },
        foreignKeys: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('POLYMORPHIC');
    });
  });

  describe('lookup table value detection', () => {
    it('includes VALUES annotation for small FK-target tables', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'categories' },
          { table_name: 'titles' },
        ] },
        columns: {
          rows: [
            { table_name: 'categories', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'categories', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'id', data_type: 'bigint', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'category_id', data_type: 'integer', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'categories', column_name: 'id' },
          { table_name: 'titles', column_name: 'id' },
        ] },
        foreignKeys: { rows: [
          { from_table: 'titles', from_column: 'category_id', to_table: 'categories', to_column: 'id' },
        ] },
        rowCounts: { rows: [
          { relname: 'categories', n_live_tup: '5' },
          { relname: 'titles', n_live_tup: '1200' },
        ] },
        lookupValues: {
          categories: { rows: [
            { id: 1, name: 'TV Shows' },
            { id: 2, name: 'Movie' },
            { id: 3, name: 'Action' },
          ] },
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('-- VALUES: 1=TV Shows, 2=Movie, 3=Action');
      // titles should NOT have values (too many rows)
      const titleLine = summary.split('\n').find((l: string) => l.startsWith('TABLE titles'));
      expect(titleLine).toBeDefined();
      // No VALUES line should follow titles
      const lines = summary.split('\n');
      const titlesIdx = lines.findIndex((l: string) => l.startsWith('TABLE titles'));
      const nextLine = lines[titlesIdx + 1];
      expect(nextLine === undefined || !nextLine.includes('VALUES')).toBe(true);
    });

    it('detects convention-based references without FK constraints (Rails-style)', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'categories' },
          { table_name: 'titles' },
        ] },
        columns: {
          rows: [
            { table_name: 'categories', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'categories', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'id', data_type: 'bigint', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'titles', column_name: 'category_id', data_type: 'integer', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'categories', column_name: 'id' },
          { table_name: 'titles', column_name: 'id' },
        ] },
        foreignKeys: { rows: [] },  // No FK constraints! Rails-style
        rowCounts: { rows: [
          { relname: 'categories', n_live_tup: '5' },
          { relname: 'titles', n_live_tup: '1200' },
        ] },
        lookupValues: {
          categories: { rows: [
            { id: 1, name: 'TV Shows' },
            { id: 2, name: 'Movie' },
          ] },
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('-- VALUES: 1=TV Shows, 2=Movie');
    });

    it('skips FK-target tables with many rows (>= 50)', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'statuses' },
          { table_name: 'orders' },
        ] },
        columns: {
          rows: [
            { table_name: 'statuses', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'statuses', column_name: 'label', data_type: 'character varying', is_nullable: 'NO', column_default: null },
            { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'orders', column_name: 'status_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'statuses', column_name: 'id' },
          { table_name: 'orders', column_name: 'id' },
        ] },
        foreignKeys: { rows: [
          { from_table: 'orders', from_column: 'status_id', to_table: 'statuses', to_column: 'id' },
        ] },
        rowCounts: { rows: [
          { relname: 'statuses', n_live_tup: '100' },
        ] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('VALUES');
    });

    it('skips lookup table with no VARCHAR/TEXT display column', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'settings' },
          { table_name: 'profiles' },
        ] },
        columns: {
          rows: [
            { table_name: 'settings', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'settings', column_name: 'value', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'profiles', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { table_name: 'profiles', column_name: 'setting_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'settings', column_name: 'id' },
          { table_name: 'profiles', column_name: 'id' },
        ] },
        foreignKeys: { rows: [
          { from_table: 'profiles', from_column: 'setting_id', to_table: 'settings', to_column: 'id' },
        ] },
        rowCounts: { rows: [
          { relname: 'settings', n_live_tup: '5' },
        ] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('VALUES');
    });
  });
});
