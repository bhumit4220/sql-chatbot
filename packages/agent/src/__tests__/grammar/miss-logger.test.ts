import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logMiss } from '../../grammar/miss-logger.js';

describe('logMiss', () => {
  it('appends ndjson entry with timestamp', () => {
    const f = path.join(os.tmpdir(), `grammar-miss-${Date.now()}.ndjson`);
    logMiss(f, { question: 'x', reason: 'unmatched', extracted: null });
    logMiss(f, { question: 'y', reason: 'unknown_entity', extracted: { entity: 'ghost' } });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.question).toBe('x');
    expect(typeof parsed.ts).toBe('string');
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `grammar-${Date.now()}`);
    const f = path.join(dir, 'nested', 'miss.ndjson');
    logMiss(f, { question: 'z', reason: 'x', extracted: null });
    expect(fs.existsSync(f)).toBe(true);
  });
});
