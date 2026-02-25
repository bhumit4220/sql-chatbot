/**
 * V3 Background Worker tests — validates the simplified message handler
 * that manages site configs via chrome.storage.local.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

const storageMock: Record<string, any> = {};

const localGet = vi.fn(async (keys: string | string[] | null) => {
  if (keys === null) return { ...storageMock };
  if (typeof keys === 'string') return { [keys]: storageMock[keys] };
  const result: Record<string, any> = {};
  for (const k of keys as string[]) {
    if (k in storageMock) result[k] = storageMock[k];
  }
  return result;
});

const localSet = vi.fn(async (items: Record<string, any>) => {
  Object.assign(storageMock, items);
});

const localRemove = vi.fn(async (key: string) => {
  delete storageMock[key];
});

globalThis.chrome = {
  storage: {
    local: {
      get: localGet,
      set: localSet,
      remove: localRemove,
    },
  },
} as any;

// Import AFTER chrome stubs are in place — message-handler.ts has no
// top-level chrome calls so it is safe to import.
import { handleMessage } from '../message-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearStorage() {
  for (const key of Object.keys(storageMock)) {
    delete storageMock[key];
  }
}

beforeEach(() => {
  clearStorage();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET_SITE_CONFIGS
// ---------------------------------------------------------------------------

describe('GET_SITE_CONFIGS', () => {
  it('returns empty sites when storage is empty', async () => {
    const result = await handleMessage({ type: 'GET_SITE_CONFIGS' });
    expect(result).toEqual({ sites: {} });
  });

  it('returns only site:-prefixed keys', async () => {
    storageMock['site:https://example.com'] = { endpoint: '/chatbot', discoveredAt: 100 };
    storageMock['site:https://other.dev'] = { endpoint: '/bot', discoveredAt: 200 };
    storageMock['unrelated_key'] = 'should be excluded';

    const result = await handleMessage({ type: 'GET_SITE_CONFIGS' });
    expect(result).toEqual({
      sites: {
        'https://example.com': { endpoint: '/chatbot', discoveredAt: 100 },
        'https://other.dev': { endpoint: '/bot', discoveredAt: 200 },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// REMOVE_SITE
// ---------------------------------------------------------------------------

describe('REMOVE_SITE', () => {
  it('removes the specified site from storage', async () => {
    storageMock['site:https://example.com'] = { endpoint: '/chatbot' };

    const result = await handleMessage({
      type: 'REMOVE_SITE',
      payload: { origin: 'https://example.com' },
    });

    expect(result).toEqual({ removed: true });
    expect(localRemove).toHaveBeenCalledWith('site:https://example.com');
  });

  it('does nothing when origin is missing', async () => {
    const result = await handleMessage({ type: 'REMOVE_SITE', payload: {} });
    expect(result).toEqual({ removed: true });
    expect(localRemove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADD_SITE_MANUALLY
// ---------------------------------------------------------------------------

describe('ADD_SITE_MANUALLY', () => {
  it('stores a new site config', async () => {
    const result = await handleMessage({
      type: 'ADD_SITE_MANUALLY',
      payload: { origin: 'https://myapp.dev', endpoint: '/chatbot/ask' },
    });

    expect(result).toEqual({ added: true });
    expect(localSet).toHaveBeenCalledWith({
      'site:https://myapp.dev': expect.objectContaining({
        endpoint: '/chatbot/ask',
        discoveredAt: expect.any(Number),
      }),
    });
  });

  it('does nothing when origin or endpoint is missing', async () => {
    const result = await handleMessage({
      type: 'ADD_SITE_MANUALLY',
      payload: { origin: 'https://myapp.dev' },
    });
    expect(result).toEqual({ added: true });
    expect(localSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown message type
// ---------------------------------------------------------------------------

describe('unknown message type', () => {
  it('returns an error for unrecognized types', async () => {
    const result = await handleMessage({ type: 'DOES_NOT_EXIST' });
    expect(result).toEqual({ error: 'Unknown message type: DOES_NOT_EXIST' });
  });
});
