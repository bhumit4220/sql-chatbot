import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqlChatbotManifestPlugin } from '../webpack-plugin.js';

describe('SqlChatbotManifestPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpack-plugin-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return <Routes><Route path="/dashboard" element={<div />} /></Routes>;
      }
    `);
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a plugin instance', () => {
    const plugin = new SqlChatbotManifestPlugin({ rootDir: tmpDir });
    expect(plugin).toBeInstanceOf(SqlChatbotManifestPlugin);
  });

  it('has an apply method for webpack', () => {
    const plugin = new SqlChatbotManifestPlugin({ rootDir: tmpDir });
    expect(typeof plugin.apply).toBe('function');
  });

  it('generates manifest when apply is called with a mock compiler', () => {
    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    const plugin = new SqlChatbotManifestPlugin({ rootDir: tmpDir, output: outputPath });
    const tapFn: Function[] = [];
    const mockCompiler = {
      hooks: {
        beforeCompile: { tapAsync: (_name: string, fn: Function) => tapFn.push(fn) },
        watchRun: { tapAsync: (_name: string, _fn: Function) => {} },
      },
      context: tmpDir,
    };
    plugin.apply(mockCompiler as any);
    tapFn[0]({}, () => {});
    expect(fs.existsSync(outputPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.routes.some((r: any) => r.path === '/dashboard')).toBe(true);
  });
});
