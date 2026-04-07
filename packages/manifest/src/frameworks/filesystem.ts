import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function humanize(name: string): string {
  // Remove dynamic brackets: [id] → id
  const clean = name.replace(/^\[\.\.\./, '').replace(/^\[/, '').replace(/\]$/, '');
  // Capitalize first letter, replace hyphens/underscores with spaces
  return clean.charAt(0).toUpperCase() + clean.slice(1).replace(/[-_]/g, ' ');
}

function segmentToParam(segment: string): string {
  // [...slug] → :slug*
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `:${catchAll[1]}*`;
  // [id] → :id
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function deriveLabel(filePath: string): string {
  const segments = filePath.split(path.sep);
  // Use the last meaningful directory name or file name
  const relevant = segments[segments.length - 1] || segments[segments.length - 2] || 'Page';
  return humanize(relevant);
}

function deriveParent(routePath: string): string | undefined {
  if (routePath === '/') return undefined;
  const parts = routePath.split('/').filter(Boolean);
  if (parts.length <= 1) return undefined;
  return '/' + parts.slice(0, -1).join('/');
}

function isRouteGroup(segment: string): boolean {
  return /^\(.*\)$/.test(segment);
}

// ── Next.js App Router ────────────────────────────────────────────────────────

const NEXT_APP_PAGE_FILES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js']);

export function scanNextAppRoutes(appDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  function walk(dir: string, segments: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const seg = entry.name;
        // Filter out route groups (parentheses folders) from the URL path
        if (isRouteGroup(seg)) {
          walk(path.join(dir, seg), segments);
        } else {
          walk(path.join(dir, seg), [...segments, segmentToParam(seg)]);
        }
      } else if (entry.isFile() && NEXT_APP_PAGE_FILES.has(entry.name)) {
        const routePath = segments.length === 0 ? '/' : '/' + segments.join('/');
        const labelSegment = segments[segments.length - 1] ?? 'Home';
        const label = labelSegment === '/' ? 'Home' : humanize(
          // Strip param prefix for label derivation
          labelSegment.replace(/^:/, '').replace(/\*$/, '')
        );
        routes.push({
          path: routePath,
          method: 'GET',
          label,
          component: path.relative(appDir, path.join(dir, entry.name)),
          parentPath: deriveParent(routePath),
        });
      }
    }
  }

  walk(appDir, []);
  return routes;
}

// ── Next.js Pages Router ──────────────────────────────────────────────────────

const NEXT_PAGES_SKIP = new Set(['_app', '_document', '_error', '404', '500']);
const NEXT_PAGES_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export function scanNextPagesRoutes(pagesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  function walk(dir: string, segments: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, segmentToParam(entry.name)]);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!NEXT_PAGES_EXTS.has(ext)) continue;
        const base = path.basename(entry.name, ext);
        if (NEXT_PAGES_SKIP.has(base)) continue;

        let routePath: string;
        let label: string;

        if (base === 'index') {
          routePath = segments.length === 0 ? '/' : '/' + segments.join('/');
          const lastSeg = segments[segments.length - 1];
          label = lastSeg ? humanize(lastSeg.replace(/^:/, '').replace(/\*$/, '')) : 'Home';
        } else {
          const paramSeg = segmentToParam(base);
          const allSegs = [...segments, paramSeg];
          routePath = '/' + allSegs.join('/');
          label = humanize(base.replace(/^\[/, '').replace(/\]$/, ''));
        }

        routes.push({
          path: routePath,
          method: 'GET',
          label,
          component: path.relative(pagesDir, path.join(dir, entry.name)),
          parentPath: deriveParent(routePath),
        });
      }
    }
  }

  walk(pagesDir, []);
  return routes;
}

// ── Nuxt ──────────────────────────────────────────────────────────────────────

export function scanNuxtRoutes(pagesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  function walk(dir: string, segments: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, segmentToParam(entry.name)]);
      } else if (entry.isFile() && entry.name.endsWith('.vue')) {
        const base = path.basename(entry.name, '.vue');

        let routePath: string;
        let label: string;

        if (base === 'index') {
          routePath = segments.length === 0 ? '/' : '/' + segments.join('/');
          const lastSeg = segments[segments.length - 1];
          label = lastSeg ? humanize(lastSeg.replace(/^:/, '').replace(/\*$/, '')) : 'Home';
        } else {
          const paramSeg = segmentToParam(base);
          const allSegs = [...segments, paramSeg];
          routePath = '/' + allSegs.join('/');
          label = humanize(base.replace(/^\[/, '').replace(/\]$/, ''));
        }

        routes.push({
          path: routePath,
          method: 'GET',
          label,
          component: path.relative(pagesDir, path.join(dir, entry.name)),
          parentPath: deriveParent(routePath),
        });
      }
    }
  }

  walk(pagesDir, []);
  return routes;
}

// ── SvelteKit ─────────────────────────────────────────────────────────────────

export function scanSvelteKitRoutes(routesDir: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  function walk(dir: string, segments: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const seg = entry.name;
        // Filter out route groups (parentheses folders) from URL path
        if (isRouteGroup(seg)) {
          walk(path.join(dir, seg), segments);
        } else {
          walk(path.join(dir, seg), [...segments, segmentToParam(seg)]);
        }
      } else if (entry.isFile() && entry.name === '+page.svelte') {
        const routePath = segments.length === 0 ? '/' : '/' + segments.join('/');
        const lastSeg = segments[segments.length - 1];
        const label = lastSeg
          ? humanize(lastSeg.replace(/^:/, '').replace(/\*$/, ''))
          : 'Home';

        routes.push({
          path: routePath,
          method: 'GET',
          label,
          component: path.relative(routesDir, path.join(dir, entry.name)),
          parentPath: deriveParent(routePath),
        });
      }
    }
  }

  walk(routesDir, []);
  return routes;
}
