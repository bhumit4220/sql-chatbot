/**
 * Storage module unit tests — IndexedDB CRUD via fake-indexeddb.
 *
 * V3: Origin-based keying. No projects store. Chat history keyed by origin.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect, vi } from 'vitest';

// Re-create a pristine IndexedDB before every test so the module-level
// singleton inside storage/index.ts starts from scratch.
beforeEach(async () => {
  vi.resetModules();
  const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
});

/** Dynamic import so each test picks up the freshly-reset indexedDB. */
async function getStorage() {
  return await import('../index.js');
}

// ---------------------------------------------------------------------------
// Chat history (origin-based)
// ---------------------------------------------------------------------------

describe('Chat history CRUD', () => {
  it('adds a message and retrieves it by conversation', async () => {
    const s = await getStorage();

    const id = await s.addChatMessage({
      origin: 'https://admin.mowsnowpros.com',
      conversationId: 'conv-1',
      role: 'user',
      content: 'How many customers?',
    });

    expect(id).toBeTypeOf('number');

    const messages = await s.getConversationHistory('conv-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('How many customers?');
    expect(messages[0].role).toBe('user');
    expect(messages[0].conversationId).toBe('conv-1');
    expect(messages[0].origin).toBe('https://admin.mowsnowpros.com');
    expect(messages[0].timestamp).toBeTypeOf('number');
  });

  it('retrieves only messages for the requested conversation', async () => {
    const s = await getStorage();

    await s.addChatMessage({ origin: 'https://example.com', conversationId: 'c-a', role: 'user', content: 'A1' });
    await s.addChatMessage({ origin: 'https://example.com', conversationId: 'c-b', role: 'user', content: 'B1' });
    await s.addChatMessage({ origin: 'https://example.com', conversationId: 'c-a', role: 'assistant', content: 'A2' });

    const msgsA = await s.getConversationHistory('c-a');
    expect(msgsA).toHaveLength(2);
    expect(msgsA.map((m) => m.content)).toEqual(['A1', 'A2']);

    const msgsB = await s.getConversationHistory('c-b');
    expect(msgsB).toHaveLength(1);
  });

  it('clears chat history for a specific origin', async () => {
    const s = await getStorage();

    await s.addChatMessage({ origin: 'https://site-a.com', conversationId: 'c1', role: 'user', content: 'A msg' });
    await s.addChatMessage({ origin: 'https://site-b.com', conversationId: 'c2', role: 'user', content: 'B msg' });

    await s.clearChatHistory('https://site-a.com');

    const a = await s.getConversationHistory('c1');
    const b = await s.getConversationHistory('c2');
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it('clears all chat history when no origin given', async () => {
    const s = await getStorage();

    await s.addChatMessage({ origin: 'https://site-a.com', conversationId: 'c1', role: 'user', content: 'msg1' });
    await s.addChatMessage({ origin: 'https://site-b.com', conversationId: 'c2', role: 'user', content: 'msg2' });

    await s.clearChatHistory();

    expect(await s.getConversationHistory('c1')).toHaveLength(0);
    expect(await s.getConversationHistory('c2')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conversation limit
// ---------------------------------------------------------------------------

describe('getConversationHistory limit', () => {
  it('returns only the last N messages when limit is set', async () => {
    const s = await getStorage();

    for (let i = 1; i <= 5; i++) {
      await s.addChatMessage({
        origin: 'https://example.com',
        conversationId: 'conv-limit',
        role: 'user',
        content: `msg-${i}`,
      });
    }

    const limited = await s.getConversationHistory('conv-limit', 2);
    expect(limited).toHaveLength(2);
    // Should be the LAST 2 messages (slice(-2))
    expect(limited[0].content).toBe('msg-4');
    expect(limited[1].content).toBe('msg-5');
  });
});

// ---------------------------------------------------------------------------
// Origin-based history retrieval
// ---------------------------------------------------------------------------

describe('getOriginHistory', () => {
  it('retrieves all messages for a specific origin', async () => {
    const s = await getStorage();

    await s.addChatMessage({ origin: 'https://site-a.com', conversationId: 'c1', role: 'user', content: 'A1' });
    await s.addChatMessage({ origin: 'https://site-b.com', conversationId: 'c2', role: 'user', content: 'B1' });
    await s.addChatMessage({ origin: 'https://site-a.com', conversationId: 'c1', role: 'assistant', content: 'A2' });

    const msgs = await s.getOriginHistory('https://site-a.com');
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.content)).toEqual(['A1', 'A2']);
  });

  it('returns empty array for unknown origin', async () => {
    const s = await getStorage();
    const msgs = await s.getOriginHistory('https://unknown.com');
    expect(msgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('Settings CRUD', () => {
  it('sets and gets a string setting', async () => {
    const s = await getStorage();
    await s.setSetting('theme', 'dark');

    const val = await s.getSetting<string>('theme');
    expect(val).toBe('dark');
  });

  it('sets and gets an object setting', async () => {
    const s = await getStorage();
    const config = { fontSize: 14, compact: true };
    await s.setSetting('uiConfig', config);

    const val = await s.getSetting<typeof config>('uiConfig');
    expect(val).toEqual(config);
  });

  it('returns undefined for a non-existent setting', async () => {
    const s = await getStorage();
    const val = await s.getSetting('missing');
    expect(val).toBeUndefined();
  });

  it('overwrites an existing setting', async () => {
    const s = await getStorage();
    await s.setSetting('key', 'first');
    await s.setSetting('key', 'second');

    const val = await s.getSetting<string>('key');
    expect(val).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// Crawled pages
// ---------------------------------------------------------------------------

describe('Crawled pages CRUD', () => {
  const page = {
    url: 'https://admin.example.com/customers',
    title: 'Customers',
    navigation: [],
    forms: [],
    buttons: [],
    tables: [],
    crawledAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };

  it('saves and retrieves a crawled page by URL', async () => {
    const s = await getStorage();
    await s.saveCrawledPage(page);

    const fetched = await s.getCrawledPage(page.url);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Customers');
  });

  it('returns undefined for a non-existent URL', async () => {
    const s = await getStorage();
    const result = await s.getCrawledPage('https://nope.example.com');
    expect(result).toBeUndefined();
  });

  it('getAllCrawledPages returns all saved pages', async () => {
    const s = await getStorage();
    await s.saveCrawledPage(page);
    await s.saveCrawledPage({ ...page, url: 'https://admin.example.com/jobs', title: 'Jobs' });

    const all = await s.getAllCrawledPages();
    expect(all).toHaveLength(2);
  });

  it('upserts a crawled page with same URL', async () => {
    const s = await getStorage();
    await s.saveCrawledPage(page);
    await s.saveCrawledPage({ ...page, title: 'Updated Title' });

    const all = await s.getAllCrawledPages();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Updated Title');
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('cleanupExpired', () => {
  it('deletes expired crawled pages', async () => {
    const s = await getStorage();

    await s.saveCrawledPage({
      url: 'https://expired.example.com',
      title: 'Expired',
      navigation: [],
      forms: [],
      buttons: [],
      tables: [],
      crawledAt: Date.now() - 7_200_000,
      expiresAt: Date.now() - 1000,
    });

    await s.saveCrawledPage({
      url: 'https://valid.example.com',
      title: 'Valid',
      navigation: [],
      forms: [],
      buttons: [],
      tables: [],
      crawledAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    const result = await s.cleanupExpired();
    expect(result.crawlDeleted).toBe(1);

    const remaining = await s.getAllCrawledPages();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Valid');
  });

  it('deletes old chat messages beyond retention period', async () => {
    const s = await getStorage();

    const originalNow = Date.now;

    // Insert old message (8 days ago)
    const eightDaysAgo = originalNow() - 8 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(eightDaysAgo);
    await s.addChatMessage({
      origin: 'https://example.com',
      conversationId: 'c1',
      role: 'user',
      content: 'old message',
    });

    // Insert recent message
    vi.spyOn(Date, 'now').mockReturnValue(originalNow());
    await s.addChatMessage({
      origin: 'https://example.com',
      conversationId: 'c1',
      role: 'user',
      content: 'recent message',
    });

    vi.restoreAllMocks();

    const result = await s.cleanupExpired();
    expect(result.chatDeleted).toBe(1);

    const remaining = await s.getConversationHistory('c1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('recent message');
  });
});

// ---------------------------------------------------------------------------
// No projects store (V3 removed it)
// ---------------------------------------------------------------------------

describe('V3 schema changes', () => {
  it('does not have a projects store', async () => {
    const { DB_NAME, DB_VERSION } = await import('../schema.js');
    expect(DB_VERSION).toBe(2);

    const { openDB } = await import('idb');
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Just check the store names
      },
    });
    expect(Array.from(db.objectStoreNames)).not.toContain('projects');
    db.close();
  });
});
