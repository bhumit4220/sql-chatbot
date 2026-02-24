import { openDB, type IDBPDatabase } from 'idb';
import type { ChatbotDB } from './schema.js';
import { DB_NAME, DB_VERSION } from './schema.js';
import type { CrawledPage, PageContext } from '@chatbot/shared';
import { CHAT_HISTORY_RETENTION_DAYS } from '@chatbot/shared';

let dbPromise: Promise<IDBPDatabase<ChatbotDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ChatbotDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatbotDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Projects store
        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('by-lastUsed', 'lastUsedAt');
        }

        // Crawled pages store
        if (!db.objectStoreNames.contains('crawled_pages')) {
          const crawlStore = db.createObjectStore('crawled_pages', { keyPath: 'url' });
          crawlStore.createIndex('by-expiry', 'expiresAt');
        }

        // Chat history store
        if (!db.objectStoreNames.contains('chat_history')) {
          const chatStore = db.createObjectStore('chat_history', {
            keyPath: 'id',
            autoIncrement: true,
          });
          chatStore.createIndex('by-conversation', 'conversationId');
          chatStore.createIndex('by-project', 'projectId');
          chatStore.createIndex('by-timestamp', 'timestamp');
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// === Chat History ===

export async function addChatMessage(message: {
  projectId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  pageContext?: PageContext;
}): Promise<number> {
  const db = await getDB();
  return db.add('chat_history', {
    ...message,
    timestamp: Date.now(),
  });
}

export async function getConversationHistory(
  conversationId: string,
  limit: number = 20
): Promise<ChatbotDB['chat_history']['value'][]> {
  const db = await getDB();
  const tx = db.transaction('chat_history', 'readonly');
  const index = tx.store.index('by-conversation');
  const messages = await index.getAll(conversationId);
  return messages.slice(-limit);
}

export async function clearChatHistory(projectId?: string): Promise<void> {
  const db = await getDB();
  if (projectId) {
    const tx = db.transaction('chat_history', 'readwrite');
    const index = tx.store.index('by-project');
    let cursor = await index.openCursor(projectId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  } else {
    await db.clear('chat_history');
  }
}

// === Crawled Pages ===

export async function saveCrawledPage(page: CrawledPage): Promise<void> {
  const db = await getDB();
  await db.put('crawled_pages', page);
}

export async function getCrawledPage(url: string): Promise<CrawledPage | undefined> {
  const db = await getDB();
  return db.get('crawled_pages', url);
}

export async function getAllCrawledPages(): Promise<CrawledPage[]> {
  const db = await getDB();
  return db.getAll('crawled_pages');
}

// === Projects ===

export async function saveProject(project: ChatbotDB['projects']['value']): Promise<void> {
  const db = await getDB();
  await db.put('projects', project);
}

export async function getProject(id: string): Promise<ChatbotDB['projects']['value'] | undefined> {
  const db = await getDB();
  return db.get('projects', id);
}

export async function getAllProjects(): Promise<ChatbotDB['projects']['value'][]> {
  const db = await getDB();
  return db.getAll('projects');
}

// === Settings ===

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const result = await db.get('settings', key);
  return result?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put('settings', { key, value });
}

// === Cleanup ===

export async function cleanupExpired(): Promise<{ chatDeleted: number; crawlDeleted: number }> {
  const db = await getDB();
  let chatDeleted = 0;
  let crawlDeleted = 0;

  // Clean old chat messages
  const chatCutoff = Date.now() - CHAT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const chatTx = db.transaction('chat_history', 'readwrite');
  const chatIndex = chatTx.store.index('by-timestamp');
  let chatCursor = await chatIndex.openCursor(IDBKeyRange.upperBound(chatCutoff));
  while (chatCursor) {
    await chatCursor.delete();
    chatDeleted++;
    chatCursor = await chatCursor.continue();
  }

  // Clean expired crawled pages
  const crawlTx = db.transaction('crawled_pages', 'readwrite');
  const crawlIndex = crawlTx.store.index('by-expiry');
  let crawlCursor = await crawlIndex.openCursor(IDBKeyRange.upperBound(Date.now()));
  while (crawlCursor) {
    await crawlCursor.delete();
    crawlDeleted++;
    crawlCursor = await crawlCursor.continue();
  }

  return { chatDeleted, crawlDeleted };
}
