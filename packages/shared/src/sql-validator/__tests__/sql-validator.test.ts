import { describe, it, expect } from 'vitest';
import { validateSQL } from '../index.js';

const SCHEMA = {
  contractors: ['id', 'first_name', 'last_name', 'status', 'email', 'created_at'],
  customers: ['id', 'first_name', 'last_name', 'status', 'email', 'created_at'],
  jobs: ['id', 'job_type_id', 'contractor_id', 'created_by', 'status', 'bid_amount', 'created_at'],
  job_types: ['id', 'title'],
  properties: ['id', 'service_area_id', 'address_line_1'],
  service_areas: ['id', 'title'],
};

describe('SQL Validator — Allowlist', () => {
  // Valid queries
  it('allows simple SELECT', () => {
    const result = validateSQL('SELECT COUNT(*) FROM contractors WHERE status = 1', SCHEMA);
    expect(result.isValid).toBe(true);
  });

  it('allows SELECT with JOIN', () => {
    const result = validateSQL(
      'SELECT c.first_name, COUNT(j.id) FROM contractors c JOIN jobs j ON c.id = j.contractor_id GROUP BY c.first_name',
      SCHEMA
    );
    expect(result.isValid).toBe(true);
  });

  it('allows SELECT with subquery', () => {
    const result = validateSQL(
      'SELECT * FROM contractors WHERE id IN (SELECT contractor_id FROM jobs WHERE status = 11)',
      SCHEMA
    );
    expect(result.isValid).toBe(true);
  });

  it('adds LIMIT 500 when no LIMIT present', () => {
    const result = validateSQL('SELECT * FROM contractors', SCHEMA);
    expect(result.isValid).toBe(true);
    expect(result.modifiedSql).toContain('LIMIT 500');
  });

  it('preserves existing LIMIT', () => {
    const result = validateSQL('SELECT * FROM contractors LIMIT 10', SCHEMA);
    expect(result.isValid).toBe(true);
    expect(result.modifiedSql).not.toContain('LIMIT 500');
  });

  // Blocked mutations
  it('rejects INSERT', () => {
    const result = validateSQL('INSERT INTO contractors (first_name) VALUES (\'hack\')', SCHEMA);
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toContain('Only SELECT');
  });

  it('rejects UPDATE', () => {
    const result = validateSQL('UPDATE contractors SET status = 3', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects DELETE', () => {
    const result = validateSQL('DELETE FROM contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects DROP', () => {
    const result = validateSQL('DROP TABLE contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects TRUNCATE', () => {
    const result = validateSQL('TRUNCATE contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Blocked via CTE mutation
  it('rejects CTE with INSERT', () => {
    const result = validateSQL(
      'WITH deleted AS (DELETE FROM contractors RETURNING *) SELECT * FROM deleted',
      SCHEMA
    );
    expect(result.isValid).toBe(false);
  });

  // Blocked SELECT INTO
  it('rejects SELECT INTO', () => {
    const result = validateSQL('SELECT * INTO new_table FROM contractors', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Multiple statements
  it('rejects multiple statements', () => {
    const result = validateSQL('SELECT 1; DROP TABLE contractors;', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Dangerous functions
  it('rejects pg_read_file', () => {
    const result = validateSQL("SELECT pg_read_file('/etc/passwd')", SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects pg_sleep', () => {
    const result = validateSQL('SELECT pg_sleep(10)', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects dblink', () => {
    const result = validateSQL("SELECT * FROM dblink('host=evil', 'SELECT 1')", SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // System catalog access
  it('rejects pg_stat_activity', () => {
    const result = validateSQL('SELECT * FROM pg_stat_activity', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  it('rejects information_schema', () => {
    const result = validateSQL('SELECT * FROM information_schema.tables', SCHEMA);
    expect(result.isValid).toBe(false);
  });

  // Excluded tables
  it('rejects queries on excluded tables', () => {
    const result = validateSQL('SELECT * FROM contractors', SCHEMA, { excludeTables: ['contractors'] });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toContain('excluded');
  });
});
