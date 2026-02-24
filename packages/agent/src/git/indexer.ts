import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import Database from 'better-sqlite3';
import { INDEXED_EXTENSIONS, EXCLUDED_PATHS, SECRET_PATTERNS, CODE_INDEX_DB, AGENT_DATA_DIR } from '@chatbot/shared';
import { homedir } from 'node:os';

const DB_PATH = join(homedir(), AGENT_DATA_DIR, CODE_INDEX_DB);
const CHUNK_MIN = 50;
const CHUNK_MAX = 150;
const CHUNK_OVERLAP = 10;

// Regex for function/class boundaries across common languages
const BOUNDARY_PATTERNS = [
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|module)\s+/m,
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/m,
  /^\s*(?:def|class)\s+\w+/m,           // Python/Ruby
  /^\s*(?:public|private|protected|static)\s+/m, // Java/C#
  /^\s*(?:fn|impl|struct|trait|pub)\s+/m, // Rust
  /^\s*(?:func)\s+/m,                    // Go
];

function isExcludedPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return EXCLUDED_PATHS.some(pattern => {
    if (pattern.endsWith('/')) {
      return lower.includes(pattern) || lower.includes(pattern.slice(0, -1));
    }
    if (pattern.startsWith('*.')) {
      return lower.endsWith(pattern.slice(1));
    }
    return lower.includes(pattern);
  });
}

function containsSecrets(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(content));
}

function isBoundaryLine(line: string): boolean {
  return BOUNDARY_PATTERNS.some(p => p.test(line));
}

export interface CodeChunkRecord {
  file: string;
  lineStart: number;
  lineEnd: number;
  content: string;
}

function chunkFile(filePath: string, content: string): CodeChunkRecord[] {
  const lines = content.split('\n');
  if (lines.length <= CHUNK_MAX) {
    return [{
      file: filePath,
      lineStart: 1,
      lineEnd: lines.length,
      content,
    }];
  }

  const chunks: CodeChunkRecord[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = Math.min(start + CHUNK_MAX, lines.length);

    // Try to find a boundary near the end for clean splits
    if (end < lines.length) {
      for (let i = end; i >= start + CHUNK_MIN; i--) {
        if (isBoundaryLine(lines[i])) {
          end = i;
          break;
        }
      }
    }

    chunks.push({
      file: filePath,
      lineStart: start + 1,
      lineEnd: end,
      content: lines.slice(start, end).join('\n'),
    });

    start = end - CHUNK_OVERLAP;
    if (start >= lines.length) break;
  }

  return chunks;
}

function walkDir(dir: string, rootDir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (isExcludedPath(relPath)) continue;

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, rootDir));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (INDEXED_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath || DB_PATH;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      tokens TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file);
  `);
  return db;
}

export function indexRepository(repoPath: string, dbPath?: string): { filesIndexed: number; chunksCreated: number } {
  const db = initDatabase(dbPath);

  // Clear existing index
  db.exec('DELETE FROM code_chunks');

  const files = walkDir(repoPath, repoPath);
  let chunksCreated = 0;

  const insert = db.prepare(
    'INSERT INTO code_chunks (file, line_start, line_end, content, tokens) VALUES (?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((chunks: CodeChunkRecord[]) => {
    for (const chunk of chunks) {
      // Tokenize: lowercase, split on non-word chars
      const tokens = chunk.content
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length > 1)
        .join(' ');
      insert.run(chunk.file, chunk.lineStart, chunk.lineEnd, chunk.content, tokens);
      chunksCreated++;
    }
  });

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      if (stat.size > 1_000_000) continue; // Skip files > 1MB

      const content = readFileSync(filePath, 'utf-8');
      if (containsSecrets(content)) continue;

      const relPath = relative(repoPath, filePath);
      const chunks = chunkFile(relPath, content);
      insertMany(chunks);
    } catch {
      // Skip unreadable files
    }
  }

  db.close();
  return { filesIndexed: files.length, chunksCreated };
}
