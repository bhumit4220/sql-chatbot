import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanVueRouterRoutes } from '../frameworks/vue-router.js';

describe('scanVueRouterRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-router-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects routes from router config file', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'router'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router', 'index.ts'), `
      import { createRouter, createWebHistory } from 'vue-router';
      const routes = [
        { path: '/', component: () => import('../views/Home.vue') },
        { path: '/about', component: () => import('../views/About.vue') },
        { path: '/users/:id', component: () => import('../views/UserDetail.vue') },
      ];
      export default createRouter({ history: createWebHistory(), routes });
    `);
    const routes = scanVueRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });

  it('detects nested children routes', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'router'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router', 'index.ts'), `
      import { createRouter } from 'vue-router';
      const routes = [
        {
          path: '/admin',
          children: [
            { path: 'users', component: () => import('../views/Users.vue') },
            { path: 'settings', component: () => import('../views/Settings.vue') },
          ],
        },
      ];
    `);
    const routes = scanVueRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users', parentPath: '/admin' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings', parentPath: '/admin' }));
  });
});
