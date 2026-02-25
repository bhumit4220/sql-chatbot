/**
 * Navigation/Guidance Mode Flow Integration Test
 *
 * Verifies that navigation and guidance mode questions work end-to-end:
 * content script sends question with pageContext -> middleware classifies as
 * `navigation` or `guidance` -> streams answer via SSE -> extension receives
 * tokens referencing sidebar links, breadcrumbs, or step-by-step instructions.
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
// Navigation Mode: "Where do I manage contractors?"
// ---------------------------------------------------------------------------

describe('Navigation/Guidance Mode Flow', () => {
  it('receives navigation guidance for "Where do I manage contractors?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"You"}\n\n',
      'data: {"token":" can"}\n\n',
      'data: {"token":" manage"}\n\n',
      'data: {"token":" contractors"}\n\n',
      'data: {"token":" from"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" **Contractors**"}\n\n',
      'data: {"token":" link"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" sidebar."}\n\n',
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
      { question: 'Where do I manage contractors?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    expect(tokens).toEqual([
      'You', ' can', ' manage', ' contractors', ' from', ' the',
      ' **Contractors**', ' link', ' in', ' the', ' sidebar.',
    ]);
    expect(tokens.join('')).toBe(
      'You can manage contractors from the **Contractors** link in the sidebar.'
    );
    expect(doneCalledCount).toBe(1);
    expect(errorMsg).toBe('');

    // Verify request shape
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/ask`);
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
    expect(JSON.parse(opts.body)).toEqual({
      question: 'Where do I manage contractors?',
      history: [],
    });
  });

  // ---------------------------------------------------------------------------
  // Guidance Mode: "How do I ban a user?"
  // ---------------------------------------------------------------------------

  it('streams step-by-step guidance for "How do I ban a user?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"To"}\n\n',
      'data: {"token":" ban"}\n\n',
      'data: {"token":" a"}\n\n',
      'data: {"token":" user"}\n\n',
      'data: {"token":":\\n"}\n\n',
      'data: {"token":"1."}\n\n',
      'data: {"token":" Go"}\n\n',
      'data: {"token":" to"}\n\n',
      'data: {"token":" **Customers**"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" sidebar.\\n"}\n\n',
      'data: {"token":"2."}\n\n',
      'data: {"token":" Find"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" user"}\n\n',
      'data: {"token":" and"}\n\n',
      'data: {"token":" click"}\n\n',
      'data: {"token":" **Ban**."}\n\n',
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
      { question: 'How do I ban a user?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { done = true; },
        onError: () => {},
      }
    );

    const assembled = tokens.join('');
    expect(assembled).toContain('To ban a user');
    expect(assembled).toContain('1.');
    expect(assembled).toContain('2.');
    expect(assembled).toContain('**Customers**');
    expect(assembled).toContain('**Ban**');
    expect(tokens.length).toBe(19);
    expect(done).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Navigation with pageContext including navigation links
  // ---------------------------------------------------------------------------

  it('includes pageContext with navigation links in request body', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Click"}\n\n',
      'data: {"token":" **Contractors**"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" left"}\n\n',
      'data: {"token":" sidebar."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const pageContext = JSON.stringify({
      url: 'https://admin.mowsnowpros.com/dashboard',
      title: 'Admin Dashboard',
      navigation: [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Customers', href: '/customers' },
        { label: 'Contractors', href: '/contractors' },
        { label: 'Jobs', href: '/jobs' },
        { label: 'Reports', href: '/reports' },
      ],
    });

    const tokens: string[] = [];
    await askQuestion(
      ENDPOINT,
      {
        question: 'Where do I manage contractors?',
        history: [],
        pageContext,
      },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => {},
        onError: () => {},
      }
    );

    expect(tokens.join('')).toBe('Click **Contractors** in the left sidebar.');

    // Verify the fetch body includes pageContext
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.pageContext).toBe(pageContext);
    expect(requestBody.question).toBe('Where do I manage contractors?');
    expect(requestBody.history).toEqual([]);

    // Verify the navigation links are present in the serialized pageContext
    const parsedContext = JSON.parse(requestBody.pageContext);
    expect(parsedContext.url).toBe('https://admin.mowsnowpros.com/dashboard');
    expect(parsedContext.title).toBe('Admin Dashboard');
    expect(parsedContext.navigation).toHaveLength(5);
    expect(parsedContext.navigation[2]).toEqual({
      label: 'Contractors',
      href: '/contractors',
    });
  });

  // ---------------------------------------------------------------------------
  // Navigation with breadcrumbs in pageContext
  // ---------------------------------------------------------------------------

  it('passes breadcrumbs in pageContext through to the request', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"You"}\n\n',
      'data: {"token":" are"}\n\n',
      'data: {"token":" currently"}\n\n',
      'data: {"token":" on"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" Contractor"}\n\n',
      'data: {"token":" Details"}\n\n',
      'data: {"token":" page."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(sseChunks),
    });

    const pageContext = JSON.stringify({
      url: 'https://admin.mowsnowpros.com/contractors/42',
      title: 'Contractor Details - John Doe',
      breadcrumbs: [
        { label: 'Home', href: '/dashboard' },
        { label: 'Contractors', href: '/contractors' },
        { label: 'John Doe', href: '/contractors/42' },
      ],
      navigation: [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Contractors', href: '/contractors' },
      ],
    });

    const tokens: string[] = [];
    await askQuestion(
      ENDPOINT,
      {
        question: 'Where am I right now?',
        history: [],
        pageContext,
      },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => {},
        onError: () => {},
      }
    );

    expect(tokens.join('')).toBe(
      'You are currently on the Contractor Details page.'
    );

    // Verify breadcrumbs are in the request body
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.pageContext).toBe(pageContext);

    const parsedContext = JSON.parse(requestBody.pageContext);
    expect(parsedContext.breadcrumbs).toHaveLength(3);
    expect(parsedContext.breadcrumbs[0]).toEqual({
      label: 'Home',
      href: '/dashboard',
    });
    expect(parsedContext.breadcrumbs[2]).toEqual({
      label: 'John Doe',
      href: '/contractors/42',
    });
  });

  // ---------------------------------------------------------------------------
  // Guidance mode with conversation history
  // ---------------------------------------------------------------------------

  it('includes history for follow-up guidance question', async () => {
    const { askQuestion } = await getClient();

    // First question: "How do I ban a user?"
    const firstChunks = [
      'data: {"token":"Go"}\n\n',
      'data: {"token":" to"}\n\n',
      'data: {"token":" Customers,"}\n\n',
      'data: {"token":" find"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" user,"}\n\n',
      'data: {"token":" click"}\n\n',
      'data: {"token":" Ban."}\n\n',
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockSSEStream(firstChunks),
    });

    const firstTokens: string[] = [];
    await askQuestion(
      ENDPOINT,
      { question: 'How do I ban a user?', history: [] },
      {
        onToken: (token) => { firstTokens.push(token); },
        onDone: () => {},
        onError: () => {},
      }
    );

    const firstAnswer = firstTokens.join('');
    expect(firstAnswer).toBe('Go to Customers, find the user, click Ban.');

    // Build history
    const history = [
      { role: 'user' as const, content: 'How do I ban a user?' },
      { role: 'assistant' as const, content: firstAnswer },
    ];

    // Follow-up question
    const followUpChunks = [
      'data: {"token":"After"}\n\n',
      'data: {"token":" banning,"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" user"}\n\n',
      'data: {"token":" can"}\n\n',
      'data: {"token":" no"}\n\n',
      'data: {"token":" longer"}\n\n',
      'data: {"token":" log"}\n\n',
      'data: {"token":" in."}\n\n',
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
        question: 'What happens after I ban them?',
        history,
      },
      {
        onToken: (token) => { followUpTokens.push(token); },
        onDone: () => { followUpDone = true; },
        onError: () => {},
      }
    );

    expect(followUpTokens.join('')).toBe(
      'After banning, the user can no longer log in.'
    );
    expect(followUpDone).toBe(true);

    // Verify second request includes history
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.question).toBe('What happens after I ban them?');
    expect(secondBody.history).toEqual(history);
    expect(secondBody.history).toHaveLength(2);
    expect(secondBody.history[0].role).toBe('user');
    expect(secondBody.history[0].content).toBe('How do I ban a user?');
    expect(secondBody.history[1].role).toBe('assistant');
    expect(secondBody.history[1].content).toBe(
      'Go to Customers, find the user, click Ban.'
    );
  });

  // ---------------------------------------------------------------------------
  // Navigation: "Where do I see reports?"
  // ---------------------------------------------------------------------------

  it('handles another navigation question "Where do I see reports?"', async () => {
    const { askQuestion } = await getClient();

    const sseChunks = [
      'data: {"token":"Navigate"}\n\n',
      'data: {"token":" to"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" **Reports**"}\n\n',
      'data: {"token":" section"}\n\n',
      'data: {"token":" in"}\n\n',
      'data: {"token":" the"}\n\n',
      'data: {"token":" sidebar"}\n\n',
      'data: {"token":" to"}\n\n',
      'data: {"token":" view"}\n\n',
      'data: {"token":" all"}\n\n',
      'data: {"token":" available"}\n\n',
      'data: {"token":" reports."}\n\n',
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
      { question: 'Where do I see reports?', history: [] },
      {
        onToken: (token) => { tokens.push(token); },
        onDone: () => { doneCalledCount++; },
        onError: (err) => { errorMsg = err; },
      }
    );

    expect(tokens).toEqual([
      'Navigate', ' to', ' the', ' **Reports**', ' section',
      ' in', ' the', ' sidebar', ' to', ' view', ' all',
      ' available', ' reports.',
    ]);
    expect(tokens.join('')).toBe(
      'Navigate to the **Reports** section in the sidebar to view all available reports.'
    );
    expect(doneCalledCount).toBe(1);
    expect(errorMsg).toBe('');

    // Verify consistent request structure
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/ask`);
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
    expect(opts.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    });
  });
});
