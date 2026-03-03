import { describe, it, expect } from 'vitest';
import { parseCliArgs, loadConfigFile, mergeConfig, runInit } from '../cli.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('parseCliArgs', () => {
  it('parses --db flag', () => {
    const result = parseCliArgs(['--db', 'postgresql://localhost/test']);
    expect(result.db).toBe('postgresql://localhost/test');
  });

  it('parses --key flag', () => {
    const result = parseCliArgs(['--key', 'gsk_xxx']);
    expect(result.key).toBe('gsk_xxx');
  });

  it('parses --code flag', () => {
    const result = parseCliArgs(['--code', './app']);
    expect(result.code).toEqual(['./app']);
  });

  it('parses multiple --code flags', () => {
    const result = parseCliArgs(['--code', './app', '--code', './config']);
    expect(result.code).toEqual(['./app', './config']);
  });

  it('parses --port flag', () => {
    const result = parseCliArgs(['--port', '5000']);
    expect(result.port).toBe('5000');
  });

  it('parses -p as alias for --port', () => {
    const result = parseCliArgs(['-p', '5000']);
    expect(result.port).toBe('5000');
  });

  it('parses --secret flag', () => {
    const result = parseCliArgs(['--secret', 'my-token']);
    expect(result.secret).toBe('my-token');
  });

  it('parses --provider flag', () => {
    const result = parseCliArgs(['--provider', 'ollama']);
    expect(result.provider).toBe('ollama');
  });

  it('parses --model flag', () => {
    const result = parseCliArgs(['--model', 'mistral:7b']);
    expect(result.model).toBe('mistral:7b');
  });

  it('parses --base-url flag', () => {
    const result = parseCliArgs(['--base-url', 'http://localhost:11434/v1']);
    expect(result['base-url']).toBe('http://localhost:11434/v1');
  });

  it('detects init subcommand', () => {
    const result = parseCliArgs(['init']);
    expect(result.subcommand).toBe('init');
  });

  it('returns undefined for missing flags', () => {
    const result = parseCliArgs([]);
    expect(result.db).toBeUndefined();
    expect(result.key).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.subcommand).toBeUndefined();
  });

  it('parses all flags together', () => {
    const result = parseCliArgs([
      '--db', 'postgresql://localhost/test',
      '--provider', 'groq',
      '--key', 'gsk_xxx',
      '--model', 'llama-3.3-70b-versatile',
      '--base-url', 'https://api.groq.com/openai/v1',
      '--code', './src',
      '-p', '4000',
      '--secret', 'my-secret',
    ]);
    expect(result.db).toBe('postgresql://localhost/test');
    expect(result.provider).toBe('groq');
    expect(result.key).toBe('gsk_xxx');
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result['base-url']).toBe('https://api.groq.com/openai/v1');
    expect(result.code).toEqual(['./src']);
    expect(result.port).toBe('4000');
    expect(result.secret).toBe('my-secret');
  });
});

describe('loadConfigFile', () => {
  it('loads chatbot.config.json from a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    const configPath = path.join(tmpDir, 'chatbot.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      databaseUrl: 'postgresql://localhost/mydb',
      groqApiKey: 'gsk_test',
      codePaths: ['./models'],
      port: 4000,
      secret: 'file-secret',
    }));
    const config = loadConfigFile(tmpDir);
    expect(config).toEqual({
      databaseUrl: 'postgresql://localhost/mydb',
      groqApiKey: 'gsk_test',
      codePaths: ['./models'],
      port: 4000,
      secret: 'file-secret',
    });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads new-style config with provider field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    const configPath = path.join(tmpDir, 'chatbot.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      databaseUrl: 'postgresql://localhost/mydb',
      provider: 'ollama',
      llmApiKey: '',
      codePaths: ['./src'],
      port: 3456,
    }));
    const config = loadConfigFile(tmpDir);
    expect(config.provider).toBe('ollama');
    expect(config.llmApiKey).toBe('');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty object when no config file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    const config = loadConfigFile(tmpDir);
    expect(config).toEqual({});
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('mergeConfig', () => {
  it('CLI flags override env vars which override config file', () => {
    const result = mergeConfig(
      { databaseUrl: 'file-db', groqApiKey: 'file-key', port: 3000 },
      { DATABASE_URL: 'env-db', GROQ_API_KEY: 'env-key', PORT: '4000' },
      { db: 'cli-db' },
    );
    expect(result.databaseUrl).toBe('cli-db');
    expect(result.llmApiKey).toBe('env-key');
    expect(result.port).toBe(4000);
  });

  it('falls back through the priority chain', () => {
    const result = mergeConfig(
      { databaseUrl: 'file-db', groqApiKey: 'file-key', port: 3000 },
      {},
      {},
    );
    expect(result.databaseUrl).toBe('file-db');
    expect(result.llmApiKey).toBe('file-key');
    expect(result.port).toBe(3000);
  });

  it('uses default port 3456 when nothing specified', () => {
    const result = mergeConfig({}, {}, {});
    expect(result.port).toBe(3456);
  });

  it('uses default codePaths ["./src"] when nothing specified', () => {
    const result = mergeConfig({}, {}, {});
    expect(result.codePaths).toEqual(['./src']);
  });

  it('--provider flag sets provider', () => {
    const result = mergeConfig({}, {}, { provider: 'ollama' });
    expect(result.provider).toBe('ollama');
  });

  it('--model flag sets llmModel', () => {
    const result = mergeConfig({}, {}, { model: 'mistral:7b' });
    expect(result.llmModel).toBe('mistral:7b');
  });

  it('--base-url flag sets llmBaseUrl', () => {
    const result = mergeConfig({}, {}, { 'base-url': 'http://localhost:11434/v1' });
    expect(result.llmBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('LLM_PROVIDER env var sets provider', () => {
    const result = mergeConfig({}, { LLM_PROVIDER: 'openai' }, {});
    expect(result.provider).toBe('openai');
  });

  it('file config provider is used as fallback', () => {
    const result = mergeConfig({ provider: 'ollama' }, {}, {});
    expect(result.provider).toBe('ollama');
  });

  it('CLI --key flag overrides env and file for llmApiKey', () => {
    const result = mergeConfig(
      { llmApiKey: 'file-key' },
      { LLM_API_KEY: 'env-key' },
      { key: 'cli-key' },
    );
    expect(result.llmApiKey).toBe('cli-key');
  });

  it('new-style llmApiKey in file config works', () => {
    const result = mergeConfig(
      { llmApiKey: 'new-style-key' },
      {},
      {},
    );
    expect(result.llmApiKey).toBe('new-style-key');
  });

  it('groqApiKey in file config still works (backward compat)', () => {
    const result = mergeConfig(
      { groqApiKey: 'old-style-key' },
      {},
      {},
    );
    expect(result.llmApiKey).toBe('old-style-key');
  });
});

describe('runInit', () => {
  it('creates chatbot.config.json with new-style template', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    runInit(tmpDir);

    const configPath = path.join(tmpDir, 'chatbot.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.databaseUrl).toContain('postgresql://');
    expect(config.provider).toBe('openrouter');
    expect(config.llmApiKey).toBe('');
    expect(config.port).toBe(3456);
    // Should NOT have old groqApiKey field
    expect(config.groqApiKey).toBeUndefined();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('does not overwrite existing chatbot.config.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    const configPath = path.join(tmpDir, 'chatbot.config.json');
    fs.writeFileSync(configPath, '{"custom": true}');

    runInit(tmpDir);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.custom).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('appends to existing .gitignore', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n');

    runInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('chatbot.config.json');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates .gitignore if it does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    runInit(tmpDir);

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('chatbot.config.json');
    fs.rmSync(tmpDir, { recursive: true });
  });
});
