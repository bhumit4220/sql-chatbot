#!/usr/bin/env node

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from './config.js';
import { PROVIDER_PRESETS } from './config.js';

export interface CliFlags {
  db?: string;
  key?: string;
  code?: string[];
  port?: string;
  secret?: string;
  provider?: string;
  model?: string;
  'base-url'?: string;
  subcommand?: string;
}

export interface FileConfig {
  databaseUrl?: string;
  groqApiKey?: string;
  llmApiKey?: string;
  provider?: LLMProvider;
  llmModel?: string;
  llmBaseUrl?: string;
  codePaths?: string[];
  port?: number;
  secret?: string;
}

export interface MergedConfig {
  databaseUrl?: string;
  llmApiKey?: string;
  provider?: LLMProvider;
  llmModel?: string;
  llmBaseUrl?: string;
  codePaths: string[];
  port: number;
  secret?: string;
}

export function parseCliArgs(argv: string[]): CliFlags {
  if (argv[0] && !argv[0].startsWith('-')) {
    return { subcommand: argv[0] };
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      key: { type: 'string' },
      code: { type: 'string', multiple: true },
      port: { type: 'string', short: 'p' },
      secret: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
    },
    strict: false,
  });

  return values as CliFlags;
}

export function loadConfigFile(dir: string): FileConfig {
  const configPath = path.join(dir, 'chatbot.config.json');
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as FileConfig;
}

export function mergeConfig(
  file: FileConfig,
  env: Record<string, string | undefined>,
  flags: CliFlags,
): MergedConfig {
  // Resolve API key: flags --key > env > file (llmApiKey or groqApiKey for backward compat)
  const llmApiKey = flags.key || env.LLM_API_KEY || env.GROQ_API_KEY || env.OPENROUTER_API_KEY || file.llmApiKey || file.groqApiKey;

  // Resolve provider: flags > env > file > auto-detect (has key → groq, no key → ollama)
  const provider = (flags.provider || env.LLM_PROVIDER || file.provider || undefined) as LLMProvider | undefined;

  return {
    databaseUrl: flags.db || env.DATABASE_URL || file.databaseUrl,
    llmApiKey,
    provider,
    llmModel: flags.model || env.LLM_MODEL || file.llmModel,
    llmBaseUrl: flags['base-url'] || env.LLM_BASE_URL || file.llmBaseUrl,
    codePaths: flags.code?.length ? flags.code : file.codePaths || ['./src'],
    port: flags.port ? parseInt(flags.port, 10) : env.PORT ? parseInt(env.PORT, 10) : file.port || 3456,
    secret: flags.secret || env.CHATBOT_SECRET || file.secret,
  };
}

export function runInit(dir: string): void {
  const configPath = path.join(dir, 'chatbot.config.json');
  if (fs.existsSync(configPath)) {
    console.log('chatbot.config.json already exists, skipping.');
  } else {
    const template = {
      databaseUrl: 'postgresql://user:password@localhost:5432/your_database',
      provider: 'openrouter',
      llmApiKey: '',
      codePaths: ['./src'],
      port: 3456,
      secret: '',
    };
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + '\n');
    console.log('Created chatbot.config.json');
  }

  const gitignorePath = path.join(dir, '.gitignore');
  const entry = 'chatbot.config.json';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, '\n' + entry + '\n');
      console.log('Added chatbot.config.json to .gitignore');
    } else {
      console.log('chatbot.config.json already in .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, entry + '\n');
    console.log('Created .gitignore with chatbot.config.json');
  }
}

export async function checkOllamaConnection(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl.replace(/\/v1$/, '/api/tags'), { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function main(): void {
  // Dynamic imports to avoid loading express/cors at test time
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.subcommand === 'init') {
    runInit(process.cwd());
    return;
  }

  const fileConfig = loadConfigFile(process.cwd());
  const config = mergeConfig(fileConfig, process.env, flags);

  if (!config.databaseUrl) {
    console.error('Error: Database URL is required.');
    console.error('Provide --db flag, set DATABASE_URL env var, or add databaseUrl to chatbot.config.json');
    process.exit(1);
  }

  // API key is required for all providers except ollama
  if (!config.llmApiKey && config.provider !== 'ollama') {
    console.error('Error: API key is required.');
    console.error('Provide --key flag, set LLM_API_KEY or OPENROUTER_API_KEY env var.');
    console.error('Get a free OpenRouter key at: https://openrouter.ai/keys');
    process.exit(1);
  }

  if (!config.secret) {
    console.warn('Warning: No secret configured. The chatbot API is open to anyone.');
    console.warn('Set --secret flag, CHATBOT_SECRET env var, or add secret to chatbot.config.json');
  }

  // Detect effective provider for connectivity check
  const effectiveProvider = config.provider || (config.llmApiKey ? 'groq' : 'openrouter');
  const ollamaBaseUrl = config.llmBaseUrl || PROVIDER_PRESETS.ollama.baseUrl;

  // Import express and cors dynamically to keep test imports clean
  (async () => {
    // Check Ollama connectivity before starting server
    if (effectiveProvider === 'ollama') {
      const ok = await checkOllamaConnection(ollamaBaseUrl);
      if (!ok) {
        console.error('\nError: Ollama is not running at ' + ollamaBaseUrl);
        console.error('Start it with: ollama serve');
        console.error('Then pull a model: ollama pull llama3.1:8b\n');
        process.exit(1);
      }
    }

    const expressModule = await import('express');
    const express = expressModule.default;
    const corsModule = await import('cors');
    const cors = corsModule.default;
    const { sqlChatbot } = await import('./middleware.js');

    const app = express();
    app.use(cors());

    app.use('/chatbot', sqlChatbot({
      databaseUrl: config.databaseUrl!,
      llmApiKey: config.llmApiKey,
      llmBaseUrl: config.llmBaseUrl,
      llmModel: config.llmModel,
      provider: config.provider,
      codePaths: config.codePaths,
      secret: config.secret,
    }));

    app.get('/', (_req, res) => {
      res.send(`<!DOCTYPE html>
<html>
<head><title>SQL Chatbot</title></head>
<body>
  <h1>SQL Chatbot</h1>
  <p>The chat widget should appear in the bottom-right corner.</p>
  <script src="/chatbot/widget.js"></script>
</body>
</html>`);
    });

    const providerLabel = config.provider || (config.llmApiKey ? 'groq' : 'openrouter');
    app.listen(config.port, () => {
      console.log(`\nSQL Chatbot Agent running at http://localhost:${config.port}`);
      console.log(`  Provider:     ${providerLabel}`);
      console.log(`  Chat widget:  http://localhost:${config.port}`);
      console.log(`  Health check: http://localhost:${config.port}/chatbot/api/health`);
      console.log(`  Auth: ${config.secret ? 'enabled' : 'DISABLED (no secret)'}\n`);
    });
  })();
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun = process.argv[1]?.endsWith('cli.js')
  || process.argv[1]?.endsWith('cli.ts')
  || process.argv[1]?.endsWith('sql-chatbot-agent');
if (isDirectRun) {
  main();
}
