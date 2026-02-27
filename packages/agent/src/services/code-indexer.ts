import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
}

export interface SearchResult {
  file: string;
  content: string;
  matchCount: number;
}

interface IndexedFile {
  relativePath: string;
  content: string;
}

interface CodeIndexerOptions {
  maxFiles?: number;
}

const SUPPORTED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.rb', '.py', '.erb', '.vue']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'tmp', '__pycache__', '.next']);
const DEFAULT_MAX_FILES = 2000;

export class CodeIndexer {
  private files: IndexedFile[] = [];
  private routes: RouteInfo[] = [];
  private maxFiles: number;

  constructor(options?: CodeIndexerOptions) {
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  }

  async index(codePaths: string[]): Promise<void> {
    this.files = [];
    this.routes = [];

    for (const codePath of codePaths) {
      if (this.files.length >= this.maxFiles) break;
      await this.scanDirectory(codePath, codePath);
    }

    if (this.files.length >= this.maxFiles) {
      // Trim to exactly maxFiles
      this.files = this.files.slice(0, this.maxFiles);
      console.warn(
        `CodeIndexer: file cap reached (${this.maxFiles}). Some files were not indexed.`
      );
    }

    this.detectRoutes(codePaths);
  }

  getRoutes(): RouteInfo[] {
    return [...this.routes];
  }

  search(terms: string[]): SearchResult[] {
    const lowerTerms = terms.map(t => t.toLowerCase());
    const results: SearchResult[] = [];

    for (const file of this.files) {
      const lowerContent = file.content.toLowerCase();
      const matchCount = lowerTerms.filter(term => lowerContent.includes(term)).length;

      if (matchCount === 0) continue;

      const lines = file.content.split('\n');
      const matchedLineIndices = new Set<number>();

      for (const term of lowerTerms) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(term)) {
            matchedLineIndices.add(i);
          }
        }
      }

      // Build snippet with context (+-10 lines around each match, max ~50 lines)
      const includeLines = new Set<number>();
      for (const idx of matchedLineIndices) {
        const start = Math.max(0, idx - 10);
        const end = Math.min(lines.length - 1, idx + 10);
        for (let i = start; i <= end; i++) {
          includeLines.add(i);
        }
      }

      const sortedLines = [...includeLines].sort((a, b) => a - b).slice(0, 50);
      const snippet = sortedLines.map(i => lines[i]).join('\n');

      results.push({
        file: file.relativePath,
        content: snippet,
        matchCount,
      });
    }

    // Sort by matchCount descending, take top 10
    results.sort((a, b) => b.matchCount - a.matchCount);
    return results.slice(0, 10);
  }

  fileCount(): number {
    return this.files.length;
  }

  getRouteSummary(): string {
    if (this.routes.length === 0) {
      return 'No routes detected.';
    }

    const lines = this.routes.map(
      r => `${r.method} ${r.path} \u2192 ${r.file}`
    );
    return 'Routes detected:\n' + lines.join('\n');
  }

  // --- Private methods ---

  private async scanDirectory(dir: string, basePath: string): Promise<void> {
    if (this.files.length >= this.maxFiles) return;

    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    for (const entry of entries) {
      if (this.files.length >= this.maxFiles) return;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await this.scanDirectory(path.join(dir, entry.name), basePath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          this.files.push({ relativePath, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  private detectRoutes(codePaths: string[]): void {
    for (const file of this.files) {
      this.detectExpressRoutes(file);
      this.detectReactRouterRoutes(file);
      this.detectRailsRoutes(file);
    }

    // Detect Next.js file-based routes
    this.detectNextJsRoutes(codePaths);
  }

  private detectExpressRoutes(file: IndexedFile): void {
    // Match: app.get('/path', ...) or router.post('/path', ...)
    const pattern = /(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(file.content)) !== null) {
      this.routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: file.relativePath,
      });
    }
  }

  private detectReactRouterRoutes(file: IndexedFile): void {
    // Match: <Route ... path="/something" ... /> — path can appear anywhere in the tag
    // Line-oriented to avoid cross-tag matching issues
    const pattern = /<Route\b.*?path=["']([^"']+)["']/gim;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(file.content)) !== null) {
      this.routes.push({
        method: 'GET',
        path: match[1],
        file: file.relativePath,
      });
    }

    // Match: path: '/something' in route config objects
    const configPattern = /path:\s*['"`]([^'"`]+)['"`]/gi;
    // Only match if file also contains route-related imports
    if (/useRoutes|createBrowserRouter|createRoutesFromElements/i.test(file.content)) {
      while ((match = configPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: 'GET',
          path: match[1],
          file: file.relativePath,
        });
      }
    }
  }

  private detectNextJsRoutes(codePaths: string[]): void {
    for (const file of this.files) {
      const parts = file.relativePath.split(path.sep);

      // Try pages/ router (Next.js 12 and earlier)
      const pagesIdx = parts.indexOf('pages');
      if (pagesIdx !== -1) {
        this.detectNextJsPagesRoute(file, parts, pagesIdx);
        continue;
      }

      // Try app/ router (Next.js 13+)
      const appIdx = parts.indexOf('app');
      if (appIdx !== -1) {
        this.detectNextJsAppRoute(file, parts, appIdx);
      }
    }
  }

  private detectNextJsPagesRoute(file: IndexedFile, parts: string[], pagesIdx: number): void {
    const routeParts = parts.slice(pagesIdx + 1);
    const fileName = routeParts[routeParts.length - 1];

    // Skip _app, _document, _error files
    if (fileName.startsWith('_')) return;

    const baseName = fileName.replace(/\.[^.]+$/, '');
    const dirParts = routeParts.slice(0, -1);
    const allParts = baseName === 'index' ? dirParts : [...dirParts, baseName];

    const routePath = '/' + this.convertNextJsDynamicSegments(allParts).join('/');

    this.routes.push({
      method: 'GET',
      path: routePath,
      file: file.relativePath,
    });
  }

  private detectNextJsAppRoute(file: IndexedFile, parts: string[], appIdx: number): void {
    const fileName = parts[parts.length - 1];
    const baseName = fileName.replace(/\.[^.]+$/, '');

    // In app/ router, only page files define routes
    if (baseName !== 'page') return;

    // Route comes from directory path (exclude the page.tsx filename)
    const routeParts = parts.slice(appIdx + 1, -1);

    // Skip route groups (directories starting with parentheses like (auth))
    const filteredParts = routeParts.filter(p => !p.startsWith('('));

    const routePath = '/' + this.convertNextJsDynamicSegments(filteredParts).join('/');

    this.routes.push({
      method: 'GET',
      path: routePath,
      file: file.relativePath,
    });
  }

  private convertNextJsDynamicSegments(parts: string[]): string[] {
    return parts.map(part => {
      // [...slug] -> :slug*
      if (part.startsWith('[...') && part.endsWith(']')) {
        return ':' + part.slice(4, -1) + '*';
      }
      // [id] -> :id
      if (part.startsWith('[') && part.endsWith(']')) {
        return ':' + part.slice(1, -1);
      }
      return part;
    });
  }

  private detectRailsRoutes(file: IndexedFile): void {
    if (!file.relativePath.endsWith('routes.rb')) return;

    const content = file.content;

    // root 'controller#action'
    if (/root\s+['"]/.test(content)) {
      this.routes.push({
        method: 'GET',
        path: '/',
        file: file.relativePath,
      });
    }

    // resources :name
    const resourcesPattern = /resources\s+:(\w+)/gi;
    let match: RegExpExecArray | null;
    while ((match = resourcesPattern.exec(content)) !== null) {
      this.routes.push({
        method: 'GET',
        path: '/' + match[1],
        file: file.relativePath,
      });
    }

    // get '/path', to: 'controller#action'
    const getPattern = /get\s+['"]([^'"]+)['"]/gi;
    while ((match = getPattern.exec(content)) !== null) {
      this.routes.push({
        method: 'GET',
        path: match[1],
        file: file.relativePath,
      });
    }

    // post '/path', to: 'controller#action'
    const postPattern = /post\s+['"]([^'"]+)['"]/gi;
    while ((match = postPattern.exec(content)) !== null) {
      this.routes.push({
        method: 'POST',
        path: match[1],
        file: file.relativePath,
      });
    }

    // put '/path', to: 'controller#action'
    const putPattern = /put\s+['"]([^'"]+)['"]/gi;
    while ((match = putPattern.exec(content)) !== null) {
      this.routes.push({
        method: 'PUT',
        path: match[1],
        file: file.relativePath,
      });
    }

    // delete '/path', to: 'controller#action'
    const deletePattern = /delete\s+['"]([^'"]+)['"]/gi;
    while ((match = deletePattern.exec(content)) !== null) {
      this.routes.push({
        method: 'DELETE',
        path: match[1],
        file: file.relativePath,
      });
    }
  }
}
