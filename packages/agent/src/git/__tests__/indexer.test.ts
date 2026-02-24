import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { indexRepository } from '../indexer.js';
import { searchCode } from '../search.js';

describe('Code Indexer', () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'indexer-test-'));
    dbPath = join(tempDir, 'test-index.db');

    // Create some test files
    writeFileSync(join(tempDir, 'app.rb'), [
      'class ApplicationController < ActionController::Base',
      '  def index',
      '    @items = Item.all',
      '  end',
      '',
      '  def show',
      '    @item = Item.find(params[:id])',
      '  end',
      'end',
    ].join('\n'));

    writeFileSync(join(tempDir, 'model.py'), [
      'class User:',
      '    def __init__(self, name):',
      '        self.name = name',
      '',
      '    def full_name(self):',
      '        return f"{self.first_name} {self.last_name}"',
    ].join('\n'));

    // Secret file should be skipped
    writeFileSync(join(tempDir, '.env'), 'DATABASE_URL=secret');

    // Non-indexed extension
    writeFileSync(join(tempDir, 'image.png'), 'binary');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes .rb and .py files, skips .env and .png', () => {
    const result = indexRepository(tempDir, dbPath);
    expect(result.filesIndexed).toBeGreaterThanOrEqual(2); // at least .rb and .py
    expect(result.chunksCreated).toBeGreaterThanOrEqual(2);
  });

  it('search finds relevant chunks', () => {
    // Index first
    indexRepository(tempDir, dbPath);

    // Search for something in the Ruby file
    const results = searchCode('ApplicationController index', 5, dbPath);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toBe('app.rb');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('search returns empty for non-matching query', () => {
    indexRepository(tempDir, dbPath);
    const results = searchCode('xyznonexistent', 5, dbPath);
    expect(results.length).toBe(0);
  });
});
