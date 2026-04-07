import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanNextAppRoutes,
  scanNextPagesRoutes,
  scanNuxtRoutes,
  scanSvelteKitRoutes,
} from '../frameworks/filesystem.js';

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

describe('scanNextAppRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-next-app-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects root page', () => {
    touch(path.join(tmpDir, 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/');
    expect(routes[0].method).toBe('GET');
  });

  it('detects nested pages', () => {
    touch(path.join(tmpDir, 'page.tsx'));
    touch(path.join(tmpDir, 'dashboard', 'page.tsx'));
    touch(path.join(tmpDir, 'settings', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/settings');
  });

  it('converts [param] segments to :param', () => {
    touch(path.join(tmpDir, 'users', '[id]', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    expect(routes[0].path).toBe('/users/:id');
  });

  it('filters out route groups (parentheses folders) from URL', () => {
    touch(path.join(tmpDir, '(marketing)', 'about', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    expect(routes[0].path).toBe('/about');
    expect(routes[0].path).not.toContain('(marketing)');
  });

  it('sets parentPath for nested routes', () => {
    touch(path.join(tmpDir, 'dashboard', 'settings', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    const settingsRoute = routes.find(r => r.path === '/dashboard/settings');
    expect(settingsRoute?.parentPath).toBe('/dashboard');
  });

  it('sets label from directory name', () => {
    touch(path.join(tmpDir, 'dashboard', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    const route = routes.find(r => r.path === '/dashboard');
    expect(route?.label).toBe('Dashboard');
  });

  it('supports catch-all segments [...slug]', () => {
    touch(path.join(tmpDir, 'docs', '[...slug]', 'page.tsx'));
    const routes = scanNextAppRoutes(tmpDir);
    expect(routes[0].path).toBe('/docs/:slug*');
  });
});

describe('scanNextPagesRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-next-pages-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats index.tsx as root /', () => {
    touch(path.join(tmpDir, 'index.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes[0].path).toBe('/');
  });

  it('converts a regular file to its route', () => {
    touch(path.join(tmpDir, 'about.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes[0].path).toBe('/about');
  });

  it('skips _app and _document', () => {
    touch(path.join(tmpDir, '_app.tsx'));
    touch(path.join(tmpDir, '_document.tsx'));
    touch(path.join(tmpDir, 'index.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/');
  });

  it('skips _error, 404 and 500 pages', () => {
    touch(path.join(tmpDir, '_error.tsx'));
    touch(path.join(tmpDir, '404.tsx'));
    touch(path.join(tmpDir, '500.tsx'));
    touch(path.join(tmpDir, 'index.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes).toHaveLength(1);
  });

  it('converts [id] to :id', () => {
    touch(path.join(tmpDir, 'posts', '[id].tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes[0].path).toBe('/posts/:id');
  });

  it('sets parentPath for nested routes', () => {
    touch(path.join(tmpDir, 'users', 'profile.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    const route = routes.find(r => r.path === '/users/profile');
    expect(route?.parentPath).toBe('/users');
  });

  it('sets label from file/dir name', () => {
    touch(path.join(tmpDir, 'about.tsx'));
    const routes = scanNextPagesRoutes(tmpDir);
    expect(routes[0].label).toBe('About');
  });
});

describe('scanNuxtRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-nuxt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects .vue page files', () => {
    touch(path.join(tmpDir, 'index.vue'));
    const routes = scanNuxtRoutes(tmpDir);
    expect(routes[0].path).toBe('/');
  });

  it('converts [id] dynamic segments', () => {
    touch(path.join(tmpDir, 'users', '[id].vue'));
    const routes = scanNuxtRoutes(tmpDir);
    expect(routes[0].path).toBe('/users/:id');
  });

  it('handles nested pages', () => {
    touch(path.join(tmpDir, 'index.vue'));
    touch(path.join(tmpDir, 'about.vue'));
    touch(path.join(tmpDir, 'blog', 'index.vue'));
    const routes = scanNuxtRoutes(tmpDir);
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/about');
    expect(paths).toContain('/blog');
  });

  it('sets label from filename', () => {
    touch(path.join(tmpDir, 'contact.vue'));
    const routes = scanNuxtRoutes(tmpDir);
    expect(routes[0].label).toBe('Contact');
  });

  it('sets parentPath for nested routes', () => {
    touch(path.join(tmpDir, 'blog', 'post.vue'));
    const routes = scanNuxtRoutes(tmpDir);
    const route = routes.find(r => r.path === '/blog/post');
    expect(route?.parentPath).toBe('/blog');
  });
});

describe('scanSvelteKitRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sveltekit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects +page.svelte at root', () => {
    touch(path.join(tmpDir, '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    expect(routes[0].path).toBe('/');
    expect(routes[0].method).toBe('GET');
  });

  it('detects nested +page.svelte', () => {
    touch(path.join(tmpDir, '+page.svelte'));
    touch(path.join(tmpDir, 'about', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/about');
  });

  it('converts [param] segments to :param', () => {
    touch(path.join(tmpDir, 'users', '[id]', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    expect(routes[0].path).toBe('/users/:id');
  });

  it('filters out route groups (parentheses folders) from URL', () => {
    touch(path.join(tmpDir, '(app)', 'dashboard', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    expect(routes[0].path).toBe('/dashboard');
    expect(routes[0].path).not.toContain('(app)');
  });

  it('sets parentPath for nested routes', () => {
    touch(path.join(tmpDir, 'admin', 'settings', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    const route = routes.find(r => r.path === '/admin/settings');
    expect(route?.parentPath).toBe('/admin');
  });

  it('sets label from directory name', () => {
    touch(path.join(tmpDir, 'dashboard', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    expect(routes[0].label).toBe('Dashboard');
  });

  it('ignores non +page.svelte files', () => {
    touch(path.join(tmpDir, '+layout.svelte'));
    touch(path.join(tmpDir, '+server.ts'));
    touch(path.join(tmpDir, 'about', '+page.svelte'));
    const routes = scanSvelteKitRoutes(tmpDir);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/about');
  });
});
