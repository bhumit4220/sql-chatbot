/**
 * Data Mode Flow Integration Test
 *
 * Verifies the data mode flow works end-to-end through the extension's client code:
 * content script sends question -> middleware classifies as `data` -> generates SQL ->
 * executes -> streams answer via SSE -> extension receives tokens and assembles response.
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
// Data Mode: Basic data question
// ---------------------------------------------------------------------------

describe('Data Mode Flow', () => {
  it('receives token-by-token answer for "How many active customers?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"There"}\n\n',
      'data: {"token":" are"}\n\n',
      'data: {"token":" 42"}\n\n',
      'data: {"token":" active"}\n\n',
      'data: {"token":" customers"}\n\n',
      'data: {"token":"."}\n\n',
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
      { question: 'How many active customers?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // All tokens received in order
    expect(tokens).toEqual(['There', ' are', ' 42', ' active', ' customers', '.']);
    // Assembled answer
    expect(tokens.join('')).toBe('There are 42 active customers.');
    // onDone called exactly once
    expect(doneCalledCount).toBe(1);
    // No errors
    expect(errorMsg).toBe('');

    // Verify the request was sent correctly
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/ask`);
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
    expect(JSON.parse(opts.body)).toEqual({
      question: 'How many active customers?',
      history: [],
    });
  });

  // ---------------------------------------------------------------------------
  // Data Mode: Numeric/financial data
  // ---------------------------------------------------------------------------

  it('handles numeric/financial data for "What is the total revenue this month?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"The"}\n\n',
      'data: {"token":" total"}\n\n',
      'data: {"token":" revenue"}\n\n',
      'data: {"token":" this"}\n\n',
      'data: {"token":" month"}\n\n',
      'data: {"token":" is"}\n\n',
      'data: {"token":" $"}\n\n',
      'data: {"token":"12"}\n\n',
      'data: {"token":","}\n\n',
      'data: {"token":"345"}\n\n',
      'data: {"token":"."}\n\n',
      'data: {"token":"67"}\n\n',
      'data: {"token":"."}\n\n',
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
      { question: 'What is the total revenue this month?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    expect(tokens.join('')).toBe('The total revenue this month is $12,345.67.');
    expect(done).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Data Mode: Follow-up question with conversation history
  // ---------------------------------------------------------------------------

  it('includes conversation history in follow-up request', async () => {
    const { askQuestion } = await getClient();

    // First question
    const firstChunks = [
      'data: {"token":"There"}\n\n',
      'data: {"token":" are"}\n\n',
      'data: {"token":" 42"}\n\n',
      'data: {"token":" active"}\n\n',
      'data: {"token":" customers."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(firstChunks),
    });

    const firstTokens: string[] = [];
    await askQuestion(
      ENDPOINT,
      { question: 'How many active customers?', history: [] },
      {
        onToken: (token) => { firstTokens.push(token); },
        onDone: () => {},
        onError: () => {},
      }
    );

    const firstAnswer = firstTokens.join('');
    expect(firstAnswer).toBe('There are 42 active customers.');

    // Build conversation history from first exchange
    const history = [
      { role: 'user' as const, content: 'How many active customers?' },
      { role: 'assistant' as const, content: firstAnswer },
    ];

    // Follow-up question with history
    const followUpChunks = [
      'data: {"token":"Of"}\n\n',
      'data: {"token":" those"}\n\n',
      'data: {"token":" 42"}\n\n',
      'data: {"token":" customers"}\n\n',
      'data: {"token":","}\n\n',
      'data: {"token":" 7"}\n\n',
      'data: {"token":" signed"}\n\n',
      'data: {"token":" up"}\n\n',
      'data: {"token":" this"}\n\n',
      'data: {"token":" month."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(followUpChunks),
    });

    const followUpTokens: string[] = [];
    let followUpDone = false;

    await askQuestion(
      ENDPOINT,
      {
        question: 'How many of them signed up this month?',
        history,
      },
      {
        onToken: (token) => { followUpTokens.push(token); },
        onDone: () => { followUpDone = true; },
        onError: () => {},
      }
    );

    expect(followUpTokens.join('')).toBe('Of those 42 customers, 7 signed up this month.');
    expect(followUpDone).toBe(true);

    // Verify the second request included the history array
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.question).toBe('How many of them signed up this month?');
    expect(secondCallBody.history).toEqual(history);
    expect(secondCallBody.history).toHaveLength(2);
    expect(secondCallBody.history[0].role).toBe('user');
    expect(secondCallBody.history[0].content).toBe('How many active customers?');
    expect(secondCallBody.history[1].role).toBe('assistant');
    expect(secondCallBody.history[1].content).toBe('There are 42 active customers.');
  });

  // ---------------------------------------------------------------------------
  // Data Mode: Error from middleware (SSE error event)
  // ---------------------------------------------------------------------------

  it('calls onError when middleware returns SSE error event', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Analyzing"}\n\n',
      'data: {"error":"SQL execution failed"}\n\n',
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
      { question: 'Show me broken query data', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // Should have received the first token before the error
    expect(tokens).toEqual(['Analyzing']);
    // onError called with the error message
    expect(errorMsg).toBe('SQL execution failed');
    // onDone should NOT have been called (error happened before [DONE])
    expect(doneCalledCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Data Mode: Auth error (401)
  // ---------------------------------------------------------------------------

  it('calls onError with status when middleware returns 401', async () => {
    const { askQuestion } = await getClient();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const tokens: string[] = [];
    let doneCalledCount = 0;
    let errorMsg = '';

    await askQuestion(
      ENDPOINT,
      { question: 'How many active customers?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // No tokens should be received
    expect(tokens).toEqual([]);
    // onDone should NOT have been called
    expect(doneCalledCount).toBe(0);
    // onError should contain 401
    expect(errorMsg).toContain('401');
    expect(errorMsg).toContain('Unauthorized');
  });
});
