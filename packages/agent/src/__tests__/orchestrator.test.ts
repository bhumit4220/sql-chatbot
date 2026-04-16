import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SchemaService } from '../services/schema.js';
import type { CodeIndexer } from '../services/code-indexer.js';

// --- Mocks for LLM and SQL executor ---

const mockCallLLM = vi.fn();
const mockStreamLLM = vi.fn();

vi.mock('../llm/client.js', () => ({
  callLLM: (...args: unknown[]) => mockCallLLM(...args),
  streamLLM: (...args: unknown[]) => mockStreamLLM(...args),
}));

const mockValidateSql = vi.fn();
const mockExecuteSql = vi.fn();

vi.mock('../services/sql-executor.js', () => ({
  validateSql: (...args: unknown[]) => mockValidateSql(...args),
  executeSql: (...args: unknown[]) => mockExecuteSql(...args),
}));

// --- Import after mocks ---

import { Orchestrator } from '../services/orchestrator.js';
import type { SSEEvent, AskInput } from '../services/orchestrator.js';

// --- Helpers ---

async function collectEvents(gen: AsyncGenerator<SSEEvent>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function createMockSchemaService(summary = 'TABLE users (id INT PK, name VARCHAR)'): SchemaService {
  return {
    getSummary: vi.fn(() => summary),
    getTableNames: vi.fn(() => 'Available tables: users'),
    selectSchema: vi.fn(() => summary),
    extractEnumContext: vi.fn(() => ''),
    findLookupHints: vi.fn(() => []),
    tableCount: vi.fn(() => 1),
    discover: vi.fn(),
    refresh: vi.fn(),
  } as unknown as SchemaService;
}

function createMockCodeIndexer(): CodeIndexer {
  const indexer = {
    search: vi.fn(() => []),
    getRoutes: vi.fn(() => []),
    getRouteSummary: vi.fn(() => 'No routes detected.'),
    fileCount: vi.fn(() => 0),
    index: vi.fn(),
  };
  return indexer as unknown as CodeIndexer;
}

/** Helper to make mockStreamLLM return an async generator yielding given chunks */
function mockStream(...chunks: string[]) {
  mockStreamLLM.mockImplementation(async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  });
}

/** Helper to set up classification response */
function mockClassification(type: string, confidence = 0.95, searchTerms?: string[]) {
  const response: Record<string, unknown> = { type, confidence };
  if (searchTerms) response.searchTerms = searchTerms;

  // callLLM is called for classify (1st call) and optionally generate-sql (2nd call)
  // We return the classification JSON on the first call by default
  mockCallLLM.mockResolvedValueOnce(JSON.stringify(response));
}

function mockSqlGeneration(sql: string, explanation = 'test query') {
  mockCallLLM.mockResolvedValueOnce(JSON.stringify({ sql, explanation }));
}

// ============================================================
// Tests
// ============================================================

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let schemaService: SchemaService;
  let codeIndexer: CodeIndexer;
  const databaseUrl = 'postgres://localhost/testdb';

  beforeEach(() => {
    vi.clearAllMocks();
    schemaService = createMockSchemaService();
    codeIndexer = createMockCodeIndexer();
    orchestrator = new Orchestrator({ schemaService, codeIndexer, databaseUrl });
  });

  // 1. Data question: classifies → generates SQL → validates → executes → streams answer
  it('1. handles data question end-to-end', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT COUNT(*) FROM users');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT COUNT(*) FROM users' });
    mockExecuteSql.mockResolvedValue({
      columns: ['count'],
      rows: [{ count: 42 }],
      rowCount: 1,
    });
    mockStream('There are ', '42 users.');

    const input: AskInput = { question: 'How many users are there?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    // Verify event types in order
    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('sql');
    expect(types).toContain('executing');
    expect(types).toContain('token');
    expect(types).toContain('done');

    // Verify classified event has questionType
    const classified = events.find((e) => e.type === 'classified');
    expect(classified?.questionType).toBe('data');

    // Verify SQL event
    const sqlEvent = events.find((e) => e.type === 'sql');
    expect(sqlEvent?.sql).toBe('SELECT COUNT(*) FROM users');

    // Verify token events
    const tokens = events.filter((e) => e.type === 'token').map((e) => e.content);
    expect(tokens).toEqual(['There are ', '42 users.']);

    // Verify executeSql was called with correct args
    expect(mockExecuteSql).toHaveBeenCalledWith(databaseUrl, 'SELECT COUNT(*) FROM users');
  });

  // 2. Data_with_code question
  it('2. handles data_with_code question with code search', async () => {
    mockClassification('data_with_code', 0.9, ['calculateTotal', 'pricing']);
    (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { file: 'services/pricing.ts', content: 'function calculateTotal() {}', matchCount: 2 },
    ]);
    mockSqlGeneration('SELECT id, total FROM orders');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT id, total FROM orders' });
    mockExecuteSql.mockResolvedValue({
      columns: ['id', 'total'],
      rows: [{ id: 1, total: 100 }],
      rowCount: 1,
    });
    mockStream('The total is $100.');

    const input: AskInput = { question: 'Show orders where calculated total > $50' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    // Should have searched code index
    expect(codeIndexer.search).toHaveBeenCalledWith(['calculateTotal', 'pricing']);

    // Should have all expected event types
    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('sql');
    expect(types).toContain('executing');
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  // 3. Code question: classifies → searches code → streams explanation
  it('3. handles code question with code search', async () => {
    mockClassification('code', 0.9, ['pricing', 'discount']);
    (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { file: 'services/pricing.ts', content: 'function applyDiscount() {}', matchCount: 2 },
    ]);
    mockStream('The discount is applied in ', 'pricing.ts.');

    const input: AskInput = { question: 'How does the discount logic work?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    expect(codeIndexer.search).toHaveBeenCalledWith(['pricing', 'discount']);

    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('token');
    expect(types).toContain('done');

    // Should NOT have SQL events for code questions
    expect(types).not.toContain('sql');
    expect(types).not.toContain('executing');
  });

  // 3b. Code question with no results
  it('3b. handles code question with no search results', async () => {
    mockClassification('code', 0.9, ['nonexistent']);
    (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const input: AskInput = { question: 'How does the nonexistent module work?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const tokens = events.filter((e) => e.type === 'token').map((e) => e.content);
    const fullText = tokens.join('');
    expect(fullText.toLowerCase()).toContain("couldn't find");

    // No streamLLM call since we short-circuit
    expect(mockStreamLLM).not.toHaveBeenCalled();
  });

  // 4. Navigation question: classifies → streams guidance with route summary
  it('4. handles navigation question', async () => {
    mockClassification('navigation');
    (codeIndexer.getRouteSummary as ReturnType<typeof vi.fn>).mockReturnValue(
      'Routes detected:\nGET /users → pages/users.tsx'
    );
    mockStream('You can find users at ', '/users.');

    const input: AskInput = {
      question: 'Where is the users page?',
      pageContext: 'Current page: /dashboard',
    };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('token');
    expect(types).toContain('done');
    expect(types).not.toContain('sql');

    // Verify streamLLM was called (answer prompt includes routeSummary)
    expect(mockStreamLLM).toHaveBeenCalled();
  });

  // 4b. Guidance question
  it('4b. handles guidance question', async () => {
    mockClassification('guidance');
    (codeIndexer.getRouteSummary as ReturnType<typeof vi.fn>).mockReturnValue(
      'Routes detected:\nPOST /users → controllers/users.ts'
    );
    mockStream('To create a user, ', 'click the + button.');

    const input: AskInput = {
      question: 'How do I create a new user?',
      pageContext: 'Current page: /users',
    };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('classified');
    const classified = events.find((e) => e.type === 'classified');
    expect(classified?.questionType).toBe('guidance');
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  // 5. Unsafe question: classifies → yields blocked message without LLM call
  it('5. handles unsafe question without LLM call', async () => {
    mockClassification('unsafe');

    const input: AskInput = { question: 'DROP TABLE users;' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('token');
    expect(types).toContain('done');

    // Should NOT call streamLLM for unsafe
    expect(mockStreamLLM).not.toHaveBeenCalled();

    // The token should contain a refusal message
    const tokens = events.filter((e) => e.type === 'token').map((e) => e.content);
    const fullText = tokens.join('');
    expect(fullText.toLowerCase()).toContain("can't help");
  });

  // 5b. Greeting question: classifies → streams friendly response without SQL
  it('5b. handles greeting question with LLM response', async () => {
    mockClassification('greeting');
    mockStream('Hi there! I can help you ', 'explore your data.');

    const input: AskInput = { question: 'Hello! What can you do?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('classifying');
    expect(types).toContain('classified');
    expect(types).toContain('token');
    expect(types).toContain('done');

    // Should NOT have SQL events
    expect(types).not.toContain('sql');
    expect(types).not.toContain('executing');

    // Should have called streamLLM (unlike unsafe)
    expect(mockStreamLLM).toHaveBeenCalled();

    const classified = events.find((e) => e.type === 'classified');
    expect(classified?.questionType).toBe('greeting');

    const tokens = events.filter((e) => e.type === 'token').map((e) => e.content);
    expect(tokens).toEqual(['Hi there! I can help you ', 'explore your data.']);
  });

  // 6. Invalid SQL: classifies → generates SQL → validation fails → yields error
  it('6. handles invalid SQL validation', async () => {
    mockClassification('data');
    mockSqlGeneration('DELETE FROM users');
    mockValidateSql.mockReturnValue({ valid: false, reason: 'Only SELECT queries are allowed' });

    const input: AskInput = { question: 'Delete all users' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types).toContain('done');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('SELECT');

    // Should NOT have called executeSql
    expect(mockExecuteSql).not.toHaveBeenCalled();

    // Should NOT have called streamLLM
    expect(mockStreamLLM).not.toHaveBeenCalled();
  });

  // 7. SQL execution error
  it('7. handles SQL execution error', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT * FROM nonexistent');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT * FROM nonexistent' });
    mockExecuteSql.mockRejectedValue(new Error('relation "nonexistent" does not exist'));

    const input: AskInput = { question: 'Show all nonexistent data' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);
    expect(types).toContain('sql');
    expect(types).toContain('error');
    expect(types).toContain('done');

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('nonexistent');

    // Should NOT have called streamLLM
    expect(mockStreamLLM).not.toHaveBeenCalled();
  });

  // 8. Classification parse failure: falls back to 'data' type
  it('8. falls back to data type on classification parse failure', async () => {
    // Return invalid JSON for classification
    mockCallLLM.mockResolvedValueOnce('this is not json');
    // Then generate-sql call
    mockSqlGeneration('SELECT 1');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT 1' });
    mockExecuteSql.mockResolvedValue({
      columns: ['?column?'],
      rows: [{ '?column?': 1 }],
      rowCount: 1,
    });
    mockStream('Here is the result.');

    const input: AskInput = { question: 'Something ambiguous' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const classified = events.find((e) => e.type === 'classified');
    expect(classified?.questionType).toBe('data');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // 9. Yields correct event sequence
  it('9. yields correct event sequence for data question', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT id FROM users');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT id FROM users' });
    mockExecuteSql.mockResolvedValue({
      columns: ['id'],
      rows: [{ id: 1 }],
      rowCount: 1,
    });
    mockStream('Result.');

    const input: AskInput = { question: 'List user ids' };
    const events = await collectEvents(orchestrator.handleQuestion(input));
    const types = events.map((e) => e.type);

    // Exact sequence: classifying → classified → sql → executing → token(s) → done
    expect(types[0]).toBe('classifying');
    expect(types[1]).toBe('classified');
    expect(types[2]).toBe('sql');
    expect(types[3]).toBe('executing');
    // Tokens in the middle
    expect(types[types.length - 1]).toBe('done');
    // All middle events should be tokens
    const middleTypes = types.slice(4, -1);
    expect(middleTypes.every((t) => t === 'token')).toBe(true);
  });

  // 10. Passes history to classify and answer prompts
  it('10. passes history to classify and answer prompts', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT COUNT(*) FROM users');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT COUNT(*) FROM users' });
    mockExecuteSql.mockResolvedValue({
      columns: ['count'],
      rows: [{ count: 42 }],
      rowCount: 1,
    });
    mockStream('42 users.');

    const input: AskInput = {
      question: 'How many?',
      history: [
        { role: 'user', content: 'Tell me about users' },
        { role: 'assistant', content: 'What would you like to know about users?' },
      ],
    };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    // Verify callLLM was called for classify with messages that contain history
    const classifyCall = mockCallLLM.mock.calls[0];
    const classifyMessages = classifyCall[0];
    const classifyUserMsg = classifyMessages.find((m: { role: string }) => m.role === 'user');
    expect(classifyUserMsg.content).toContain('Tell me about users');
    expect(classifyUserMsg.content).toContain('How many?');

    // Verify streamLLM was called for answer with messages that contain history
    const answerCall = mockStreamLLM.mock.calls[0];
    const answerMessages = answerCall[0];
    const answerUserMsg = answerMessages.find((m: { role: string }) => m.role === 'user');
    expect(answerUserMsg.content).toContain('How many?');

    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // 11. SQL generation returns invalid/empty SQL
  it('11. yields descriptive error when SQL generation fails', async () => {
    mockClassification('data');
    // LLM returns non-JSON garbage instead of { sql: "SELECT ..." }
    mockCallLLM.mockResolvedValueOnce('I cannot generate that query');

    const input: AskInput = { question: 'Do something impossible' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error?.message).toContain('Failed to generate a SQL query');
    // Should NOT have called validateSql or executeSql
    expect(mockValidateSql).not.toHaveBeenCalled();
    expect(mockExecuteSql).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // 12a. Data questions should also search code index for enum/business context
  it('12a. data questions search code index when searchTerms provided', async () => {
    mockClassification('data', 0.95, ['challenges', 'active']);
    (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { file: 'models/challenge.ts', content: 'enum Status { Draft, Active, Completed }', matchCount: 1 },
    ]);
    mockSqlGeneration("SELECT COUNT(*) FROM challenges WHERE status = 'Active'");
    mockValidateSql.mockReturnValue({ valid: true, sql: "SELECT COUNT(*) FROM challenges WHERE status = 'Active'" });
    mockExecuteSql.mockResolvedValue({
      columns: ['count'],
      rows: [{ count: 5 }],
      rowCount: 1,
    });
    mockStream('There are 5 active challenges.');

    const input: AskInput = { question: 'How many active challenges?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    // Should have searched code index even for data type
    expect(codeIndexer.search).toHaveBeenCalledWith(['challenges', 'active']);

    // Should still produce full data pipeline events
    const types = events.map((e) => e.type);
    expect(types).toContain('sql');
    expect(types).toContain('executing');
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  // 12b. Data questions without searchTerms should still work (no code search)
  it('12b. data questions without searchTerms skip code search', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT COUNT(*) FROM users');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT COUNT(*) FROM users' });
    mockExecuteSql.mockResolvedValue({
      columns: ['count'],
      rows: [{ count: 42 }],
      rowCount: 1,
    });
    mockStream('42 users.');

    const input: AskInput = { question: 'How many users?' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    // Without searchTerms, code search gets empty array → no results
    // But codeIndexer.search should still be called (with [])
    expect(codeIndexer.search).toHaveBeenCalledWith([]);

    const types = events.map((e) => e.type);
    expect(types).toContain('done');
  });

  // 12. SQL generation returns JSON with missing sql field
  it('12. yields error when LLM returns JSON without sql field', async () => {
    mockClassification('data');
    mockCallLLM.mockResolvedValueOnce(JSON.stringify({ explanation: 'no sql here' }));

    const input: AskInput = { question: 'Bad generation' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error?.message).toContain('Failed to generate a SQL query');
    expect(mockValidateSql).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // ============================================================
  // SQL retry with column auto-fix
  // ============================================================

  // 13. Column error: tryFixColumn fixes it → two sql events, no error
  it('13. retries with tryFixColumn on UndefinedColumn error', async () => {
    const schema = 'TABLE job_types (id INT PK, title VARCHAR, description TEXT)\nTABLE users (id INT PK, name VARCHAR)';
    schemaService = createMockSchemaService(schema);
    orchestrator = new Orchestrator({ schemaService, codeIndexer, databaseUrl });

    mockClassification('data');
    mockSqlGeneration('SELECT jt.name FROM job_types jt LIMIT 100');
    // First validate call: original SQL
    mockValidateSql.mockReturnValueOnce({ valid: true, sql: 'SELECT jt.name FROM job_types jt LIMIT 100' });
    // Second validate call: fixed SQL (name → title)
    mockValidateSql.mockReturnValueOnce({ valid: true, sql: 'SELECT jt.title FROM job_types jt LIMIT 100' });

    // First call fails with UndefinedColumn error, second call succeeds
    mockExecuteSql
      .mockRejectedValueOnce(new Error('column jt.name does not exist'))
      .mockResolvedValueOnce({
        columns: ['title'],
        rows: [{ title: 'Engineer' }],
        rowCount: 1,
      });

    mockStream('The job types are: Engineer.');

    const input: AskInput = { question: 'List all job types' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);

    // Should have two sql events (original + corrected)
    const sqlEvents = events.filter((e) => e.type === 'sql');
    expect(sqlEvents.length).toBe(2);

    // First sql event has the original SQL
    expect(sqlEvents[0].sql).toBe('SELECT jt.name FROM job_types jt LIMIT 100');

    // Second sql event has the corrected SQL (name → title)
    expect(String(sqlEvents[1].sql)).toContain('title');
    expect(String(sqlEvents[1].sql)).not.toContain('jt.name');

    // No error event
    expect(types).not.toContain('error');

    // executeSql called twice
    expect(mockExecuteSql).toHaveBeenCalledTimes(2);

    // Answer is streamed
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  // 14. Column error: tryFixColumn can't fix → LLM retry succeeds
  it('14. retries with LLM when tryFixColumn cannot fix', async () => {
    const schema = 'TABLE job_types (id INT PK, title VARCHAR, description TEXT)';
    schemaService = createMockSchemaService(schema);
    orchestrator = new Orchestrator({ schemaService, codeIndexer, databaseUrl });

    mockClassification('data');
    // Initial SQL generation
    mockSqlGeneration('SELECT jt.nonexistentcolumn FROM job_types jt LIMIT 100');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT jt.nonexistentcolumn FROM job_types jt LIMIT 100' });

    // First executeSql fails, second (after LLM retry) succeeds
    mockExecuteSql
      .mockRejectedValueOnce(new Error('column jt.nonexistentcolumn does not exist'))
      .mockResolvedValueOnce({
        columns: ['title'],
        rows: [{ title: 'Engineer' }],
        rowCount: 1,
      });

    // LLM retry generates fixed SQL (3rd callLLM call: classify + generate-sql + retry)
    mockCallLLM.mockResolvedValueOnce(JSON.stringify({
      sql: 'SELECT jt.title FROM job_types jt LIMIT 100',
      explanation: 'Fixed column',
    }));

    // validateSql for the retry
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT jt.title FROM job_types jt LIMIT 100' });

    mockStream('The job types are: Engineer.');

    const input: AskInput = { question: 'List all job types' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);

    // Should have two sql events
    const sqlEvents = events.filter((e) => e.type === 'sql');
    expect(sqlEvents.length).toBe(2);

    // No error event
    expect(types).not.toContain('error');

    // executeSql called twice
    expect(mockExecuteSql).toHaveBeenCalledTimes(2);

    // Answer is streamed
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  // 15. Non-column error: no retry, returns error immediately
  it('15. does not retry on non-column errors (relation does not exist)', async () => {
    mockClassification('data');
    mockSqlGeneration('SELECT * FROM nonexistent_table');
    mockValidateSql.mockReturnValue({ valid: true, sql: 'SELECT * FROM nonexistent_table' });
    mockExecuteSql.mockRejectedValue(new Error('relation "nonexistent_table" does not exist'));

    const input: AskInput = { question: 'Show nonexistent data' };
    const events = await collectEvents(orchestrator.handleQuestion(input));

    const types = events.map((e) => e.type);

    // Only one sql event
    const sqlEvents = events.filter((e) => e.type === 'sql');
    expect(sqlEvents.length).toBe(1);

    // Error returned immediately
    expect(types).toContain('error');
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('nonexistent_table');

    // executeSql called only once
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
  });

  describe('manifest support', () => {
    it('stores manifest via setManifest', async () => {
      const schema = createMockSchemaService();
      const codeIndexer = createMockCodeIndexer();
      const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });

      orch.setManifest({
        version: 1,
        routes: [
          { path: '/admin/users', method: 'GET', label: 'Users' },
          { path: '/dashboard', method: 'GET', label: 'Dashboard' },
        ],
        files: [],
      });

      expect(orch.getRouteList()).toContain('/admin/users');
      expect(orch.getRouteList()).toContain('Users');
      expect(orch.getRouteList()).toContain('Dashboard');
    });

    it('merges manifest routes with code indexer routes', async () => {
      const schema = createMockSchemaService();
      const codeIndexer = createMockCodeIndexer();
      (codeIndexer.getRoutes as ReturnType<typeof vi.fn>).mockReturnValue([
        { method: 'GET', path: '/admin/users', file: 'routes.tsx' },
        { method: 'GET', path: '/api/health', file: 'server.ts' },
      ]);

      const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
      orch.setManifest({
        version: 1,
        routes: [
          { path: '/admin/users', method: 'GET', label: 'Users', parentPath: '/admin' },
          { path: '/dashboard', method: 'GET', label: 'Dashboard' },
        ],
        files: [],
      });

      const list = orch.getRouteList();
      expect(list).toContain('Users');
      expect(list).toContain('Dashboard');
      const matches = list.match(/\/admin\/users/g);
      expect(matches?.length).toBe(1);
    });

    it('returns fallback message without manifest or routes', async () => {
      const schema = createMockSchemaService();
      const codeIndexer = createMockCodeIndexer();
      (codeIndexer.getRoutes as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
      expect(orch.getRouteList()).toBe('No application routes detected.');
    });

    it('merges manifest files into search', async () => {
      const schema = createMockSchemaService();
      const codeIndexer = createMockCodeIndexer();
      (codeIndexer.search as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const orch = new Orchestrator({ schemaService: schema, codeIndexer, databaseUrl: 'postgres://test' });
      orch.setManifest({
        version: 1,
        routes: [],
        files: [
          { path: 'src/pages/Users.tsx', content: 'export function UsersPage() { return <UserTable users={data} /> }' },
          { path: 'src/components/UserTable.tsx', content: 'export function UserTable({ users }) { ... }' },
        ],
      });

      const results = orch.searchManifestFiles(['UserTable']);
      expect(results.length).toBe(2);
      expect(results[0].file).toBe('src/components/UserTable.tsx');
    });
  });
});
