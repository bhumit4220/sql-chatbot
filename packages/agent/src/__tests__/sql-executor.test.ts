import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateSql, executeSql } from '../services/sql-executor.js';

// --- Mock pg for executeSql tests ---

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockPoolEnd = vi.fn();
const mockConnect = vi.fn();

vi.mock('pg', () => {
  return {
    Pool: vi.fn(() => ({
      connect: mockConnect,
      end: mockPoolEnd,
    })),
  };
});

// ============================================================
// validateSql — pure function tests (no mocking needed)
// ============================================================

describe('validateSql', () => {
  it('1. valid simple SELECT passes', () => {
    const result = validateSql('SELECT id, name FROM customers');
    expect(result.valid).toBe(true);
    expect(result.sql).toBeDefined();
  });

  it('2. valid SELECT with JOIN passes', () => {
    const result = validateSql(
      'SELECT c.name, j.title FROM customers c JOIN jobs j ON j.customer_id = c.id'
    );
    expect(result.valid).toBe(true);
    expect(result.sql).toBeDefined();
  });

  it('3. valid aggregate (COUNT) passes without LIMIT injection', () => {
    const result = validateSql('SELECT COUNT(*) FROM customers');
    expect(result.valid).toBe(true);
    expect(result.sql).toBeDefined();
    expect(result.sql!.toUpperCase()).not.toContain('LIMIT');
  });

  it('4. rejects INSERT statement', () => {
    const result = validateSql("INSERT INTO customers (name) VALUES ('test')");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('5. rejects UPDATE statement', () => {
    const result = validateSql("UPDATE customers SET name = 'test'");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('6. rejects DELETE statement', () => {
    const result = validateSql('DELETE FROM customers');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('7. rejects DROP TABLE', () => {
    const result = validateSql('DROP TABLE customers');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('8. rejects multiple statements (semicolon)', () => {
    const result = validateSql('SELECT 1; DROP TABLE customers');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('single');
  });

  it('9. rejects pg_read_file function', () => {
    const result = validateSql("SELECT pg_read_file('/etc/passwd')");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('10. rejects pg_sleep function', () => {
    const result = validateSql('SELECT pg_sleep(10)');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('11. rejects pg_shadow system catalog access', () => {
    const result = validateSql('SELECT * FROM pg_shadow');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('12. rejects pg_roles access', () => {
    const result = validateSql('SELECT * FROM pg_roles');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('13. auto-adds LIMIT 500 to non-aggregate queries', () => {
    const result = validateSql('SELECT id, name FROM customers');
    expect(result.valid).toBe(true);
    expect(result.sql!.toUpperCase()).toContain('LIMIT 500');
  });

  it('14. does not add LIMIT if LIMIT already present', () => {
    const result = validateSql('SELECT id, name FROM customers LIMIT 10');
    expect(result.valid).toBe(true);
    // Should contain the original LIMIT 10, not an extra LIMIT 500
    expect(result.sql).toContain('LIMIT 10');
    // Count occurrences of LIMIT — should be exactly 1
    const limitCount = (result.sql!.toUpperCase().match(/LIMIT/g) || []).length;
    expect(limitCount).toBe(1);
  });

  it('15. rejects queries not starting with SELECT', () => {
    const result = validateSql('WITH cte AS (DELETE FROM customers) SELECT * FROM cte');
    expect(result.valid).toBe(false);
  });

  it('16. case-insensitive blocking (e.g., "DrOp TaBlE")', () => {
    const result = validateSql('DrOp TaBlE customers');
    expect(result.valid).toBe(false);
  });

  it('17. does not false-positive on column names containing blocked words', () => {
    // "updated_at" contains "update" as a substring, but should NOT be blocked
    const result = validateSql('SELECT updated_at, deleted_at, created_at FROM jobs');
    expect(result.valid).toBe(true);
    expect(result.sql).toBeDefined();
  });
});

// ============================================================
// executeSql — requires pg mock
// ============================================================

describe('executeSql', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockRelease.mockReset();
    mockPoolEnd.mockReset();
    mockConnect.mockReset();

    // Default mock client
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
  });

  it('18. executes query in READ ONLY transaction', async () => {
    mockQuery.mockResolvedValue({ fields: [], rows: [], rowCount: 0 });

    await executeSql('postgres://localhost/testdb', 'SELECT 1');

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('SET TRANSACTION READ ONLY');
    expect(calls).toContain('COMMIT');
  });

  it('19. sets statement timeout to 10 seconds', async () => {
    mockQuery.mockResolvedValue({ fields: [], rows: [], rowCount: 0 });

    await executeSql('postgres://localhost/testdb', 'SELECT 1');

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c: string) => c.includes('statement_timeout') && c.includes('10s'))).toBe(true);
  });

  it('20. returns columns, rows, rowCount', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT')) {
        return Promise.resolve({
          fields: [{ name: 'id' }, { name: 'name' }],
          rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
          rowCount: 2,
        });
      }
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    });

    const result = await executeSql('postgres://localhost/testdb', 'SELECT id, name FROM customers');

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    expect(result.rowCount).toBe(2);
  });

  it('21. releases client and ends pool on success', async () => {
    mockQuery.mockResolvedValue({ fields: [], rows: [], rowCount: 0 });

    await executeSql('postgres://localhost/testdb', 'SELECT 1');

    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });

  it('22. releases client and ends pool on error', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT')) {
        return Promise.reject(new Error('query failed'));
      }
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    });

    await expect(
      executeSql('postgres://localhost/testdb', 'SELECT bad_query')
    ).rejects.toThrow('query failed');

    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });
});
