/**
 * Middleware discovery tests.
 *
 * Discovery flow:
 * 1. Check chrome.storage.local for cached endpoint
 * 2. Check <meta name="chatbot-agent" content="..."> in DOM
 * 3. Fetch /.well-known/chatbot-agent.json
 * 4. If found → cache in chrome.storage.local, return endpoint
 * 5. If not → return null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage.local
const storageData: Record<string, unknown> = {};
const removeMock = vi.fn().mockResolvedValue(undefined);
const chromeMock = {
  storage: {
    local: {
      get: vi.fn((keys: string[]) => {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (storageData[key] !== undefined) {
            result[key] = storageData[key];
          }
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((items: Record<string, unknown>) => {
        Object.assign(storageData, items);
        return Promise.resolve();
      }),
      remove: removeMock,
    },
  },
};

// @ts-expect-error - mock chrome API
globalThis.chrome = chromeMock;

// Mock fetch for .well-known
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// Mock document.querySelector for meta tag discovery
let metaTagContent: string | null = null;
const originalQuerySelector = globalThis.document?.querySelector?.bind(globalThis.document);

beforeEach(() => {
  vi.clearAllMocks();
  metaTagContent = null;

  // Clear storage
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  fetchMock.mockReset();
});

// We pass a DOM query function to the discovery module to make it testable
// without jsdom. The actual content script will use document.querySelector.

describe('discoverMiddleware', () => {
  async function getDiscovery() {
    vi.resetModules();
    // Re-set chrome mock after module reset
    // @ts-expect-error - mock chrome API
    globalThis.chrome = chromeMock;
    globalThis.fetch = fetchMock;
    return await import('../index.js');
  }

  it('returns cached endpoint from chrome.storage.local', async () => {
    const { discoverMiddleware } = await getDiscovery();

    storageData['site:https://admin.example.com'] = {
      endpoint: 'https://admin.example.com/chatbot',
      discoveredAt: Date.now(),
    };

    const result = await discoverMiddleware('https://admin.example.com');
    expect(result).toEqual({
      endpoint: 'https://admin.example.com/chatbot',
      source: 'cache',
    });
  });

  it('discovers endpoint from meta tag', async () => {
    const { discoverMiddleware } = await getDiscovery();

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => '/chatbot',
    });
    expect(result).toEqual({
      endpoint: 'https://admin.example.com/chatbot',
      source: 'meta',
    });

    // Should cache the result
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      'site:https://admin.example.com': {
        endpoint: 'https://admin.example.com/chatbot',
        discoveredAt: expect.any(Number),
      },
    });
  });

  it('discovers endpoint from meta tag with absolute URL', async () => {
    const { discoverMiddleware } = await getDiscovery();

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => 'https://admin.example.com/chatbot',
    });
    expect(result).toEqual({
      endpoint: 'https://admin.example.com/chatbot',
      source: 'meta',
    });
  });

  it('discovers endpoint from .well-known', async () => {
    const { discoverMiddleware } = await getDiscovery();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ endpoint: '/chatbot' }),
    });

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => null,
    });
    expect(result).toEqual({
      endpoint: 'https://admin.example.com/chatbot',
      source: 'well-known',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://admin.example.com/.well-known/chatbot-agent.json',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('returns null when no middleware found', async () => {
    const { discoverMiddleware } = await getDiscovery();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => null,
    });
    expect(result).toBeNull();
  });

  it('returns null when .well-known fetch throws', async () => {
    const { discoverMiddleware } = await getDiscovery();

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => null,
    });
    expect(result).toBeNull();
  });

  it('skips expired cache and re-discovers', async () => {
    const { discoverMiddleware } = await getDiscovery();

    // Cache from 25 hours ago (expired — 24h TTL)
    storageData['site:https://admin.example.com'] = {
      endpoint: 'https://admin.example.com/chatbot',
      discoveredAt: Date.now() - 25 * 60 * 60 * 1000,
    };

    const result = await discoverMiddleware('https://admin.example.com', {
      queryMetaTag: () => '/chatbot',
    });
    expect(result).toEqual({
      endpoint: 'https://admin.example.com/chatbot',
      source: 'meta',
    });
  });

  it('uses document.querySelector by default for meta tag', async () => {
    const { discoverMiddleware } = await getDiscovery();

    // No meta tag in this environment (no jsdom), so it falls through to .well-known
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await discoverMiddleware('https://admin.example.com');
    // Should not throw, just return null
    expect(result).toBeNull();
  });
});

describe('clearDiscoveryCache', () => {
  it('clears cached endpoint for an origin', async () => {
    const { clearDiscoveryCache } = await import('../index.js');

    await clearDiscoveryCache('https://admin.example.com');
    expect(removeMock).toHaveBeenCalledWith('site:https://admin.example.com');
  });
});
