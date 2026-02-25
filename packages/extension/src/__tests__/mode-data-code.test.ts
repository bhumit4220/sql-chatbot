/**
 * Data+Code Mode Flow Integration Test
 *
 * Verifies the data_with_code mode flow works end-to-end through the extension's
 * client code. This mode handles questions that require both SQL data AND business
 * logic from code — e.g. "Show jobs where net sales exceed $500".
 *
 * The middleware classifies as `data_with_code`, generates SQL informed by discovered
 * code context, executes it, and streams an answer that references both query results
 * and relevant code snippets.
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

function createErrorStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"token":"partial"}\n\n'));
      controller.error(new Error('Connection reset'));
    },
  });
}

const ENDPOINT = 'https://admin.example.com/chatbot';

// ---------------------------------------------------------------------------
// Data+Code Mode: Multi-token answer with SQL + code context
// ---------------------------------------------------------------------------

describe('Data+Code Mode Flow', () => {
  it('streams multi-token answer for "Show jobs where net sales exceed $500"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Based"}\n\n',
      'data: {"token":" on"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" `calculate_net_sales`"}\n\n',
      'data: {"token":" method"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" Job"}\n\n',
      'data: {"token":" model,"}\n\n',
      'data: {"token":" net"}\n\n',
      'data: {"token":" sales"}\n\n',
      'data: {"token":" ="}\n\n',
      'data: {"token":" total_price"}\n\n',
      'data: {"token":" -"}\n\n',
      'data: {"token":" discount."}\n\n',
      'data: {"token":" There"}\n\n',
      'data: {"token":" are"}\n\n',
      'data: {"token":" 23"}\n\n',
      'data: {"token":" jobs"}\n\n',
      'data: {"token":" exceeding"}\n\n',
      'data: {"token":" $500."}\n\n',
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
      { question: 'Show jobs where net sales exceed $500', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // All tokens received in order
    expect(tokens).toEqual([
      'Based', ' on', ' the', ' `calculate_net_sales`', ' method', ' in', ' the',
      ' Job', ' model,', ' net', ' sales', ' =', ' total_price', ' -', ' discount.',
      ' There', ' are', ' 23', ' jobs', ' exceeding', ' $500.',
    ]);

    // Assembled answer is coherent
    expect(tokens.join('')).toBe(
      'Based on the `calculate_net_sales` method in the Job model, net sales = total_price - discount. There are 23 jobs exceeding $500.'
    );

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
      question: 'Show jobs where net sales exceed $500',
      history: [],
    });
  });

  // ---------------------------------------------------------------------------
  // Data+Code Mode: Response with code snippets and special characters
  // ---------------------------------------------------------------------------

  it('preserves special characters in code snippets like Job.where(...)', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"The"}\n\n',
      'data: {"token":" relevant"}\n\n',
      'data: {"token":" code"}\n\n',
      'data: {"token":" is"}\n\n',
      'data: {"token":" `Job.where("}\n\n',
      'data: {"token":"status:"}\n\n',
      'data: {"token":" :active"}\n\n',
      'data: {"token":")`"}\n\n',
      'data: {"token":" which"}\n\n',
      'data: {"token":" filters"}\n\n',
      'data: {"token":" using"}\n\n',
      'data: {"token":" `scope"}\n\n',
      'data: {"token":" :>"}\n\n',
      'data: {"token":" { where(status: 1) }`."}\n\n',
      'data: {"token":" Result:"}\n\n',
      'data: {"token":" 15"}\n\n',
      'data: {"token":" rows"}\n\n',
      'data: {"token":" matched."}\n\n',
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
      { question: 'How does the active scope filter jobs?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    const assembled = tokens.join('');

    // Verify special characters are preserved: backticks, parens, colons, braces, >
    expect(assembled).toContain('`Job.where(');
    expect(assembled).toContain('status: :active');
    expect(assembled).toContain(')`');
    expect(assembled).toContain('`scope :>');
    expect(assembled).toContain('{ where(status: 1) }`');
    expect(assembled).toContain('15 rows matched.');
    expect(done).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Data+Code Mode: Request body includes pageContext
  // ---------------------------------------------------------------------------

  it('includes pageContext in the request body', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"On"}\n\n',
      'data: {"token":" this"}\n\n',
      'data: {"token":" page,"}\n\n',
      'data: {"token":" there"}\n\n',
      'data: {"token":" are"}\n\n',
      'data: {"token":" 5"}\n\n',
      'data: {"token":" pending"}\n\n',
      'data: {"token":" jobs."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    const pageContextValue = JSON.stringify({
      url: 'https://admin.example.com/jobs',
      title: 'Jobs Management',
      navigation: ['Dashboard', 'Jobs', 'Contractors'],
    });

    await askQuestion(
      ENDPOINT,
      {
        question: 'How many pending jobs are on this page?',
        history: [],
        pageContext: pageContextValue,
      },
      {
        onToken: (t) => { tokens.push(t); },
        onDone: () => {},
        onError: () => {},
      }
    );

    expect(tokens.join('')).toBe('On this page, there are 5 pending jobs.');

    // Verify pageContext was included in the fetch body
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.pageContext).toBeDefined();
    const parsedContext = JSON.parse(body.pageContext);
    expect(parsedContext.url).toBe('https://admin.example.com/jobs');
    expect(parsedContext.title).toBe('Jobs Management');
    expect(parsedContext.navigation).toEqual(['Dashboard', 'Jobs', 'Contractors']);
  });

  // ---------------------------------------------------------------------------
  // Data+Code Mode: Empty result
  // ---------------------------------------------------------------------------

  it('handles empty result with single token "No jobs matched your criteria."', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"No jobs matched your criteria."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let done = false;
    let errorMsg = '';

    await askQuestion(
      ENDPOINT,
      { question: 'Show jobs where net sales exceed $1000000', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // Single token received
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe('No jobs matched your criteria.');
    expect(tokens.join('')).toBe('No jobs matched your criteria.');
    expect(done).toBe(true);
    expect(errorMsg).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Data+Code Mode: Network error during streaming
  // ---------------------------------------------------------------------------

  it('calls onError when ReadableStream throws mid-read', async () => {
    const { askQuestion } = await getClient();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createErrorStream(),
    });

    const tokens: string[] = [];
    let doneCalledCount = 0;
    let errorMsg = '';

    await askQuestion(
      ENDPOINT,
      { question: 'Show jobs where net sales exceed $500', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    // May have received partial token before the error
    // The "partial" token might or might not be delivered depending on stream timing
    // but onError MUST be called
    expect(errorMsg).toBe('Connection reset');
    // onDone should NOT be called since the stream errored
    expect(doneCalledCount).toBe(0);
  });
});
