import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeIndexer } from '../services/code-indexer.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-indexer-test-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('CodeIndexer', () => {
  let tmpDirs: string[];
  let indexer: CodeIndexer;

  beforeEach(() => {
    tmpDirs = [];
    indexer = new CodeIndexer();
  });

  afterEach(() => {
    tmpDirs.forEach(cleanDir);
  });

  function createTmpDir(): string {
    const dir = makeTempDir();
    tmpDirs.push(dir);
    return dir;
  }

  it('indexes files from multiple codePaths', async () => {
    const dir1 = createTmpDir();
    const dir2 = createTmpDir();

    writeFile(dir1, 'src/app.ts', 'console.log("hello")');
    writeFile(dir1, 'src/utils.js', 'module.exports = {}');
    writeFile(dir2, 'lib/helper.ts', 'export function help() {}');

    await indexer.index([dir1, dir2]);

    expect(indexer.fileCount()).toBe(3);
  });

  it('skips node_modules, .git, dist, build directories', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/app.ts', 'good file');
    writeFile(dir, 'node_modules/pkg/index.js', 'skip me');
    writeFile(dir, '.git/config', 'skip me');
    writeFile(dir, 'dist/bundle.js', 'skip me');
    writeFile(dir, 'build/output.js', 'skip me');
    writeFile(dir, 'vendor/lib.rb', 'skip me');
    writeFile(dir, 'tmp/cache.js', 'skip me');
    writeFile(dir, '__pycache__/mod.py', 'skip me');
    writeFile(dir, '.next/server.js', 'skip me');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(1);
  });

  it('only reads supported file extensions', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app.ts', 'typescript');
    writeFile(dir, 'app.js', 'javascript');
    writeFile(dir, 'app.tsx', 'tsx');
    writeFile(dir, 'app.jsx', 'jsx');
    writeFile(dir, 'app.rb', 'ruby');
    writeFile(dir, 'app.py', 'python');
    writeFile(dir, 'app.erb', 'erb');
    writeFile(dir, 'app.vue', 'vue');
    writeFile(dir, 'app.css', 'skip css');
    writeFile(dir, 'app.html', 'skip html');
    writeFile(dir, 'app.json', 'skip json');
    writeFile(dir, 'app.md', 'skip markdown');
    writeFile(dir, 'app.txt', 'skip text');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(8);
  });

  it('detects Express routes (app.get, router.post, etc.)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes/users.js', `
const express = require('express');
const router = express.Router();

router.get('/users', (req, res) => {
  res.json([]);
});

router.post('/users', (req, res) => {
  res.json({});
});

app.get('/health', (req, res) => {
  res.send('ok');
});

app.delete('/users/:id', (req, res) => {
  res.sendStatus(204);
});

module.exports = router;
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/:id' }));
  });

  it('detects React Router routes (<Route path="..." />)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/App.tsx', `
import { Route, Routes } from 'react-router-dom';

function App() {
  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/users/:id" element={<UserDetail />} />
      <Route path='/settings' element={<Settings />} />
    </Routes>
  );
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/dashboard' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/settings' }));
  });

  it('detects Next.js file-based routes (pages/ directory structure)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'pages/index.tsx', 'export default function Home() {}');
    writeFile(dir, 'pages/about.tsx', 'export default function About() {}');
    writeFile(dir, 'pages/users/index.tsx', 'export default function Users() {}');
    writeFile(dir, 'pages/users/[id].tsx', 'export default function User() {}');
    writeFile(dir, 'pages/posts/[...slug].tsx', 'export default function Post() {}');
    writeFile(dir, 'pages/api/health.ts', 'export default function handler() {}');
    // _app and _document should be skipped
    writeFile(dir, 'pages/_app.tsx', 'export default function App() {}');
    writeFile(dir, 'pages/_document.tsx', 'export default function Doc() {}');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/posts/:slug*' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/health' }));

    // _app and _document should not produce routes
    const routePaths = routes.map(r => r.path);
    expect(routePaths).not.toContain('/_app');
    expect(routePaths).not.toContain('/_document');
  });

  it('detects Rails routes from routes.rb', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'home#index'
  resources :users
  get '/about', to: 'pages#about'
  post '/login', to: 'sessions#create'
  namespace :admin do
    resources :reports
  end
end
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/login' }));
  });

  it('search() returns matching files with snippets', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/models/user.ts', `
import { db } from '../db';

export class User {
  static async findById(id: number) {
    return db.query('SELECT * FROM users WHERE id = $1', [id]);
  }

  static async findByEmail(email: string) {
    return db.query('SELECT * FROM users WHERE email = $1', [email]);
  }
}
`);
    writeFile(dir, 'src/models/post.ts', 'export class Post {}');

    await indexer.index([dir]);
    const results = indexer.search(['findById', 'email']);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toContain('user.ts');
    expect(results[0].content).toContain('findById');
  });

  it('search() is case-insensitive', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/app.ts', 'function CreateUser() { return true; }');

    await indexer.index([dir]);
    const results = indexer.search(['createuser']);

    expect(results.length).toBe(1);
    expect(results[0].file).toContain('app.ts');
  });

  it('search() returns results ranked by match count', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/one-match.ts', 'function alpha() { return "hello"; }');
    writeFile(dir, 'src/two-matches.ts', 'function alpha() { return beta(); }');
    writeFile(dir, 'src/no-match.ts', 'function gamma() { return 42; }');

    await indexer.index([dir]);
    const results = indexer.search(['alpha', 'beta']);

    expect(results.length).toBe(2);
    // two-matches should come first (higher match count)
    expect(results[0].file).toContain('two-matches.ts');
    expect(results[0].matchCount).toBe(2);
    expect(results[1].file).toContain('one-match.ts');
    expect(results[1].matchCount).toBe(1);
  });

  it('getRouteSummary() returns formatted route text', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes/api.js', `
router.get('/api/users', handler);
router.post('/api/users', handler);
`);

    await indexer.index([dir]);
    const summary = indexer.getRouteSummary();

    expect(summary).toContain('Routes detected:');
    expect(summary).toMatch(/GET\s+\/api\/users/);
    expect(summary).toMatch(/POST\s+\/api\/users/);
    // Should include the file reference
    expect(summary).toContain('api.js');
  });

  it('fileCount() returns correct count', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'a.ts', 'a');
    writeFile(dir, 'b.ts', 'b');
    writeFile(dir, 'c.js', 'c');
    writeFile(dir, 'skip.css', 'skip');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(3);
  });

  it('caps at 2000 files and logs a warning', async () => {
    const dir = createTmpDir();

    // Write just a few files but mock the cap to a low number to test the warning
    writeFile(dir, 'a.ts', 'a');
    writeFile(dir, 'b.ts', 'b');
    writeFile(dir, 'c.ts', 'c');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create indexer with a low cap to test the warning behavior
    const cappedIndexer = new CodeIndexer({ maxFiles: 2 });
    await cappedIndexer.index([dir]);

    expect(cappedIndexer.fileCount()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('2')
    );

    warnSpy.mockRestore();
  });

  it('getRouteSummary() returns empty message when no routes detected', async () => {
    const dir = createTmpDir();
    writeFile(dir, 'src/utils.ts', 'export const add = (a: number, b: number) => a + b;');

    await indexer.index([dir]);
    const summary = indexer.getRouteSummary();

    expect(summary).toBe('No routes detected.');
  });
});
