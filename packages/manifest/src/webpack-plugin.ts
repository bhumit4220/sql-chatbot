import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginOptions } from './types.js';
import { buildManifest } from './scanner.js';

interface WebpackPluginOptions extends PluginOptions {
  rootDir?: string;
}

export class SqlChatbotManifestPlugin {
  private options: WebpackPluginOptions;

  constructor(options?: WebpackPluginOptions) {
    this.options = options ?? {};
  }

  apply(compiler: any): void {
    const rootDir = this.options.rootDir ?? compiler.context ?? process.cwd();
    const outputPath = this.options.output ?? path.join(rootDir, 'public', 'chatbot-manifest.json');
    compiler.hooks.beforeCompile.tapAsync('SqlChatbotManifestPlugin', (_params: any, callback: Function) => {
      this.generate(rootDir, outputPath);
      callback();
    });
    compiler.hooks.watchRun.tapAsync('SqlChatbotManifestPlugin', (_compiler: any, callback: Function) => {
      this.generate(rootDir, outputPath);
      callback();
    });
  }

  private generate(rootDir: string, outputPath: string): void {
    try {
      const manifest = buildManifest(rootDir, this.options);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.warn('[sql-chatbot-manifest] Failed to generate manifest:', (err as Error).message);
    }
  }
}
