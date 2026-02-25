import type {
  ExtensionMessage,
  ChatQuestionPayload,
  PageContext,
  QuestionType,
  ChatMessage,
  TableSchema,
  ClassifyResult,
  CodeChunk,
  EnumMapping,
} from '@chatbot/shared';
import { AgentClient } from './agent-client.js';

let agentClient: AgentClient | null = null;

export function setAgentClient(client: AgentClient): void {
  agentClient = client;
}

export function getAgentClient(): AgentClient | null {
  return agentClient;
}

// ---------------------------------------------------------------------------
// Tab messaging helpers — avoid repetition across the pipeline
// ---------------------------------------------------------------------------

function sendChunk(tabId: number, token: string): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'CHAT_RESPONSE_CHUNK',
    payload: { token },
  });
}

function sendDone(tabId: number): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'CHAT_RESPONSE_DONE',
    payload: {},
  });
}

function sendError(tabId: number, error: string): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'CHAT_ERROR',
    payload: { error },
  });
}

// ---------------------------------------------------------------------------
// Schema formatting — turns TableSchema[] into a compact summary string
// e.g. "customers(id,name,email), jobs(id,status,created_by)"
// ---------------------------------------------------------------------------

function formatSchemaSummary(tables: TableSchema[]): string {
  return tables
    .map((t) => `${t.name}(${t.columns.map((c) => c.name).join(',')})`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Enum formatting — turns EnumMapping[] into a human-readable string for
// the SQL-generation prompt so the LLM knows which integer maps to what.
// ---------------------------------------------------------------------------

function formatEnums(enums: EnumMapping[]): string {
  return enums
    .map((e) => {
      const pairs = Object.entries(e.mappings)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return `${e.table}.${e.column}: ${pairs}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Page-context serialisation — converts the structured PageContext into a
// short string the LLM can consume alongside the question.
// ---------------------------------------------------------------------------

function formatPageContext(ctx: PageContext): string {
  let s = `URL: ${ctx.url}\nTitle: ${ctx.title}`;
  if (ctx.heading) s += `\nHeading: ${ctx.heading}`;
  if (ctx.breadcrumbs?.length) s += `\nBreadcrumbs: ${ctx.breadcrumbs.join(' > ')}`;
  if (ctx.navigation?.length) {
    const navList = ctx.navigation
      .map((n) => `- ${n.text}: ${n.href}`)
      .join('\n');
    s += `\n\nNavigation Links:\n${navList}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Orchestration pipeline — runs the full classify -> fetch -> stream cycle.
// Fires-and-forgets from the CHAT_QUESTION handler so the content script
// gets an immediate `{ streaming: true }` acknowledgement.
// ---------------------------------------------------------------------------

async function runOrchestration(
  client: AgentClient,
  tabId: number,
  payload: ChatQuestionPayload,
): Promise<void> {
  const { question, pageContext } = payload;
  const history: ChatMessage[] = (payload as any).history ?? [];
  const pageCtxString = pageContext ? formatPageContext(pageContext) : undefined;

  // Step 1 — Fetch schema from the agent
  const schemaRes = await client.get<{ tables: TableSchema[] }>('/db/schema');
  const tables = schemaRes.tables;
  const schemaSummary = formatSchemaSummary(tables);
  // Full schema string (for SQL generation — includes types, PKs, FKs)
  const fullSchema = JSON.stringify(tables);

  // Step 2 — Classify the question
  const classifyRes = await client.post<ClassifyResult>('/llm/classify', {
    question,
    schemaSummary,
    pageContext: pageCtxString,
    history,
  });
  const questionType: QuestionType = classifyRes.type;

  // Step 3 — Branch by question type
  switch (questionType) {
    // ----- DATA: schema + enums SQL ----------------------------------------
    case 'data': {
      // Fetch discovery results (enums) so the LLM knows status=1 means Active, etc.
      const discoveryRes = await client.get<{ enums: EnumMapping[] }>('/discovery/results');
      const enumsString = formatEnums(discoveryRes.enums ?? []);

      const sqlRes = await client.post<{ sql: string; explanation: string; confidence: number }>(
        '/llm/generate-sql',
        { question, schema: fullSchema, enums: enumsString, history },
      );
      const queryRes = await client.post<{ columns: string[]; rows: Record<string, unknown>[]; totalCount: number; executionTimeMs: number }>(
        '/db/query',
        { sql: sqlRes.sql },
      );
      await client.streamSSE(
        '/llm/answer',
        {
          question,
          sqlResults: JSON.stringify(queryRes),
          questionType: 'data',
          history,
          pageContext: pageCtxString,
        },
        (token) => sendChunk(tabId, token),
      );
      sendDone(tabId);
      break;
    }

    // ----- DATA_WITH_CODE: needs business logic from code + enums ---------
    case 'data_with_code': {
      // Fetch code context and discovery results in parallel
      const [codeRes, discoveryRes] = await Promise.all([
        client.post<{ results: CodeChunk[] }>('/code/search', { query: question }),
        client.get<{ enums: EnumMapping[] }>('/discovery/results'),
      ]);

      const codeContext = codeRes.results
        .map((c) => `// ${c.file}:${c.lineStart}-${c.lineEnd}\n${c.content}`)
        .join('\n\n');
      const enumsString = formatEnums(discoveryRes.enums ?? []);

      const sqlRes = await client.post<{ sql: string; explanation: string; confidence: number }>(
        '/llm/generate-sql',
        { question, schema: fullSchema, codeContext, enums: enumsString, history },
      );
      const queryRes = await client.post<{ columns: string[]; rows: Record<string, unknown>[]; totalCount: number; executionTimeMs: number }>(
        '/db/query',
        { sql: sqlRes.sql },
      );
      await client.streamSSE(
        '/llm/answer',
        {
          question,
          sqlResults: JSON.stringify(queryRes),
          questionType: 'data_with_code',
          history,
          pageContext: pageCtxString,
        },
        (token) => sendChunk(tabId, token),
      );
      sendDone(tabId);
      break;
    }

    // ----- CODE: answer directly from code search results -----------------
    case 'code': {
      const codeRes = await client.post<{ results: CodeChunk[] }>('/code/search', {
        query: question,
      });
      await client.streamSSE(
        '/llm/answer-from-code',
        {
          question,
          codeChunks: codeRes.results,
          history,
          pageContext: pageCtxString,
        },
        (token) => sendChunk(tabId, token),
      );
      sendDone(tabId);
      break;
    }

    // ----- NAVIGATION / GUIDANCE: answer with no SQL ----------------------
    case 'navigation':
    case 'guidance': {
      await client.streamSSE(
        '/llm/answer',
        {
          question,
          questionType,
          history,
          pageContext: pageCtxString,
        },
        (token) => sendChunk(tabId, token),
      );
      sendDone(tabId);
      break;
    }

    // ----- ACTION: DOM interaction — not yet implemented ------------------
    case 'action': {
      chrome.tabs.sendMessage(tabId, {
        type: 'CHAT_RESPONSE_CHUNK',
        payload: {
          token: 'Action mode is not yet implemented. Please describe what you need and I can guide you through the steps instead.',
        },
      });
      sendDone(tabId);
      break;
    }

    default: {
      // Fallback — treat unknown types as guidance
      await client.streamSSE(
        '/llm/answer',
        { question, questionType: 'guidance', history, pageContext: pageCtxString },
        (token) => sendChunk(tabId, token),
      );
      sendDone(tabId);
    }
  }
}

// ---------------------------------------------------------------------------
// Message router — wires chrome.runtime.onMessage to handleMessage
// ---------------------------------------------------------------------------

// Promise that resolves once session storage has been checked for a saved token.
let sessionReadyPromise: Promise<void> = Promise.resolve();

/**
 * Routes messages from content scripts to the agent and back.
 * All agent HTTP calls go through the background worker.
 *
 * @param sessionReady — resolves once chrome.storage.session restoration is done.
 *   This prevents the MV3 race condition where a message arrives before the
 *   async storage callback has fired.
 */
export function setupMessageRouter(sessionReady?: Promise<void>): void {
  if (sessionReady) sessionReadyPromise = sessionReady;

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    // Wait for session restoration before handling any message
    sessionReadyPromise
      .then(() => handleMessage(message, sender))
      .then(sendResponse)
      .catch(err => {
        sendResponse({ error: err.message });
      });
    return true; // Keep channel open for async response
  });
}

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'AGENT_STATUS': {
      try {
        const status = await agentClient?.get('/auth/status');
        return { connected: true, ...status };
      } catch {
        return { connected: false };
      }
    }

    case 'CHAT_QUESTION': {
      if (!agentClient) throw new Error('Not connected to agent');
      const payload = message.payload as ChatQuestionPayload;

      const tabId = sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');

      // Fire-and-forget: run the full orchestration pipeline in the
      // background and stream results back to the content script tab.
      runOrchestration(agentClient, tabId, payload).catch((err) => {
        sendError(tabId, err.message ?? 'Orchestration failed');
      });

      return { streaming: true };
    }

    case 'PAGE_CONTEXT': {
      // Store page context from content script
      return { received: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
