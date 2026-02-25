/**
 * Code Mode Flow Integration Test
 *
 * Verifies the code mode flow works end-to-end through the extension's client code:
 * content script sends question -> middleware classifies as `code` -> searches codebase ->
 * streams explanation via SSE -> extension receives tokens and assembles response.
 *
 * Code mode answers questions about how the codebase works, e.g. "How is net sales calculated?"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

async function getClient() {
  vi.resetModules();
  globalThis.fetch = fetchMock;
  return await import('../content/api/client.js');
}

function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const ENDPOINT = 'https://admin.example.com/chatbot';

// ---------------------------------------------------------------------------
// Code Mode: Basic code explanation question
// ---------------------------------------------------------------------------

describe('Code Mode Flow', () => {
  it('receives streamed explanation for "How is net sales calculated?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Net"}\n\n',
      'data: {"token":" sales"}\n\n',
      'data: {"token":" is"}\n\n',
      'data: {"token":" calculated"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" `Job"}\n\n',
      'data: {"token":"Services"}\n\n',
      'data: {"token":"::"}\n\n',
      'data: {"token":"Revenue"}\n\n',
      'data: {"token":"Calculator`"}\n\n',
      'data: {"token":" by"}\n\n',
      'data: {"token":" subtracting"}\n\n',
      'data: {"token":" refunds"}\n\n',
      'data: {"token":" and"}\n\n',
      'data: {"token":" discounts"}\n\n',
      'data: {"token":" from"}\n\n',
      'data: {"token":" gross"}\n\n',
      'data: {"token":" revenue."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let doneCalledCount = 0;
    let errorMsg = '';

    await askQuestion(
      ENDPOINT,
      { question: 'How is net sales calculated?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // All tokens received in order
    expect(tokens).toEqual([
      'Net', ' sales', ' is', ' calculated', ' in', ' `Job', 'Services',
      '::', 'Revenue', 'Calculator`', ' by', ' subtracting', ' refunds',
      ' and', ' discounts', ' from', ' gross', ' revenue.',
    ]);
    // Assembled answer includes code reference
    const assembled = tokens.join('');
    expect(assembled).toBe(
      'Net sales is calculated in `JobServices::RevenueCalculator` by subtracting refunds and discounts from gross revenue.'
    );
    // onDone called exactly once
    expect(doneCalledCount).toBe(1);
    // No errors
    expect(errorMsg).toBe('');

    // Verify request was sent correctly
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/ask`);
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
    expect(JSON.parse(opts.body)).toEqual({
      question: 'How is net sales calculated?',
      history: [],
    });
  });

  // ---------------------------------------------------------------------------
  // Code Mode: Long response with 20+ tokens — verify buffering
  // ---------------------------------------------------------------------------

  it('handles long response with 20+ tokens and preserves order', async () => {
    const { askQuestion } = await getClient();

    // Build 25 distinct tokens that form a coherent code explanation
    const words = [
      'The', ' Job', ' model', ' uses', ' a', ' state', ' machine',
      ' pattern.', ' When', ' a', ' contractor', ' accepts', ' a', ' job,',
      ' the', ' `transition_to!`', ' method', ' validates', ' the',
      ' current', ' status,', ' runs', ' callbacks,', ' and', ' persists.',
    ];

    const sseChunks = words.map((w) => `data: {"token":"${w}"}\n\n`);
    sseChunks.push('data: [DONE]\n\n');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let done = false;

    await askQuestion(
      ENDPOINT,
      { question: 'How does the job state machine work?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    // All 25 tokens received
    expect(tokens).toHaveLength(25);
    // Order preserved
    expect(tokens).toEqual(words);
    // Assembled answer is coherent
    expect(tokens.join('')).toBe(
      'The Job model uses a state machine pattern. When a contractor accepts a job, the `transition_to!` method validates the current status, runs callbacks, and persists.'
    );
    expect(done).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Code Mode: Special characters — backticks, newlines, code formatting
  // ---------------------------------------------------------------------------

  it('preserves special characters (backticks, newlines, code formatting)', async () => {
    const { askQuestion } = await getClient();

    // Tokens containing backticks, newlines, and code-like formatting
    const sseChunks = [
      'data: {"token":"The"}\n\n',
      'data: {"token":" method"}\n\n',
      'data: {"token":" is"}\n\n',
      'data: {"token":" defined"}\n\n',
      'data: {"token":" as:"}\n\n',
      'data: {"token":"\\n\\n"}\n\n',
      'data: {"token":"```ruby"}\n\n',
      'data: {"token":"\\n"}\n\n',
      'data: {"token":"def"}\n\n',
      'data: {"token":" calculate_total"}\n\n',
      'data: {"token":"\\n"}\n\n',
      'data: {"token":"  subtotal"}\n\n',
      'data: {"token":" - discounts"}\n\n',
      'data: {"token":" + tax"}\n\n',
      'data: {"token":"\\n"}\n\n',
      'data: {"token":"end"}\n\n',
      'data: {"token":"\\n"}\n\n',
      'data: {"token":"```"}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let done = false;

    await askQuestion(
      ENDPOINT,
      { question: 'Show me the calculate_total method', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    // Verify backtick tokens are preserved
    expect(tokens).toContain('```ruby');
    expect(tokens).toContain('```');

    // Verify newline tokens are preserved (JSON.parse converts \\n to actual newlines)
    expect(tokens).toContain('\n\n');
    expect(tokens).toContain('\n');

    // Verify code content tokens are present
    expect(tokens).toContain('def');
    expect(tokens).toContain(' calculate_total');
    expect(tokens).toContain('  subtotal');
    expect(tokens).toContain(' - discounts');
    expect(tokens).toContain(' + tax');
    expect(tokens).toContain('end');

    // All 18 tokens received in order
    expect(tokens).toHaveLength(18);
    expect(done).toBe(true);

    // Assembled answer contains complete code block
    const assembled = tokens.join('');
    expect(assembled).toContain('```ruby');
    expect(assembled).toContain('def calculate_total');
    expect(assembled).toContain('subtotal - discounts + tax');
    expect(assembled).toContain('```');
  });

  // ---------------------------------------------------------------------------
  // Code Mode: Request body format with history and pageContext
  // ---------------------------------------------------------------------------

  it('sends correct request body for "What validations does the Job model have?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"The"}\n\n',
      'data: {"token":" Job"}\n\n',
      'data: {"token":" model"}\n\n',
      'data: {"token":" validates"}\n\n',
      'data: {"token":" presence"}\n\n',
      'data: {"token":" of"}\n\n',
      'data: {"token":" `property_id`"}\n\n',
      'data: {"token":" and"}\n\n',
      'data: {"token":" `job_type`."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let done = false;

    const history = [
      { role: 'user' as const, content: 'Tell me about the Job model' },
      { role: 'assistant' as const, content: 'The Job model is the central domain model.' },
    ];

    const pageContext = {
      url: 'https://admin.example.com/admin/jobs',
      title: 'Jobs Admin',
      navigation: [
        { label: 'Dashboard', url: '/admin/dashboard' },
        { label: 'Jobs', url: '/admin/jobs' },
      ],
    };

    await askQuestion(
      ENDPOINT,
      {
        question: 'What validations does the Job model have?',
        history,
        pageContext,
      },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    expect(tokens.join('')).toBe('The Job model validates presence of `property_id` and `job_type`.');
    expect(done).toBe(true);

    // Verify the full request body format
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/ask`);

    const body = JSON.parse(opts.body);
    expect(body.question).toBe('What validations does the Job model have?');
    expect(body.history).toEqual(history);
    expect(body.history).toHaveLength(2);
    expect(body.history[0].role).toBe('user');
    expect(body.history[1].role).toBe('assistant');
    expect(body.pageContext).toBeDefined();
    expect(body.pageContext.url).toBe('https://admin.example.com/admin/jobs');
    expect(body.pageContext.title).toBe('Jobs Admin');
    expect(body.pageContext.navigation).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Code Mode: Error — unindexed codebase
  // ---------------------------------------------------------------------------

  it('calls onError when middleware returns code index not available', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"error":"Code index not available. Please wait for discovery to complete."}\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let doneCalledCount = 0;
    let errorMsg = '';

    await askQuestion(
      ENDPOINT,
      { question: 'How is net sales calculated?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // No tokens should be received — error came before any token
    expect(tokens).toEqual([]);
    // onError called with the specific error message
    expect(errorMsg).toBe('Code index not available. Please wait for discovery to complete.');
    // onDone should NOT have been called
    expect(doneCalledCount).toBe(0);
  });
});
