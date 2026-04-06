import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { indexFiles } from '../file-indexer.js';

describe('indexFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes .ts, .tsx, .js, .jsx files', () => {
    fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'export default function App() {}');
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), 'export function helper() {}');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), '.app { color: red }');
    const files = indexFiles(tmpDir);
    expect(files.length).toBe(2);
    expect(files.map(f => f.path)).toContain('App.tsx');
    expect(files.map(f => f.path)).toContain('utils.ts');
  });

  it('skips node_modules and dist directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'module.exports = {}');
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'bundled');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const x = 1');
    const files = indexFiles(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src.ts');
  });

  it('skips files larger than 100KB', () => {
    fs.writeFileSync(path.join(tmpDir, 'small.ts'), 'export const x = 1');
    fs.writeFileSync(path.join(tmpDir, 'large.ts'), 'x'.repeat(150_000));
    const files = indexFiles(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('small.ts');
  });

  it('caps at maxFiles', () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), `export const x${i} = ${i}`);
    }
    const files = indexFiles(tmpDir, { maxFiles: 5 });
    expect(files.length).toBe(5);
  });

  it('includes file content', () => {
    fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'export default function App() { return <div>Hello</div> }');
    const files = indexFiles(tmpDir);
    expect(files[0].content).toContain('export default function App()');
  });
});
