import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AGENT_DATA_DIR, CODE_INDEX_DB } from '@chatbot/shared';
import type { CodeChunk } from '@chatbot/shared';

const DB_PATH = join(homedir(), AGENT_DATA_DIR, CODE_INDEX_DB);

/**
 * BM25-inspired search over code chunks.
 * Uses SQLite approach: tokenize query, score chunks by term frequency with IDF weighting.
 */
export function searchCode(query: string, limit: number = 10, dbPath?: string): CodeChunk[] {
  const path = dbPath || DB_PATH;
  const db = new Database(path, { readonly: true });

  try {
    // Tokenize query
    const queryTokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(t => t.length > 1);

    if (queryTokens.length === 0) return [];

    // Get total doc count for IDF
    const totalDocs = (db.prepare('SELECT COUNT(*) as count FROM code_chunks').get() as { count: number }).count;
    if (totalDocs === 0) return [];

    // For each token, get document frequency
    const dfMap = new Map<string, number>();
    for (const token of queryTokens) {
      const result = db.prepare(
        "SELECT COUNT(*) as count FROM code_chunks WHERE tokens LIKE ?"
      ).get(`%${token}%`) as { count: number };
      dfMap.set(token, result.count);
    }

    // Score all chunks
    const allChunks = db.prepare('SELECT * FROM code_chunks').all() as {
      id: number;
      file: string;
      line_start: number;
      line_end: number;
      content: string;
      tokens: string;
    }[];

    const scored: (CodeChunk & { score: number })[] = allChunks.map(row => {
      const chunkTokens = row.tokens.split(' ');
      const chunkLength = chunkTokens.length;

      let score = 0;
      const k1 = 1.5;
      const b = 0.75;
      const avgLength = 100; // approximate average chunk token count

      for (const token of queryTokens) {
        const tf = chunkTokens.filter((t: string) => t === token).length;
        const df = dfMap.get(token) || 1;
        const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * chunkLength / avgLength));
        score += idf * tfNorm;
      }

      return {
        file: row.file,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        content: row.content,
        score,
      };
    });

    // Sort by score descending, return top N
    return scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } finally {
    db.close();
  }
}
