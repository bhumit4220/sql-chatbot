import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sqlChatbotManifest } from '../vite-plugin.js';

describe('sqlChatbotManifest vite plugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-plugin-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return <Routes><Route path="/users" element={<div />} /></Routes>;
      }
    `);
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a valid Vite plugin object', () => {
    const plugin = sqlChatbotManifest();
    expect(plugin.name).toBe('sql-chatbot-manifest');
    expect(typeof plugin.buildStart).toBe('function');
  });

  it('generates manifest on buildStart', () => {
    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    const plugin = sqlChatbotManifest({ output: outputPath });
    (plugin.buildStart as Function).call({ meta: { watchMode: false } });
    expect(fs.existsSync(outputPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.routes).toBeDefined();
    expect(manifest.files).toBeDefined();
  });

  it('uses configResolved to determine root directory', () => {
    const plugin = sqlChatbotManifest();
    (plugin.configResolved as Function)({ root: tmpDir });
    const outputPath = path.join(tmpDir, 'public', 'chatbot-manifest.json');
    (plugin.buildStart as Function).call({ meta: { watchMode: false } });
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});
