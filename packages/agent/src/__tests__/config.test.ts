import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig, PROVIDER_PRESETS } from '../config.js';

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_PROVIDER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return a valid config with all required fields', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      llmApiKey: 'test-key',
    });

    expect(config).toMatchObject({
      databaseUrl: 'postgres://localhost:5432/testdb',
      codePaths: ['./src'],
      llmBaseUrl: 'https://api.groq.com/openai/v1',
      llmApiKey: 'test-key',
      llmModel: 'llama-3.3-70b-versatile',
      provider: 'groq',
    });
  });

  it('should throw if databaseUrl is missing', () => {
    expect(() =>
      resolveConfig({ databaseUrl: '', llmApiKey: 'test-key' })
    ).toThrow('databaseUrl is required');
  });

  it('should throw if no API key and provider requires one', () => {
    expect(() =>
      resolveConfig({ databaseUrl: 'postgres://localhost:5432/testdb', provider: 'groq' })
    ).toThrow('An LLM API key is required');
  });

  it('should not throw when no API key with openrouter (free)', () => {
    const config = resolveConfig({
      databaseUrl: 'postgres://localhost:5432/testdb',
      provider: 'openrouter',
    });
    expect(config.llmApiKey).toBeTruthy();
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

  // --- Provider preset tests ---

  describe('provider presets', () => {
    it('auto-detects groq when API key is provided', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        llmApiKey: 'my-key',
      });

      expect(config.provider).toBe('groq');
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.groq.baseUrl);
      expect(config.llmModel).toBe(PROVIDER_PRESETS.groq.model);
    });

    it('auto-detects openrouter when no API key is provided', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
      });

      expect(config.provider).toBe('openrouter');
      expect(config.llmApiKey).toBeTruthy();
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.openrouter.baseUrl);
      expect(config.llmModel).toBe(PROVIDER_PRESETS.openrouter.model);
    });

    it('uses explicit provider preset for groq', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'groq',
        llmApiKey: 'my-key',
      });

      expect(config.provider).toBe('groq');
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.groq.baseUrl);
      expect(config.llmModel).toBe(PROVIDER_PRESETS.groq.model);
    });

    it('uses explicit provider preset for ollama', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'ollama',
      });

      expect(config.provider).toBe('ollama');
      expect(config.llmApiKey).toBeTruthy();
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.ollama.baseUrl);
      expect(config.llmModel).toBe(PROVIDER_PRESETS.ollama.model);
    });

    it('uses explicit provider preset for openrouter', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'openrouter',
      });

      expect(config.provider).toBe('openrouter');
      expect(config.llmApiKey).toBeTruthy();
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.openrouter.baseUrl);
      expect(config.llmModel).toBe('openrouter/free');
    });

    it('uses explicit provider preset for openai', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'openai',
        llmApiKey: 'sk-xxx',
      });

      expect(config.provider).toBe('openai');
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.openai.baseUrl);
      expect(config.llmModel).toBe(PROVIDER_PRESETS.openai.model);
    });

    it('explicit llmBaseUrl overrides provider preset', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'ollama',
        llmBaseUrl: 'http://remote-server:11434/v1',
      });

      expect(config.llmBaseUrl).toBe('http://remote-server:11434/v1');
    });

    it('explicit llmModel overrides provider preset', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'ollama',
        llmModel: 'mistral:7b',
      });

      expect(config.llmModel).toBe('mistral:7b');
    });

    it('LLM_PROVIDER env var sets provider', () => {
      process.env.LLM_PROVIDER = 'openai';

      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        llmApiKey: 'sk-xxx',
      });

      expect(config.provider).toBe('openai');
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.openai.baseUrl);
    });

    it('explicit provider overrides LLM_PROVIDER env var', () => {
      process.env.LLM_PROVIDER = 'openai';

      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'groq',
        llmApiKey: 'my-key',
      });

      expect(config.provider).toBe('groq');
    });

    it('ollama provider with groqApiKey still works (backward compat)', () => {
      const config = resolveConfig({
        databaseUrl: 'postgres://localhost/testdb',
        provider: 'ollama',
        groqApiKey: 'old-key',
      });

      // groqApiKey is resolved as llmApiKey, provider is still ollama
      expect(config.llmApiKey).toBe('old-key');
      expect(config.provider).toBe('ollama');
      expect(config.llmBaseUrl).toBe(PROVIDER_PRESETS.ollama.baseUrl);
    });
  });
});
