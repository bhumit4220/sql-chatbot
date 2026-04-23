import fs from 'fs';
import path from 'path';
import { introspectDjango } from './grammar/introspectors/django.js';
import type { Registry } from './grammar/registry.js';

export interface IntrospectOptions {
  framework: 'django';
  code: string;
  out?: string;
}

export async function runIntrospectCommand(opts: IntrospectOptions): Promise<Registry> {
  let registry: Registry;
  if (opts.framework === 'django') {
    registry = await introspectDjango(opts.code);
  } else {
    throw new Error(`unsupported framework: ${opts.framework}`);
  }
  const outPath = opts.out ?? path.resolve(process.cwd(), 'sql-chatbot-manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
  return registry;
}
