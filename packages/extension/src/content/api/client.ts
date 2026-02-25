/**
 * Content script HTTP client for V3 middleware.
 *
 * Makes fetch() calls directly from the content script so session cookies
 * are automatically included (credentials: 'include').
 */
import type { MiddlewareAskRequest, MiddlewareStatusResponse } from '@chatbot/shared';

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

/**
 * Fetch middleware status.
 */
export async function getStatus(endpoint: string): Promise<MiddlewareStatusResponse> {
  const response = await fetch(`${endpoint}/status`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Send a question to the middleware and stream the response via SSE.
 */
export async function askQuestion(
  endpoint: string,
  request: MiddlewareAskRequest,
  callbacks: StreamCallbacks
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/ask`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(request),
    });
  } catch (err) {
    callbacks.onError((err as Error).message);
    return;
  }

  if (!response.ok) {
    callbacks.onError(`${response.status} ${response.statusText}`);
    return;
  }

  // Read SSE stream
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const events = buffer.split('\n\n');
      buffer = events.pop()!; // Keep incomplete event in buffer

      for (const event of events) {
        parseSSEEvent(event, callbacks.onToken, callbacks.onDone, callbacks.onError);
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      parseSSEEvent(buffer, callbacks.onToken, callbacks.onDone, callbacks.onError);
    }
  } catch (err) {
    callbacks.onError((err as Error).message);
  }
}

function parseSSEEvent(
  event: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: string) => void
): void {
  for (const line of event.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);

      if (data === '[DONE]') {
        onDone();
        return;
      }

      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          onError(parsed.error);
        } else if (parsed.token !== undefined) {
          onToken(parsed.token);
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }
}

/**
 * Parse a raw SSE text blob. Exported for testing.
 */
export function parseSSE(
  text: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: string) => void
): void {
  const events = text.split('\n\n');
  for (const event of events) {
    if (event.trim()) {
      parseSSEEvent(event, onToken, onDone, onError);
    }
  }
}
