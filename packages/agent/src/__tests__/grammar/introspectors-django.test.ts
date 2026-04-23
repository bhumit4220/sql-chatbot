import { describe, it, expect } from 'vitest';
import { introspectDjango } from '../../grammar/introspectors/django.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('introspectDjango', () => {
  const fixtures = path.resolve(__dirname, '../fixtures/django');

  it('extracts User and Order entities', async () => {
    const r = await introspectDjango(fixtures);
    expect(r.framework).toBe('django');
    expect(r.entities.user.table).toBe('auth_user');
    expect(r.entities.order.table).toBe('order_order');
  });

  it('maps IntegerField choices into Field.enumValues', async () => {
    const r = await introspectDjango(fixtures);
    const status = r.entities.user.fields.status;
    expect(status.enumValues).toEqual({ Active: 0, Banned: 1 });
    expect(status.type).toBe('enum');
  });

  it('records ForeignKey as belongs_to association', async () => {
    const r = await introspectDjango(fixtures);
    const assoc = r.entities.order.associations.user;
    expect(assoc.kind).toBe('belongs_to');
    expect(assoc.targetEntity).toBe('user');
    expect(assoc.joinClause).toBe('order_order.user_id = auth_user.id');
  });
});
