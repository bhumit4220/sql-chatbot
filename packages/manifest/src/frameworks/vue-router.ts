import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestRoute } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  // Strip leading colon for params (:id → id)
  const clean = name.replace(/^:/, '').replace(/\*$/, '');
  // Capitalize first letter, split on hyphens/underscores
  return clean.charAt(0).toUpperCase() + clean.slice(1).replace(/[-_]/g, ' ');
}

function deriveLabel(routePath: string): string {
  if (routePath === '/') return 'Home';
  const segments = routePath.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? 'Page';
  // Convert :id → "Id", /users/:id → "User Detail" heuristic
  if (last.startsWith(':')) {
    const parent = segments[segments.length - 2];
    if (parent) {
      // Singularize naive: "users" → "User"
      const singular = parent.endsWith('s') ? parent.slice(0, -1) : parent;
      return humanize(singular) + ' Detail';
    }
    return humanize(last);
  }
  return humanize(last);
}

function deriveParent(routePath: string): string | undefined {
  if (routePath === '/') return undefined;
  const parts = routePath.split('/').filter(Boolean);
  if (parts.length <= 1) return undefined;
  return '/' + parts.slice(0, -1).join('/');
}

/**
 * Find the index of the matching closing bracket `]` starting from `start`
 * (which should point just after the opening `[`).
 */
function findClosingBracket(str: string, start: number): number {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── Directories to skip ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.nuxt', '.output']);

// ── File finder ───────────────────────────────────────────────────────────────

function findVueRouterFiles(rootDir: string): string[] {
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
      } else if (entry.isFile()) {
        const name = entry.name;
        if (name.endsWith('.ts') || name.endsWith('.js')) {
          const filePath = path.join(dir, name);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('createRouter') || content.includes('vue-router')) {
              results.push(filePath);
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

// ── Route extraction ──────────────────────────────────────────────────────────

interface RawRoute {
  path: string;
  parentPath?: string;
}

/**
 * Extract all `path: '...'` or `path: "..."` values from a JS/TS source string,
 * along with children nesting info.
 */
function extractRoutes(source: string): RawRoute[] {
  const routes: RawRoute[] = [];
  // path: '/foo'  or  path: "/foo"
  const pathRe = /\bpath\s*:\s*['"]([^'"]*)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = pathRe.exec(source)) !== null) {
    const routePath = match[1];
    const matchEnd = match.index + match[0].length;

    // Determine if this path entry is inside a `children: [...]` block.
    // We look backwards for `children` context by scanning for an enclosing
    // array that is itself a value of a `children:` key.
    const parentPath = resolveParentPath(source, match.index);

    const fullPath =
      parentPath !== undefined
        ? joinPaths(parentPath, routePath)
        : routePath;

    routes.push({ path: fullPath, parentPath: parentPath !== undefined ? parentPath : undefined });
    void matchEnd; // used above
  }

  return routes;
}

/**
 * Given the position of a `path:` token, look back through the source to find
 * the nearest enclosing `children: [` block and retrieve the parent route path.
 */
function resolveParentPath(source: string, pos: number): string | undefined {
  // Strategy: find the nearest `children` keyword before `pos` that opens a
  // bracket array still containing `pos`.
  const childrenRe = /\bchildren\s*:\s*\[/g;
  let best: { parentPath: string; depth: number } | undefined;

  let cm: RegExpExecArray | null;
  while ((cm = childrenRe.exec(source)) !== null) {
    const openBracket = cm.index + cm[0].length - 1; // index of `[`
    const closeBracket = findClosingBracket(source, openBracket + 1);
    if (closeBracket === -1) continue;

    // Is `pos` inside this children block?
    if (pos > openBracket && pos < closeBracket) {
      // Find the parent `path:` for this children block.
      // Look backwards from `cm.index` to find the enclosing object's `path:`.
      const segment = source.slice(0, cm.index);
      // Find the last `path:` before the children keyword in the same object
      const parentPathMatch = [...segment.matchAll(/\bpath\s*:\s*['"]([^'"]*)['"]/g)].pop();
      if (parentPathMatch) {
        const parentVal = parentPathMatch[1];
        // Track the "most specific" (innermost) match by bracket depth
        const depth = closeBracket - openBracket;
        if (!best || depth < best.depth) {
          best = { parentPath: parentVal, depth };
        }
      }
    }
  }

  return best?.parentPath;
}

function joinPaths(parent: string, child: string): string {
  if (child.startsWith('/')) return child; // absolute child path
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return base + '/' + child;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function scanVueRouterRoutes(rootDir: string): ManifestRoute[] {
  const files = findVueRouterFiles(rootDir);
  const seen = new Map<string, ManifestRoute>();

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rawRoutes = extractRoutes(source);
    for (const raw of rawRoutes) {
      if (seen.has(raw.path)) continue;
      seen.set(raw.path, {
        path: raw.path,
        method: 'GET',
        label: deriveLabel(raw.path),
        parentPath: raw.parentPath,
      });
    }
  }

  return Array.from(seen.values());
}
