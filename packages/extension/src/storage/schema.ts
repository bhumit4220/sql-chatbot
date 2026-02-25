import type { DBSchema } from 'idb';
import type { CrawledPage, PageContext } from '@chatbot/shared';

export interface ChatbotDB extends DBSchema {
  crawled_pages: {
    key: string; // page URL
    value: CrawledPage;
    indexes: {
      'by-expiry': number;
    };
  };
  chat_history: {
    key: number; // auto-increment
    value: {
      id?: number;
      origin: string;
      conversationId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      pageContext?: PageContext;
    };
    indexes: {
      'by-conversation': string;
      'by-origin': string;
      'by-timestamp': number;
    };
  };
  settings: {
    key: string;
    value: {
      key: string;
      value: unknown;
    };
  };
}

export const DB_NAME = 'sql-chatbot';
export const DB_VERSION = 2;
