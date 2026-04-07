import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanReactRouterRoutes } from '../frameworks/react-router.js';

describe('scanReactRouterRoutes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-router-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0' }
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects JSX <Route path="..."> elements', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
          </Routes>
        );
      }
    `);
    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users', label: 'Users' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/users/:id' }));
  });

  it('detects createBrowserRouter route configs', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'router.tsx'), `
      import { createBrowserRouter } from 'react-router-dom';
      export const router = createBrowserRouter([
        { path: '/', element: <Home /> },
        { path: '/dashboard', element: <Dashboard /> },
        {
          path: '/admin',
          children: [
            { path: 'users', element: <Users /> },
            { path: 'settings', element: <Settings /> },
          ],
        },
      ]);
    `);
    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/dashboard' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users', parentPath: '/admin' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings', parentPath: '/admin' }));
  });

  it('handles nested Route elements', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), `
      import { Route, Routes } from 'react-router-dom';
      export default function App() {
        return (
          <Routes>
            <Route path="/admin">
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        );
      }
    `);
    const routes = scanReactRouterRoutes(tmpDir);
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/admin/settings' }));
  });
});
