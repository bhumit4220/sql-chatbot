import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../services/orchestrator.js';
import { Registry } from '../grammar/registry.js';

// Mock the LLM client identically to orchestrator-grammar.test.ts
vi.mock('../llm/client.js', () => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  initLLM: vi.fn(),
}));
vi.mock('../services/sql-executor.js', () => ({
  validateSql: vi.fn((sql: string) => ({ valid: true, sql })),
  executeSql: vi.fn(async () => ({ rows: [{ count: 1 }], rowCount: 1 })),
}));

import { callLLM, streamLLM } from '../llm/client.js';

function makeSchemaService() {
  return {
    getSummary: () => 'TABLE users (id INT)',
    getTableNames: () => 'users',
    findLookupHints: () => [],
    selectSchema: () => 'TABLE users (id INT)',
    extractEnumContext: () => null,
    getTableList: () => [{ name: 'users', rowCount: 1, primaryKey: 'id', columns: [] }],
  } as any;
}
function makeCodeIndexer() {
  return { search: () => [], getRoutes: () => [] } as any;
}

// 20 representative questions — all just "data" type with a fixed SQL response.
const FIXTURES = [
  'how many users',
  'list all orders',
  'total revenue this month',
  'top 5 products by sales',
  'average order value',
  'who are our best customers',
  'show products in stock',
  'what was our revenue yesterday',
  'how many signups last week',
  'list orders placed today',
  'which users signed up in the last 30 days',
  'total sales by country',
  'highest-rated products',
  'lowest-stock items',
  'oldest active user',
  'most recent orders',
  'count of banned users',
  'pending orders',
  'weekly revenue trend',
  'orders per customer',
];

function stubLLMResponses() {
  (callLLM as any).mockImplementation(async (messages: any) => {
    // Heuristically return classify or SQL response based on prompt content
    const sys = typeof messages === 'string' ? messages : JSON.stringify(messages);
    if (sys.includes('Classify') || sys.includes('question classifier')) {
      return JSON.stringify({ type: 'data', confidence: 0.9, searchTerms: [] });
    }
    return JSON.stringify({ sql: 'SELECT 1', explanation: 'fixed mock' });
  });
  (streamLLM as any).mockImplementation(() =>
    (async function* () { yield 'answer'; })()
  );
}

// Expected SSE event type sequence for the grammar-disabled path.
// Represents: classifying → classified → sql → executing → token* → done
const EXPECTED_EVENT_TYPES = ['classifying', 'classified', 'sql', 'executing', 'token', 'done'];

async function runQuestion(orchestrator: Orchestrator, question: string): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of orchestrator.handleQuestion({ question })) {
    types.push(ev.type);
  }
  return types;
}

const userEntity: any = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 100, primaryKey: 'id',
  timestamps: {}, fields: {}, scopes: {}, associations: {}, rankingCandidates: [],
};
const registry: Registry = { version: 1, generatedAt: '', framework: 'rails', aliases: {}, entities: { user: userEntity } };

describe('grammar-disabled parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubLLMResponses();
  });

  it('grammar.enabled=false produces only existing pipeline events (no grammar_matched/grammar_fallback)', async () => {
    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      registry,
      grammarConfig: { enabled: false, confidenceThreshold: 0.7, missLogPath: '/tmp/miss.ndjson' },
    });
    for (const question of FIXTURES) {
      const events = await runQuestion(orch, question);
      expect(events).not.toContain('grammar_matched');
      expect(events).not.toContain('grammar_fallback');
      // The core existing-pipeline events must be present
      expect(events).toContain('classifying');
      expect(events).toContain('classified');
      expect(events).toContain('done');
    }
  });

  it('no registry provided also disables grammar (registry undefined)', async () => {
    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      // no registry, no grammarConfig
    });
    for (const question of FIXTURES.slice(0, 5)) {
      const events = await runQuestion(orch, question);
      expect(events).not.toContain('grammar_matched');
      expect(events).not.toContain('grammar_fallback');
    }
  });

  it('grammar enabled + no registry still disables grammar (double-guard)', async () => {
    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      grammarConfig: { enabled: true, confidenceThreshold: 0.7, missLogPath: '/tmp/miss.ndjson' },
      // no registry!
    });
    const events = await runQuestion(orch, 'how many users');
    expect(events).not.toContain('grammar_matched');
    expect(events).not.toContain('grammar_fallback');
  });
});
