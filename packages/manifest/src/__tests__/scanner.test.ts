import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectFramework } from '../scanner.js';

describe('detectFramework', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects react-router from react-router-dom in dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'react-router-dom': '^6.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('react-router');
  });

  it('detects react-router from react-router dep', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'react-router': '^6.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('react-router');
  });

  it('detects next-app when next dep + app/ dir exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'next': '^14.0.0' } }),
    );
    fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
    expect(detectFramework(tmpDir)).toBe('next-app');
  });

  it('detects next-app when next dep + src/app/ dir exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'next': '^14.0.0' } }),
    );
    fs.mkdirSync(path.join(tmpDir, 'src', 'app'), { recursive: true });
    expect(detectFramework(tmpDir)).toBe('next-app');
  });

  it('detects next-pages when next dep + no app/ dir', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'next': '^14.0.0' } }),
    );
    fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true });
    expect(detectFramework(tmpDir)).toBe('next-pages');
  });

  it('detects vue-router from vue-router dep', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'vue-router': '^4.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('vue-router');
  });

  it('detects nuxt from nuxt dep', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'nuxt': '^3.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('nuxt');
  });

  it('detects sveltekit from @sveltejs/kit in devDependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('sveltekit');
  });

  it('returns unknown when no known framework dep found', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { 'express': '^4.0.0' } }),
    );
    expect(detectFramework(tmpDir)).toBe('unknown');
  });

  it('returns unknown when no package.json exists', () => {
    expect(detectFramework(tmpDir)).toBe('unknown');
  });
});
