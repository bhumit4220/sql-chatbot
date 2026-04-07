import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectedFramework, Manifest, ManifestRoute, PluginOptions } from './types.js';
import { scanNextAppRoutes, scanNextPagesRoutes, scanNuxtRoutes, scanSvelteKitRoutes } from './frameworks/filesystem.js';
import { scanReactRouterRoutes } from './frameworks/react-router.js';
import { scanVueRouterRoutes } from './frameworks/vue-router.js';
import { indexFiles } from './file-indexer.js';

export function detectFramework(rootDir: string): DetectedFramework {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'unknown';

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return 'unknown';
  }

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };

  if (allDeps['next']) {
    const hasAppDir =
      fs.existsSync(path.join(rootDir, 'app')) ||
      fs.existsSync(path.join(rootDir, 'src', 'app'));
    if (hasAppDir) return 'next-app';
    return 'next-pages';
  }

  if (allDeps['nuxt']) return 'nuxt';
  if (allDeps['@sveltejs/kit']) return 'sveltekit';
  if (allDeps['vue-router']) return 'vue-router';
  if (allDeps['react-router-dom'] || allDeps['react-router']) return 'react-router';

  return 'unknown';
}

export function scanRoutes(rootDir: string, framework: DetectedFramework): ManifestRoute[] {
  switch (framework) {
    case 'next-app': {
      const appDir = fs.existsSync(path.join(rootDir, 'app'))
        ? path.join(rootDir, 'app')
        : path.join(rootDir, 'src', 'app');
      const routes = scanNextAppRoutes(appDir);
      const pagesDir = fs.existsSync(path.join(rootDir, 'pages'))
        ? path.join(rootDir, 'pages')
        : fs.existsSync(path.join(rootDir, 'src', 'pages'))
          ? path.join(rootDir, 'src', 'pages')
          : null;
      if (pagesDir) {
        const pageRoutes = scanNextPagesRoutes(pagesDir);
        const seen = new Set(routes.map(r => r.path));
        for (const r of pageRoutes) {
          if (!seen.has(r.path)) routes.push(r);
        }
      }
      return routes;
    }
    case 'next-pages': {
      const pagesDir = fs.existsSync(path.join(rootDir, 'pages'))
        ? path.join(rootDir, 'pages')
        : path.join(rootDir, 'src', 'pages');
      return scanNextPagesRoutes(pagesDir);
    }
    case 'nuxt':
      return scanNuxtRoutes(path.join(rootDir, 'pages'));
    case 'sveltekit':
      return scanSvelteKitRoutes(path.join(rootDir, 'src', 'routes'));
    case 'react-router':
      return scanReactRouterRoutes(rootDir);
    case 'vue-router':
      return scanVueRouterRoutes(rootDir);
    default:
      return [];
  }
}

export function buildManifest(rootDir: string, options?: PluginOptions): Manifest {
  const framework = options?.framework ?? detectFramework(rootDir);
  const routes = scanRoutes(rootDir, framework);
  const files = indexFiles(rootDir, { maxFiles: 2000, exclude: options?.exclude });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    framework: framework ?? 'unknown',
    routes,
    files,
  };
}
