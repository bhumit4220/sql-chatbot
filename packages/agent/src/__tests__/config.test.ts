import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return a valid config with all required fields', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
    });

    expect(config).toEqual({
      databaseUrl: 'postgres://localhost:5432/testdb',
      codePaths: ['./src'],
      llmBaseUrl: 'https://api.groq.com/openai/v1',
      llmApiKey: 'test-key',
      llmModel: 'llama-3.3-70b-versatile',
    });
  });

  it('should throw if databaseUrl is missing', () => {
    expect(() =>
      resolveConfig({ databaseUrl: '', llmApiKey: 'test-key' })
    ).toThrow('databaseUrl is required');
  });

  it('should throw if no API key is provided', () => {
    expect(() =>
      resolveConfig({ databaseUrl: 'postgres://localhost:5432/testdb' })
    ).toThrow('An LLM API key is required');
  });

  it('should use groqApiKey as fallback for llmApiKey', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      groqApiKey: 'groq-key',
    });

    expect(config.llmApiKey).toBe('groq-key');
  });

  it('should prefer llmApiKey over groqApiKey', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'llm-key',
      groqApiKey: 'groq-key',
    });

    expect(config.llmApiKey).toBe('llm-key');
  });

  it('should fall back to LLM_API_KEY env var', () => {
    process.env.LLM_API_KEY = 'env-llm-key';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
    });

    expect(config.llmApiKey).toBe('env-llm-key');
  });

  it('should fall back to GROQ_API_KEY env var', () => {
    process.env.GROQ_API_KEY = 'env-groq-key';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
    });

    expect(config.llmApiKey).toBe('env-groq-key');
  });

  it('should prefer LLM_API_KEY over GROQ_API_KEY env var', () => {
    process.env.LLM_API_KEY = 'env-llm-key';
    process.env.GROQ_API_KEY = 'env-groq-key';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
    });

    expect(config.llmApiKey).toBe('env-llm-key');
  });

  it('should use custom codePaths when provided', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
      codePaths: ['./app', './lib'],
    });

    expect(config.codePaths).toEqual(['./app', './lib']);
  });

  it('should fall back to LLM_BASE_URL env var', () => {
    process.env.LLM_BASE_URL = 'http://localhost:8080/v1';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
    });

    expect(config.llmBaseUrl).toBe('http://localhost:8080/v1');
  });

  it('should fall back to LLM_MODEL env var', () => {
    process.env.LLM_MODEL = 'qwen3-4b';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
    });

    expect(config.llmModel).toBe('qwen3-4b');
  });

  it('should prefer explicit llmBaseUrl over LLM_BASE_URL env var', () => {
    process.env.LLM_BASE_URL = 'http://localhost:8080/v1';

    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
      llmBaseUrl: 'https://api.openai.com/v1',
    });

    expect(config.llmBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('should use custom llmBaseUrl when provided', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
      llmBaseUrl: 'https://api.openai.com/v1',
    });

    expect(config.llmBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('should use custom llmModel when provided', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
      llmModel: 'gpt-4o-mini',
    });

    expect(config.llmModel).toBe('gpt-4o-mini');
  });
});
