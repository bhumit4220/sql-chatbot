import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestFile } from './types.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.svelte-kit', '__pycache__', 'coverage', '.turbo',
]);

const MAX_FILE_SIZE = 100_000;
const DEFAULT_MAX_FILES = 2000;

interface IndexOptions {
  maxFiles?: number;
  include?: string[];
  exclude?: string[];
}

export function indexFiles(rootDir: string, options?: IndexOptions): ManifestFile[] {
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const extraExclude = new Set(options?.exclude ?? []);
  const files: ManifestFile[] = [];

  function scan(dir: string): void {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || extraExclude.has(entry.name)) continue;
        scan(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relativePath = path.relative(rootDir, fullPath);
          files.push({ path: relativePath, content });
        } catch { /* skip */ }
      }
    }
  }

  scan(rootDir);
  return files.slice(0, maxFiles);
}
