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

  it('Taiga regression: prefers projects_project over projects_projecttemplate', () => {
    const taigaRegistry: Registry = {
      version: 1, generatedAt: '', framework: 'django', aliases: {},
      entities: {
        // Real data table — 0 rows in fresh setup
        projects_project: { name: 'projects_project', table: 'projects_project', displayLabel: 'Project', rowCount: 0 } as any,
        // Lookup/template table — has 2 seed rows
        projects_projecttemplate: { name: 'projects_projecttemplate', table: 'projects_projecttemplate', displayLabel: 'ProjectTemplate', rowCount: 2 } as any,
      },
    };
    const c = selectEntityCandidates('how many projects', taigaRegistry, 5);
    // The simpler-named entity (fewer name segments after token match) wins,
    // even though the template table has more rows.
    expect(c[0].name).toBe('projects_project');
  });

  it('whitespace-collapsed match: "user stories" → userstories_userstory', () => {
    const r: Registry = {
      version: 1, generatedAt: '', framework: 'django', aliases: {},
      entities: {
        userstories_userstory: { name: 'userstories_userstory', table: 'userstories_userstory', displayLabel: 'UserStory', rowCount: 0 } as any,
        users_user: { name: 'users_user', table: 'users_user', displayLabel: 'User', rowCount: 4 } as any,
      },
    };
    const c = selectEntityCandidates('how many user stories do we have', r, 5);
    expect(c[0].name).toBe('userstories_userstory');
  });

  it('token match: question "users" matches users_user entity', () => {
    const r: Registry = {
      version: 1, generatedAt: '', framework: 'django', aliases: {},
      entities: {
        users_user: { name: 'users_user', table: 'users_user', displayLabel: 'User', rowCount: 4 } as any,
        auth_permission: { name: 'auth_permission', table: 'auth_permission', displayLabel: 'Permission', rowCount: 100 } as any,
      },
    };
    const c = selectEntityCandidates('how many users', r, 5);
    expect(c[0].name).toBe('users_user');
  });
});
