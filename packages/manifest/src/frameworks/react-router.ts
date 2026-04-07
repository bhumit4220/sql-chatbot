import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const REACT_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js']);

/**
 * Derive a human label from a route path segment.
 * /users      → "Users"
 * /users/:id  → "User Detail"
 * /:id        → "Detail"
 */
function labelFromPath(routePath: string): string {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';

  const last = segments[segments.length - 1];

  // Dynamic param segment: :id → use penultimate + "Detail"
  if (last.startsWith(':')) {
    const penultimate = segments[segments.length - 2];
    if (penultimate) {
      // /users/:id → "User Detail" (singularize simple plurals)
      const base = penultimate.replace(/-/g, ' ');
      const singular = base.endsWith('s') ? base.slice(0, -1) : base;
      return capitalize(singular) + ' Detail';
    }
    return 'Detail';
  }

  return capitalize(last.replace(/-/g, ' ').replace(/_/g, ' '));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinPaths(parent: string, child: string): string {
  if (!child) return parent;
  if (child.startsWith('/')) return child;
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return base + '/' + child;
}

function deriveParent(routePath: string): string | undefined {
  if (routePath === '/') return undefined;
  const parts = routePath.split('/').filter(Boolean);
  if (parts.length <= 1) return undefined;
  return '/' + parts.slice(0, -1).join('/');
}

// ── File collection ───────────────────────────────────────────────────────────

function collectFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && REACT_EXTS.has(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir);
  return results;
}

function isReactRouterFile(content: string): boolean {
  return (
    /from ['"]react-router(?:-dom)?['"]/.test(content) ||
    /<Route\s/.test(content) ||
    /createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes/.test(content)
  );
}

// ── JSX <Route> parser ────────────────────────────────────────────────────────

/**
 * Extracts routes from JSX <Route path="..."> elements, handling nesting.
 *
 * Strategy: scan token-by-token for <Route, </Route>, and self-closing />.
 * Maintain a stack of parent paths to compute full paths for children.
 */
function extractJsxRoutes(content: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  // We need to track:
  // - Opening <Route path="..."> that is NOT self-closing (may have children)
  // - Self-closing <Route path="..." /> (no children)
  // - Closing </Route> tags (pop stack)

  // Match all Route-related tokens in order
  // Group 1: opening tag up to > or />  (we'll check for self-close separately)
  const tokenRe = /<Route\b([^>]*\/?)>|<\/Route>/g;

  const parentStack: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(content)) !== null) {
    const full = match[0];

    if (full === '</Route>') {
      // Pop parent stack
      if (parentStack.length > 0) parentStack.pop();
      continue;
    }

    // Opening or self-closing Route tag
    const attrs = match[1] ?? '';
    const pathMatch = attrs.match(/\bpath\s*=\s*["']([^"']+)["']/);
    if (!pathMatch) continue;

    const rawPath = pathMatch[1];
    const parentPath = parentStack.length > 0 ? parentStack[parentStack.length - 1] : undefined;
    const fullPath = parentPath !== undefined ? joinPaths(parentPath, rawPath) : (rawPath.startsWith('/') ? rawPath : '/' + rawPath);

    const isSelfClosing = attrs.trimEnd().endsWith('/');

    const route: ManifestRoute = {
      path: fullPath,
      method: 'GET',
      label: labelFromPath(fullPath),
      parentPath: parentPath ?? deriveParent(fullPath),
    };

    routes.push(route);

    if (!isSelfClosing) {
      // This tag may wrap children; push onto stack
      parentStack.push(fullPath);
    }
  }

  return routes;
}

// ── Config object parser ──────────────────────────────────────────────────────

/**
 * Extracts routes from createBrowserRouter/useRoutes config arrays.
 *
 * Strategy: find path: '...' entries, then look for children: [ ... ] blocks
 * using brace counting to find the extent of each children block.
 */
function extractConfigRoutes(content: string): ManifestRoute[] {
  const routes: ManifestRoute[] = [];

  /**
   * Recursively extract routes from a fragment of source text.
   * `parentPath` is the resolved path of the enclosing parent, if any.
   */
  function parseBlock(block: string, parentPath: string | undefined): void {
    // Find all path: '...' or path: "..." occurrences
    const pathRe = /\bpath\s*:\s*["']([^"']+)["']/g;
    let pm: RegExpExecArray | null;

    while ((pm = pathRe.exec(block)) !== null) {
      const rawPath = pm[1];
      const fullPath = parentPath !== undefined
        ? joinPaths(parentPath, rawPath)
        : (rawPath.startsWith('/') ? rawPath : '/' + rawPath);

      const route: ManifestRoute = {
        path: fullPath,
        method: 'GET',
        label: labelFromPath(fullPath),
        parentPath: parentPath ?? deriveParent(fullPath),
      };

      routes.push(route);

      // Look ahead from this path: ... for a children: [ ... ] block
      // within the same object (bounded by the next path: at same depth)
      const afterPath = block.slice(pm.index + pm[0].length);
      const childrenBlock = extractChildrenBlock(afterPath);
      if (childrenBlock !== null) {
        parseBlock(childrenBlock, fullPath);
      }
    }
  }

  /**
   * Given text AFTER a `path: '...'` occurrence, find a `children: [...]`
   * block that belongs to the same config object and return its content.
   * Returns null if none found before the next top-level path: entry.
   */
  function extractChildrenBlock(text: string): string | null {
    // Find children: [
    const childrenStart = text.search(/\bchildren\s*:\s*\[/);
    if (childrenStart === -1) return null;

    // Find the opening bracket
    const bracketIdx = text.indexOf('[', childrenStart);
    if (bracketIdx === -1) return null;

    // Balance brackets to find the closing ]
    let depth = 0;
    let end = -1;
    for (let i = bracketIdx; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) return null;
    return text.slice(bracketIdx + 1, end);
  }

  // Only process files that use createBrowserRouter/createHashRouter/createMemoryRouter/useRoutes
  if (!/createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes/.test(content)) {
    return routes;
  }

  parseBlock(content, undefined);
  return routes;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function dedupe(routes: ManifestRoute[]): ManifestRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function scanReactRouterRoutes(rootDir: string): ManifestRoute[] {
  const files = collectFiles(rootDir);
  const allRoutes: ManifestRoute[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (!isReactRouterFile(content)) continue;

    // Extract from JSX <Route> elements
    const jsxRoutes = extractJsxRoutes(content);

    // Extract from config objects (createBrowserRouter etc.)
    const configRoutes = extractConfigRoutes(content);

    allRoutes.push(...jsxRoutes, ...configRoutes);
  }

  return dedupe(allRoutes);
}
