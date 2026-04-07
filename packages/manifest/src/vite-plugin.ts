import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginOptions } from './types.js';
import { buildManifest } from './scanner.js';

export function sqlChatbotManifest(options?: PluginOptions) {
  let rootDir = process.cwd();
  let outputPath = options?.output ?? '';

  return {
    name: 'sql-chatbot-manifest',

    configResolved(config: { root: string }) {
      rootDir = config.root;
      if (!outputPath) {
        outputPath = path.join(rootDir, 'public', 'chatbot-manifest.json');
      }
    },

    buildStart() {
      if (!outputPath) {
        outputPath = path.join(rootDir, 'public', 'chatbot-manifest.json');
      }
      generateManifest(rootDir, outputPath, options);
    },

    configureServer(server: { watcher: { on: (event: string, cb: (file: string) => void) => void } }) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      function scheduleRegenerate(file: string) {
        const ext = path.extname(file);
        if (!['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'].includes(ext)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => generateManifest(rootDir, outputPath, options), 500);
      }
      server.watcher.on('change', scheduleRegenerate);
      server.watcher.on('add', scheduleRegenerate);
    },
  };
}

function generateManifest(rootDir: string, outputPath: string, options?: PluginOptions): void {
  try {
    const manifest = buildManifest(rootDir, options);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.warn('[sql-chatbot-manifest] Failed to generate manifest:', (err as Error).message);
  }
}
