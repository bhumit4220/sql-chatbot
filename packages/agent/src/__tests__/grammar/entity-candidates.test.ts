import { describe, it, expect } from 'vitest';
import { selectEntityCandidates } from '../../grammar/entity-candidates.js';
import { Registry } from '../../grammar/registry.js';

const registry: Registry = {
  version: 1, generatedAt: '', framework: 'rails',
  aliases: { customers: 'user', folks: 'user' },
  entities: {
    user: { name: 'user', table: 'users', displayLabel: 'User', rowCount: 100 } as any,
    order: { name: 'order', table: 'orders', displayLabel: 'Order', rowCount: 500 } as any,
    product: { name: 'product', table: 'products', displayLabel: 'Product', rowCount: 50 } as any,
    account: { name: 'account', table: 'accounts', displayLabel: 'Account', rowCount: 10 } as any,
    setting: { name: 'setting', table: 'settings', displayLabel: 'Setting', rowCount: 5 } as any,
    audit_log: { name: 'audit_log', table: 'audit_logs', displayLabel: 'AuditLog', rowCount: 10000 } as any,
  },
};

describe('selectEntityCandidates', () => {
  it('matches exact entity name in question', () => {
    const c = selectEntityCandidates('how many users', registry, 5);
    expect(c[0].name).toBe('user');
  });

  it('resolves alias', () => {
    const c = selectEntityCandidates('how many customers', registry, 5);
    expect(c[0].name).toBe('user');
  });

  it('returns up to top-N by match strength', () => {
    const c = selectEntityCandidates('orders and products', registry, 3);
    expect(c.slice(0, 2).map(e => e.name).sort()).toEqual(['order', 'product']);
    expect(c.length).toBeLessThanOrEqual(3);
  });

  it('falls back to highest-rowCount entities when no match', () => {
    const c = selectEntityCandidates('hello there', registry, 3);
    expect(c[0].name).toBe('audit_log');
  });
});
