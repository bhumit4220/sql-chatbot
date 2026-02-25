/**
 * Content script HTTP client tests.
 *
 * The client makes fetch() calls directly from the content script
 * (not background worker) so session cookies are included automatically.
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
  return await import('../client.js');
}

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('fetches middleware status with credentials', async () => {
    const { getStatus } = await getClient();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        version: '1.0.0',
        status: 'ready',
        discoveryState: { schema: 'completed', enums: 'completed', code: 'completed' },
        authRequired: true,
      }),
    });

    const result = await getStatus('https://admin.example.com/chatbot');
    expect(result).toEqual({
      version: '1.0.0',
      status: 'ready',
      discoveryState: { schema: 'completed', enums: 'completed', code: 'completed' },
      authRequired: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://admin.example.com/chatbot/status',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      })
    );
  });

  it('throws on non-OK response', async () => {
    const { getStatus } = await getClient();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(getStatus('https://admin.example.com/chatbot'))
      .rejects.toThrow('401');
  });

  it('throws on network error', async () => {
    const { getStatus } = await getClient();

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    await expect(getStatus('https://admin.example.com/chatbot'))
      .rejects.toThrow('Network error');
  });
});

// ---------------------------------------------------------------------------
// askQuestion (SSE streaming)
// ---------------------------------------------------------------------------

describe('askQuestion', () => {
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

  it('sends POST with credentials and returns stream callbacks', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Hello"}\n\n',
      'data: {"token":" world"}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    let done = false;

    await askQuestion(
      'https://admin.example.com/chatbot',
      {
        question: 'How many customers?',
        history: [],
      },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    expect(tokens).toEqual(['Hello', ' world']);
    expect(done).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://admin.example.com/chatbot/ask',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }),
        body: JSON.stringify({
          question: 'How many customers?',
          history: [],
        }),
      })
    );
  });

  it('calls onError on non-OK response', async () => {
    const { askQuestion } = await getClient();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    let errorMsg = '';
    await askQuestion(
      'https://admin.example.com/chatbot',
      { question: 'test', history: [] },
      {
        onToken: () => {},
        onDone: () => {},
        onError: (err) => { errorMsg = err; },
      }
    );

    expect(errorMsg).toContain('401');
  });

  it('calls onError on network failure', async () => {
    const { askQuestion } = await getClient();

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    let errorMsg = '';
    await askQuestion(
      'https://admin.example.com/chatbot',
      { question: 'test', history: [] },
      {
        onToken: () => {},
        onDone: () => {},
        onError: (err) => { errorMsg = err; },
      }
    );

    expect(errorMsg).toContain('Network error');
  });

  it('handles SSE data with pageContext', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"answer"}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const tokens: string[] = [];
    await askQuestion(
      'https://admin.example.com/chatbot',
      {
        question: 'Where do I manage contractors?',
        history: [],
        pageContext: { url: 'https://admin.example.com/dashboard', title: 'Dashboard', navigation: [] },
      },
      {
        onToken: (t) => { tokens.push(t); },
        onDone: () => {},
        onError: () => {},
      }
    );

    expect(tokens).toEqual(['answer']);
    // Verify pageContext was included in the request body
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.pageContext).toBeDefined();
    expect(body.pageContext.url).toBe('https://admin.example.com/dashboard');
  });
});

// ---------------------------------------------------------------------------
// parseSSE
// ---------------------------------------------------------------------------

describe('parseSSE', () => {
  it('parses SSE lines correctly', async () => {
    const { parseSSE } = await getClient();

    const tokens: string[] = [];
    let done = false;

    parseSSE(
      'data: {"token":"Hello"}\n\ndata: {"token":" world"}\n\ndata: [DONE]\n\n',
      (token) => tokens.push(token),
      () => { done = true; },
      () => {},
    );

    expect(tokens).toEqual(['Hello', ' world']);
    expect(done).toBe(true);
  });

  it('handles error events', async () => {
    const { parseSSE } = await getClient();

    let errorMsg = '';
    parseSSE(
      'data: {"error":"Something went wrong"}\n\n',
      () => {},
      () => {},
      (err) => { errorMsg = err; },
    );

    expect(errorMsg).toBe('Something went wrong');
  });

  it('ignores empty lines and comments', async () => {
    const { parseSSE } = await getClient();

    const tokens: string[] = [];
    parseSSE(
      ': this is a comment\n\ndata: {"token":"ok"}\n\n\n',
      (token) => tokens.push(token),
      () => {},
      () => {},
    );

    expect(tokens).toEqual(['ok']);
  });
});
