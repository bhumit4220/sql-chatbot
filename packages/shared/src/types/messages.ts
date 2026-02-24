// Chrome extension message types (content script <-> background worker)

export type MessageType =
  | 'CHAT_QUESTION'
  | 'CHAT_RESPONSE_CHUNK'
  | 'CHAT_RESPONSE_DONE'
  | 'CHAT_ERROR'
  | 'AGENT_STATUS'
  | 'CRAWL_START'
  | 'CRAWL_PROGRESS'
  | 'CRAWL_DONE'
  | 'ACTION_EXECUTE'
  | 'ACTION_RESULT'
  | 'PAGE_CONTEXT';

export interface ExtensionMessage {
  type: MessageType;
  payload: unknown;
}

export interface ChatQuestionPayload {
  question: string;
  conversationId: string;
  pageContext: PageContext;
}

export interface PageContext {
  url: string;
  title: string;
  heading?: string;
  navigation: NavItem[];
  breadcrumbs?: string[];
}

export interface NavItem {
  text: string;
  href: string;
  selector?: string;
  children?: NavItem[];
}

export interface CrawlProgressPayload {
  current: number;
  total: number;
  currentUrl: string;
}

export interface CrawledPage {
  url: string;
  title: string;
  navigation: NavItem[];
  forms: FormInfo[];
  buttons: ButtonInfo[];
  tables: TableInfo[];
  crawledAt: number;
  expiresAt: number;
}

export interface FormInfo {
  action?: string;
  fields: FormField[];
}

export interface FormField {
  label: string;
  selector: string;
  type: string;
  options?: string[];
  required: boolean;
}

export interface ButtonInfo {
  text: string;
  selector: string;
  actionType: 'read' | 'create' | 'destructive' | 'unknown';
}

export interface TableInfo {
  headers: string[];
  selector: string;
}
