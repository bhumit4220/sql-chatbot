import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../git/search.js', () => ({
  searchCode: vi.fn(),
}));

import { inferEnumLabelsFromCode } from '../label-inference.js';
import { searchCode } from '../../git/search.js';
import type { EnumCandidate } from '../data-sampler.js';

const mockedSearchCode = vi.mocked(searchCode);

describe('inferEnumLabelsFromCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces fallback labels when searchCode throws', () => {
    mockedSearchCode.mockImplementation(() => {
      throw new Error('No code index');
    });

    const candidates: EnumCandidate[] = [
      { table: 'jobs', column: 'status', distinctValues: [1, 2, 3], sampleSize: 3 },
    ];

    const results = inferEnumLabelsFromCode(candidates);

    expect(results).toHaveLength(1);
    expect(results[0].mappings).toEqual({
      '1': 'status_1',
      '2': 'status_2',
      '3': 'status_3',
    });
  });

  it('produces fallback labels when searchCode returns empty', () => {
    mockedSearchCode.mockReturnValue([]);

    const candidates: EnumCandidate[] = [
      { table: 'customers', column: 'login_type', distinctValues: [1, 2], sampleSize: 2 },
    ];

    const results = inferEnumLabelsFromCode(candidates);

    expect(results).toHaveLength(1);
    expect(results[0].mappings).toEqual({
      '1': 'login_type_1',
      '2': 'login_type_2',
    });
  });

  it('produces one EnumMapping per candidate', () => {
    mockedSearchCode.mockReturnValue([]);

    const candidates: EnumCandidate[] = [
      { table: 'jobs', column: 'status', distinctValues: [1, 2], sampleSize: 2 },
      { table: 'jobs', column: 'delivery_type', distinctValues: [1, 2, 3], sampleSize: 3 },
      { table: 'customers', column: 'login_type', distinctValues: [1], sampleSize: 1 },
    ];

    const results = inferEnumLabelsFromCode(candidates);

    expect(results).toHaveLength(3);
    expect(results[0].table).toBe('jobs');
    expect(results[0].column).toBe('status');
    expect(results[1].table).toBe('jobs');
    expect(results[1].column).toBe('delivery_type');
    expect(results[2].table).toBe('customers');
    expect(results[2].column).toBe('login_type');
  });

  it('returns empty results for empty candidates array', () => {
    const results = inferEnumLabelsFromCode([]);

    expect(results).toEqual([]);
    expect(mockedSearchCode).not.toHaveBeenCalled();
  });

  it('description indicates "labels pending" when using fallback', () => {
    mockedSearchCode.mockReturnValue([]);

    const candidates: EnumCandidate[] = [
      { table: 'jobs', column: 'status', distinctValues: [1, 2], sampleSize: 2 },
    ];

    const results = inferEnumLabelsFromCode(candidates);

    expect(results[0].description).toBe(
      'Auto-detected in jobs.status (labels pending)'
    );
  });

  it('handles multiple candidates with independent results', () => {
    mockedSearchCode.mockReturnValue([]);

    const candidates: EnumCandidate[] = [
      { table: 'jobs', column: 'status', distinctValues: [1, 2, 3], sampleSize: 3 },
      { table: 'contractors', column: 'status', distinctValues: [1, 2], sampleSize: 2 },
    ];

    const results = inferEnumLabelsFromCode(candidates);

    expect(results).toHaveLength(2);

    expect(results[0].table).toBe('jobs');
    expect(results[0].column).toBe('status');
    expect(results[0].mappings).toEqual({
      '1': 'status_1',
      '2': 'status_2',
      '3': 'status_3',
    });
    expect(results[0].description).toContain('labels pending');

    expect(results[1].table).toBe('contractors');
    expect(results[1].column).toBe('status');
    expect(results[1].mappings).toEqual({
      '1': 'status_1',
      '2': 'status_2',
    });
    expect(results[1].description).toContain('labels pending');
  });
});
