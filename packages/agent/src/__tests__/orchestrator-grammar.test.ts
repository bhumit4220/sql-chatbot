import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../services/orchestrator.js';
import { Registry } from '../grammar/registry.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock the LLM client
vi.mock('../llm/client.js', () => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  initLLM: vi.fn(),
}));

// Mock the SQL executor
vi.mock('../services/sql-executor.js', () => ({
  validateSql: vi.fn((sql: string) => ({ valid: true, sql })),
  executeSql: vi.fn(async () => ({ rows: [{ count: 42 }], rowCount: 1 })),
}));

import { callLLM, streamLLM } from '../llm/client.js';

const userEntity = {
  name: 'user', table: 'users', displayLabel: 'User', rowCount: 100, primaryKey: 'id',
  timestamps: {}, fields: { status: { column: 'status', type: 'enum' as const, nullable: false, enumValues: { active: 1 }, searchable: false } },
  scopes: {}, associations: {}, rankingCandidates: [],
};
const registry: Registry = { version: 1, generatedAt: '', framework: 'rails', aliases: {}, entities: { user: userEntity } };

function makeSchemaService() {
  return {
    getSummary: () => 'TABLE users (id INT, status INT)',
    getTableNames: () => 'users',
    findLookupHints: () => [],
    selectSchema: () => 'TABLE users (id INT, status INT)',
    extractEnumContext: () => null,
    getTableList: () => [{ name: 'users', rowCount: 100, primaryKey: 'id', columns: [] }],
  } as any;
}

function makeCodeIndexer() {
  return { search: () => [], getRoutes: () => [] } as any;
}

describe('Orchestrator grammar integration', () => {
  let tmpLogDir: string;
  beforeEach(() => {
    tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grammar-miss-'));
    vi.clearAllMocks();
  });

  it('emits grammar_matched SSE and executes compiled SQL on hit', async () => {
    (callLLM as any).mockResolvedValueOnce(
      JSON.stringify({ type: 'data', confidence: 0.95, searchTerms: [] })   // classify response
    ).mockResolvedValueOnce(
      JSON.stringify({ status: 'matched', primitive: 'COUNT', entity: 'user', modifiers: [], confidence: 0.95 })   // intent extractor
    );
    // streamLLM is an async generator
    (streamLLM as any).mockReturnValue((async function* () { yield 'There are 42 users.'; })());

    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      registry,
      grammarConfig: { enabled: true, confidenceThreshold: 0.7, missLogPath: path.join(tmpLogDir, 'miss.ndjson') },
    });

    const events: any[] = [];
    for await (const ev of orch.handleQuestion({ question: 'how many users' })) events.push(ev);
    const types = events.map(e => e.type);
    expect(types).toContain('grammar_matched');
    expect(types).toContain('sql');
    expect(types).toContain('executing');
    expect(types).toContain('token');
    expect(types).toContain('done');
    // grammar hit path must NOT emit grammar_fallback
    expect(types).not.toContain('grammar_fallback');
  });

  it('emits grammar_fallback and logs miss when intent unmatched', async () => {
    (callLLM as any).mockResolvedValueOnce(
      JSON.stringify({ type: 'data', confidence: 0.95, searchTerms: [] })   // classify
    ).mockResolvedValueOnce(
      JSON.stringify({ status: 'unmatched', confidence: 0.2, reason: 'weird phrasing' })   // intent extractor
    ).mockResolvedValueOnce(
      JSON.stringify({ sql: 'SELECT 1', explanation: 'fallback' })          // LLM SQL generator
    );
    (streamLLM as any).mockReturnValue((async function* () { yield 'answer'; })());

    const logPath = path.join(tmpLogDir, 'miss.ndjson');
    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      registry,
      grammarConfig: { enabled: true, confidenceThreshold: 0.7, missLogPath: logPath },
    });

    const events: any[] = [];
    for await (const ev of orch.handleQuestion({ question: 'compare X to average' })) events.push(ev);
    const types = events.map(e => e.type);
    expect(types).toContain('grammar_fallback');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('weird phrasing');
  });

  it('skips grammar entirely when grammarConfig.enabled=false', async () => {
    (callLLM as any).mockResolvedValueOnce(
      JSON.stringify({ type: 'data', confidence: 0.95, searchTerms: [] })
    ).mockResolvedValueOnce(
      JSON.stringify({ sql: 'SELECT 1', explanation: '' })
    );
    (streamLLM as any).mockReturnValue((async function* () { yield 'answer'; })());

    const orch = new Orchestrator({
      schemaService: makeSchemaService(),
      codeIndexer: makeCodeIndexer(),
      databaseUrl: 'postgresql://fake',
      registry,
      grammarConfig: { enabled: false, confidenceThreshold: 0.7, missLogPath: path.join(tmpLogDir, 'miss.ndjson') },
    });

    const events: any[] = [];
    for await (const ev of orch.handleQuestion({ question: 'how many users' })) events.push(ev);
    const types = events.map(e => e.type);
    expect(types).not.toContain('grammar_matched');
    expect(types).not.toContain('grammar_fallback');
  });
});
