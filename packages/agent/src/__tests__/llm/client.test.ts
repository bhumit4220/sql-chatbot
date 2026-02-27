import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLLM, callLLM, streamLLM } from '../../llm/client.js';

// Mock the OpenAI module
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
    __mockCreate: mockCreate,
  };
});

// Access the mock create function
async function getMockCreate() {
  const mod = await import('openai');
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

describe('LLM Client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-initialize to ensure clean state
    initLLM('https://api.groq.com/openai/v1', 'test-key', 'llama-3.3-70b-versatile');
  });

  describe('initLLM', () => {
    it('should initialize the OpenAI client with provided params', async () => {
      const OpenAI = (await import('openai')).default;
      initLLM('https://api.example.com/v1', 'my-key', 'my-model');

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'my-key',
        baseURL: 'https://api.example.com/v1',
      });
    });
  });

  describe('callLLM', () => {
    it('should call the OpenAI SDK with correct parameters', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"type": "data"}' } }],
      });

      const messages = [
        { role: 'system' as const, content: 'You are a helper.' },
        { role: 'user' as const, content: 'How many users?' },
      ];

      const result = await callLLM(messages);

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.1,
        response_format: undefined,
      });
      expect(result).toBe('{"type": "data"}');
    });

    it('should use json mode when specified', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"type": "data"}' } }],
      });

      await callLLM(
        [{ role: 'user' as const, content: 'test' }],
        { jsonMode: true }
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        })
      );
    });

    it('should use custom temperature when specified', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'response' } }],
      });

      await callLLM(
        [{ role: 'user' as const, content: 'test' }],
        { temperature: 0.5 }
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.5 })
      );
    });

    it('should use custom model when specified', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'response' } }],
      });

      await callLLM(
        [{ role: 'user' as const, content: 'test' }],
        { model: 'gpt-4o-mini' }
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-mini' })
      );
    });

    it('should return empty string if no content in response', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      const result = await callLLM([{ role: 'user' as const, content: 'test' }]);
      expect(result).toBe('');
    });
  });

  describe('streamLLM', () => {
    it('should yield chunks from the stream', async () => {
      const mockCreate = await getMockCreate();
      const chunks = [
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: { content: '!' } }] },
        { choices: [{ delta: { content: null } }] },
      ];

      // Create an async iterable
      const asyncIterable = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < chunks.length) {
                return Promise.resolve({ value: chunks[i++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };

      mockCreate.mockResolvedValue(asyncIterable);

      const results: string[] = [];
      for await (const chunk of streamLLM([{ role: 'user' as const, content: 'test' }])) {
        results.push(chunk);
      }

      expect(results).toEqual(['Hello', ' world', '!']);
    });

    it('should call create with stream: true', async () => {
      const mockCreate = await getMockCreate();
      mockCreate.mockResolvedValue({
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      const gen = streamLLM([{ role: 'user' as const, content: 'test' }]);
      // Consume the generator
      for await (const _ of gen) { /* noop */ }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true, temperature: 0.3 })
      );
    });
  });
});
