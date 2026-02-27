#!/usr/bin/env node

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

export interface CliFlags {
  db?: string;
  key?: string;
  code?: string;
  port?: string;
  secret?: string;
  subcommand?: string;
}

export interface FileConfig {
  databaseUrl?: string;
  groqApiKey?: string;
  codePaths?: string[];
  port?: number;
  secret?: string;
}

export interface MergedConfig {
  databaseUrl?: string;
  groqApiKey?: string;
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
      code: { type: 'string' },
      port: { type: 'string', short: 'p' },
      secret: { type: 'string' },
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
  return {
    databaseUrl: flags.db || env.DATABASE_URL || file.databaseUrl,
    groqApiKey: flags.key || env.GROQ_API_KEY || file.groqApiKey,
    codePaths: flags.code ? [flags.code] : file.codePaths || ['./src'],
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
      groqApiKey: 'your-groq-api-key',
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

  if (!config.groqApiKey) {
    console.error('Error: API key is required.');
    console.error('Provide --key flag, set GROQ_API_KEY env var, or add groqApiKey to chatbot.config.json');
    process.exit(1);
  }

  if (!config.secret) {
    console.warn('Warning: No secret configured. The chatbot API is open to anyone.');
    console.warn('Set --secret flag, CHATBOT_SECRET env var, or add secret to chatbot.config.json');
  }

  // Import express and cors dynamically to keep test imports clean
  import('express').then(async (expressModule) => {
    const express = expressModule.default;
    const corsModule = await import('cors');
    const cors = corsModule.default;
    const { sqlChatbot } = await import('./middleware.js');

    const app = express();
    app.use(cors());

    app.use('/chatbot', sqlChatbot({
      databaseUrl: config.databaseUrl!,
      groqApiKey: config.groqApiKey,
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

    app.listen(config.port, () => {
      console.log(`\nSQL Chatbot Agent running at http://localhost:${config.port}`);
      console.log(`  Chat widget:  http://localhost:${config.port}`);
      console.log(`  Health check: http://localhost:${config.port}/chatbot/api/health`);
      console.log(`  Auth: ${config.secret ? 'enabled' : 'DISABLED (no secret)'}\n`);
    });
  });
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (isDirectRun) {
  main();
}
