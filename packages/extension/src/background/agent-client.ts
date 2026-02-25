import { AGENT_BASE_URL } from '@chatbot/shared';

interface AgentClientOptions {
  sessionToken: string;
  extensionId: string;
}

export class AgentClient {
  private baseUrl: string;
  private sessionToken: string;
  private extensionId: string;

  constructor(options: AgentClientOptions) {
    this.baseUrl = AGENT_BASE_URL;
    this.sessionToken = options.sessionToken;
    this.extensionId = options.extensionId;
  }

  updateToken(newToken: string): void {
    this.sessionToken = newToken;
  }

  getToken(): string {
    return this.sessionToken;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T & { newSessionToken?: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
        'X-Extension-Id': this.extensionId,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `Agent error: ${response.status}`);
    }

    const data = await response.json();

    // Handle token rotation
    if (data.newSessionToken) {
      this.sessionToken = data.newSessionToken;
      // Store rotated token in session storage
      await chrome.storage.session.set({ sessionToken: data.newSessionToken });
    }

    return data;
  }

  async get<T>(path: string): Promise<T & { newSessionToken?: string }> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body: unknown): Promise<T & { newSessionToken?: string }> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async streamSSE(path: string, body: unknown, onChunk: (token: string) => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
        'X-Extension-Id': this.extensionId,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Agent error: ${response.status}`);
    }

    // Handle token rotation from SSE header
    const newToken = response.headers.get('X-New-Session-Token');
    if (newToken) {
      this.sessionToken = newToken;
      await chrome.storage.session.set({ sessionToken: newToken });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            if (parsed.token) onChunk(parsed.token);
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    }
  }
}
