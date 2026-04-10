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
    enums?: { rows: { enum_name: string; enum_value: string }[] };
    checkConstraints?: { rows: { table_name: string; check_def: string }[] };
  } = {}
) {
  const tables = overrides.tables ?? tablesResult;
  const columns = overrides.columns ?? columnsResult;
  const pks = overrides.primaryKeys ?? primaryKeysResult;
  const fks = overrides.foreignKeys ?? foreignKeysResult;
  const rowCounts = overrides.rowCounts ?? { rows: [] };
  const lookupValues = overrides.lookupValues ?? {};
  const enums = overrides.enums ?? { rows: [] };
  const checks = overrides.checkConstraints ?? { rows: [] };

  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('information_schema.tables')) return Promise.resolve(tables);
    if (sql.includes('information_schema.columns')) return Promise.resolve(columns);
    if (sql.includes("'PRIMARY KEY'")) return Promise.resolve(pks);
    if (sql.includes("'FOREIGN KEY'")) return Promise.resolve(fks);
    if (sql.includes('pg_enum')) return Promise.resolve(enums);
    if (sql.includes('pg_constraint')) return Promise.resolve(checks);
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

  describe('enum value introspection', () => {
    it('annotates USER-DEFINED columns with enum values', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'challenges' }] },
        columns: {
          rows: [
            { table_name: 'challenges', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'challenges', column_name: 'name', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null },
            { table_name: 'challenges', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'challenges_status_enum', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'challenges', column_name: 'id' }] },
        foreignKeys: { rows: [] },
        enums: {
          rows: [
            { enum_name: 'challenges_status_enum', enum_value: 'Draft' },
            { enum_name: 'challenges_status_enum', enum_value: 'Active' },
            { enum_name: 'challenges_status_enum', enum_value: 'Completed' },
            { enum_name: 'challenges_status_enum', enum_value: 'Cancelled' },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('status ENUM(Draft,Active,Completed,Cancelled)');
      expect(summary).toContain('-- ENUM: status values: Draft, Active, Completed, Cancelled');
    });

    it('handles multiple enum types across tables', async () => {
      setupMockQuery({
        tables: { rows: [
          { table_name: 'challenges' },
          { table_name: 'workouts' },
        ] },
        columns: {
          rows: [
            { table_name: 'challenges', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'challenges', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'challenge_status', is_nullable: 'NO', column_default: null },
            { table_name: 'workouts', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'workouts', column_name: 'difficulty', data_type: 'USER-DEFINED', udt_name: 'difficulty_level', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [
          { table_name: 'challenges', column_name: 'id' },
          { table_name: 'workouts', column_name: 'id' },
        ] },
        foreignKeys: { rows: [] },
        enums: {
          rows: [
            { enum_name: 'challenge_status', enum_value: 'Active' },
            { enum_name: 'challenge_status', enum_value: 'Inactive' },
            { enum_name: 'difficulty_level', enum_value: 'Easy' },
            { enum_name: 'difficulty_level', enum_value: 'Medium' },
            { enum_name: 'difficulty_level', enum_value: 'Hard' },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('status ENUM(Active,Inactive)');
      expect(summary).toContain('-- ENUM: status values: Active, Inactive');
      expect(summary).toContain('difficulty ENUM(Easy,Medium,Hard)');
      expect(summary).toContain('-- ENUM: difficulty values: Easy, Medium, Hard');
    });

    it('does NOT annotate USER-DEFINED columns without matching enum', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'geo' }] },
        columns: {
          rows: [
            { table_name: 'geo', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'geo', column_name: 'location', data_type: 'USER-DEFINED', udt_name: 'geometry', is_nullable: 'YES', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'geo', column_name: 'id' }] },
        foreignKeys: { rows: [] },
        enums: { rows: [] },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('ENUM');
      expect(summary).toContain('location USER-DEFINED');
    });

    it('tables without enum columns are unchanged', async () => {
      setupMockQuery({
        enums: {
          rows: [
            { enum_name: 'some_enum', enum_value: 'A' },
            { enum_name: 'some_enum', enum_value: 'B' },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).not.toContain('ENUM');
      expect(summary).toContain('TABLE customers');
      expect(summary).toContain('TABLE jobs');
    });

    it('detects enum values from CHECK constraints (ANY ARRAY format)', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'orders' }] },
        columns: {
          rows: [
            { table_name: 'orders', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'orders', column_name: 'status', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'orders', column_name: 'id' }] },
        foreignKeys: { rows: [] },
        checkConstraints: {
          rows: [
            {
              table_name: 'orders',
              check_def: "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'shipped'::character varying, 'delivered'::character varying])::text[])))",
            },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('status ENUM(pending,shipped,delivered)');
      expect(summary).toContain('-- ENUM: status values: pending, shipped, delivered');
    });

    it('detects enum values from CHECK constraints (IN format)', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'tasks' }] },
        columns: {
          rows: [
            { table_name: 'tasks', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'tasks', column_name: 'priority', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'tasks', column_name: 'id' }] },
        foreignKeys: { rows: [] },
        checkConstraints: {
          rows: [
            {
              table_name: 'tasks',
              check_def: "(priority IN ('low', 'medium', 'high', 'critical'))",
            },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      expect(summary).toContain('priority ENUM(low,medium,high,critical)');
      expect(summary).toContain('-- ENUM: priority values: low, medium, high, critical');
    });

    it('pg_enum takes priority over check constraint for same column', async () => {
      setupMockQuery({
        tables: { rows: [{ table_name: 'items' }] },
        columns: {
          rows: [
            { table_name: 'items', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null },
            { table_name: 'items', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'item_status', is_nullable: 'NO', column_default: null },
          ],
        },
        primaryKeys: { rows: [{ table_name: 'items', column_name: 'id' }] },
        foreignKeys: { rows: [] },
        enums: {
          rows: [
            { enum_name: 'item_status', enum_value: 'Active' },
            { enum_name: 'item_status', enum_value: 'Inactive' },
          ],
        },
        checkConstraints: {
          rows: [
            { table_name: 'items', check_def: "(status IN ('active', 'inactive'))" },
          ],
        },
      });

      await service.discover('postgres://localhost:5432/testdb');

      const summary = service.getSummary();
      // pg_enum values (PascalCase) should win over check constraint values (lowercase)
      expect(summary).toContain('ENUM(Active,Inactive)');
      expect(summary).toContain('-- ENUM: status values: Active, Inactive');
    });
  });

  describe('getTableNames', () => {
    it('returns comma-separated table names', () => {
      const svc = new SchemaService();
      (svc as any).tables = ['customers', 'jobs', 'job_types'];
      expect(svc.getTableNames()).toBe('Available tables: customers, jobs, job_types');
    });

    it('returns empty string before discover', () => {
      const svc = new SchemaService();
      expect(svc.getTableNames()).toBe('');
    });
  });

  describe('selectSchema', () => {
    let svc: SchemaService;

    beforeEach(() => {
      svc = new SchemaService();
      (svc as any).perTableSchemas = new Map([
        ['customers', 'TABLE customers (id BIGINT PK, email VARCHAR, status INT)\n  -- RAILS ENUM: status values: Active=1'],
        ['jobs', 'TABLE jobs (id BIGINT PK, customer_id BIGINT FK=>customers.id, job_type_id BIGINT FK=>job_types.id)'],
        ['job_types', 'TABLE job_types (id BIGINT PK, title VARCHAR)'],
        ['contractors', 'TABLE contractors (id BIGINT PK, avg_rating DECIMAL)'],
      ]);
      (svc as any).tableIndex = new Map([
        ['email', ['customers']], ['status', ['customers', 'jobs']],
        ['customer_id', ['jobs']], ['job_type_id', ['jobs']],
        ['title', ['job_types']], ['avg_rating', ['contractors']],
      ]);
      (svc as any).fkGraph = new Map([
        ['jobs', [{ fromCol: 'customer_id', toTable: 'customers', toCol: 'id' }, { fromCol: 'job_type_id', toTable: 'job_types', toCol: 'id' }]],
        ['customers', [{ fromCol: 'id', toTable: 'jobs', toCol: 'customer_id' }]],
        ['job_types', [{ fromCol: 'id', toTable: 'jobs', toCol: 'job_type_id' }]],
      ]);
      (svc as any).tables = ['customers', 'jobs', 'job_types', 'contractors'];
    });

    it('selects only matched tables', () => {
      const result = svc.selectSchema(['customers']);
      expect(result).toContain('TABLE customers');
      expect(result).not.toContain('TABLE jobs');
    });

    it('selects connected tables', () => {
      const result = svc.selectSchema(['jobs', 'job_types']);
      expect(result).toContain('TABLE jobs');
      expect(result).toContain('TABLE job_types');
      expect(result).not.toContain('TABLE customers');
    });

    it('finds bridge tables', () => {
      const result = svc.selectSchema(['customers', 'job_types']);
      expect(result).toContain('TABLE customers');
      expect(result).toContain('TABLE job_types');
      expect(result).toContain('TABLE jobs');
    });

    it('matches column names', () => {
      const result = svc.selectSchema(['rating']);
      expect(result).toContain('TABLE contractors');
    });

    it('includes annotations', () => {
      const result = svc.selectSchema(['customers']);
      expect(result).toContain('RAILS ENUM');
    });
  });
});
