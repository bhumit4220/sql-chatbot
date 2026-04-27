import { describe, it, expect } from 'vitest';
import { tryRenderListProgrammatically } from '../../grammar/list-renderer.js';

describe('tryRenderListProgrammatically', () => {
  it('renders empty result programmatically', () => {
    const r = tryRenderListProgrammatically('LIST', 'Label', []);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/no matching/i);
  });

  it('renders 5 labels (Chatwoot regression case)', () => {
    const rows = [
      { id: 1, title: 'bug' },
      { id: 2, title: 'feature' },
      { id: 3, title: 'urgent' },
      { id: 4, title: 'billing' },
      { id: 5, title: 'technical' },
    ];
    const r = tryRenderListProgrammatically('LIST', 'Label', rows);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('bug');
    expect(r.text).toContain('feature');
    expect(r.text).toContain('urgent');
    expect(r.text).toContain('billing');
    expect(r.text).toContain('technical');
    expect(r.text).toMatch(/5 Labels/);
  });

  it('uses singular form for single item', () => {
    const r = tryRenderListProgrammatically('LIST', 'Project', [{ id: 1, name: 'alpha' }]);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Here is the Project/);
    expect(r.text).toContain('alpha');
  });

  it('falls back when result count > 10', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: i, name: `r${i}` }));
    expect(tryRenderListProgrammatically('LIST', 'Item', rows).ok).toBe(false);
  });

  it('falls back when no readable label can be picked', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    expect(tryRenderListProgrammatically('LIST', 'Item', rows).ok).toBe(false);
  });

  it('skips non-LIST primitives', () => {
    expect(tryRenderListProgrammatically('COUNT', 'Item', [{ count: 5 }]).ok).toBe(false);
  });

  it('prefers title over name and email', () => {
    const r = tryRenderListProgrammatically('LIST', 'Order', [
      { id: 1, name: 'fallback', title: 'preferred', email: 'e@e' },
    ]);
    expect(r.text).toContain('preferred');
    expect(r.text).not.toContain('fallback');
    expect(r.text).not.toContain('e@e');
  });
});
