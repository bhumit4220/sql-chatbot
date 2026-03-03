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

const SUPPORTED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.rb', '.py', '.erb', '.vue', '.php', '.java', '.go', '.cs', '.ex', '.exs', '.svelte', '.kt', '.rs', '.dart', '.scala']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'tmp', '__pycache__', '.next', '.svelte-kit', '.nuxt', 'target', 'bin', 'obj', 'deps', '_build']);
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

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
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
      this.detectMethodCallRoutes(file);
      this.detectReactRouterRoutes(file);
      this.detectRailsRoutes(file);
      this.detectConfigRoutes(file);
      this.detectDecoratorRoutes(file);
      this.detectSinatraRoutes(file);
    }

    // Detect file-based routes (Next.js, SvelteKit, Nuxt)
    this.detectNextJsRoutes(codePaths);
    this.detectSvelteKitRoutes();
    this.detectNuxtRoutes();
  }

  private detectMethodCallRoutes(file: IndexedFile): void {
    const ext = path.extname(file.relativePath);
    let match: RegExpExecArray | null;

    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
      // Express, Fastify, Hono, Koa: app.get('/path', ...), router.post('/path', ...), server.get('/path', ...), fastify.get('/path', ...)
      const pattern = /(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
      while ((match = pattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
    } else if (ext === '.go') {
      // Gin, Echo, Fiber: r.GET("/path", ...), e.POST("/path", ...), app.Get("/path", ...)
      const pattern = /\w+\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/gi;
      while ((match = pattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
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

  private detectSvelteKitRoutes(): void {
    for (const file of this.files) {
      const parts = file.relativePath.split(path.sep);

      // SvelteKit uses src/routes/ directory
      const routesIdx = parts.indexOf('routes');
      if (routesIdx === -1) continue;
      // Verify it's under src/
      if (routesIdx === 0 || parts[routesIdx - 1] !== 'src') continue;

      const fileName = parts[parts.length - 1];
      // Only +page.svelte and +server.ts/js define routes
      if (!fileName.startsWith('+page.') && !fileName.startsWith('+server.')) continue;

      const routeParts = parts.slice(routesIdx + 1, -1);
      // Skip route groups (directories starting with parentheses)
      const filteredParts = routeParts.filter(p => !p.startsWith('('));
      const routePath = '/' + this.convertNextJsDynamicSegments(filteredParts).join('/');

      const method = fileName.startsWith('+server.') ? 'ALL' : 'GET';

      this.routes.push({
        method,
        path: routePath,
        file: file.relativePath,
      });
    }
  }

  private detectNuxtRoutes(): void {
    for (const file of this.files) {
      const ext = path.extname(file.relativePath);
      if (ext !== '.vue') continue;

      const parts = file.relativePath.split(path.sep);
      const pagesIdx = parts.indexOf('pages');
      if (pagesIdx === -1) continue;

      const routeParts = parts.slice(pagesIdx + 1);
      const fileName = routeParts[routeParts.length - 1];
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const dirParts = routeParts.slice(0, -1);
      const allParts = baseName === 'index' ? dirParts : [...dirParts, baseName];

      // Convert dynamic segments: [id] (Nuxt 3) and _id (Nuxt 2)
      const converted = allParts.map(part => {
        // Nuxt 3: [...slug] -> :slug*
        if (part.startsWith('[...') && part.endsWith(']')) {
          return ':' + part.slice(4, -1) + '*';
        }
        // Nuxt 3: [id] -> :id
        if (part.startsWith('[') && part.endsWith(']')) {
          return ':' + part.slice(1, -1);
        }
        // Nuxt 2: _id -> :id
        if (part.startsWith('_')) {
          return ':' + part.slice(1);
        }
        return part;
      });

      const routePath = '/' + converted.join('/');

      this.routes.push({
        method: 'GET',
        path: routePath,
        file: file.relativePath,
      });
    }
  }

  private detectConfigRoutes(file: IndexedFile): void {
    const ext = path.extname(file.relativePath);
    const fileName = path.basename(file.relativePath);
    let match: RegExpExecArray | null;

    // Django: urls.py files with path(), re_path(), url()
    if (fileName === 'urls.py' || (ext === '.py' && file.content.includes('urlpatterns'))) {
      const pattern = /(?:path|re_path|url)\(\s*['"]([^'"]*)['"]/gi;
      while ((match = pattern.exec(file.content)) !== null) {
        this.routes.push({
          method: 'ALL',
          path: '/' + match[1].replace(/^\^/, '').replace(/\$$/, ''),
          file: file.relativePath,
        });
      }
    }

    // Laravel: Route::get('/path', ...), Route::resource('name', ...)
    if (ext === '.php') {
      const methodPattern = /Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi;
      while ((match = methodPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
      const resourcePattern = /Route::resource\(\s*['"]([^'"]+)['"]/gi;
      while ((match = resourcePattern.exec(file.content)) !== null) {
        this.routes.push({
          method: 'GET',
          path: '/' + match[1],
          file: file.relativePath,
        });
      }
    }

    // ASP.NET minimal APIs: app.MapGet("/path", ...), app.MapPost("/path", ...)
    if (ext === '.cs') {
      const mapPattern = /app\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/gi;
      while ((match = mapPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }

      // ASP.NET attribute routing: [HttpGet("path")], [Route("path")]
      const attrPattern = /\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"\s*\)\]/gi;
      while ((match = attrPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
      const routeAttrPattern = /\[Route\(\s*"([^"]+)"\s*\)\]/gi;
      while ((match = routeAttrPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: 'ALL',
          path: match[1],
          file: file.relativePath,
        });
      }
    }

    // Phoenix: get "/path", Controller, :action
    if (fileName === 'router.ex' || (ext === '.ex' && file.content.includes('Phoenix.Router'))) {
      const phoenixPattern = /(get|post|put|patch|delete)\s+"([^"]+)"/gi;
      while ((match = phoenixPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
    }
  }

  private detectDecoratorRoutes(file: IndexedFile): void {
    const ext = path.extname(file.relativePath);
    let match: RegExpExecArray | null;

    // NestJS: @Controller('prefix') + @Get('subpath')
    if (['.ts', '.js'].includes(ext)) {
      const controllerMatch = /@Controller\(\s*['"]([^'"]*)['"]\s*\)/.exec(file.content);
      if (controllerMatch) {
        const prefix = controllerMatch[1];
        const methodPattern = /@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]\s*\)/gi;
        while ((match = methodPattern.exec(file.content)) !== null) {
          const subpath = match[2];
          const fullPath = '/' + [prefix, subpath].filter(Boolean).join('/');
          this.routes.push({
            method: match[1].toUpperCase(),
            path: fullPath,
            file: file.relativePath,
          });
        }
        // Also match decorators with no path argument: @Get()
        const noArgPattern = /@(Get|Post|Put|Patch|Delete)\(\s*\)/gi;
        while ((match = noArgPattern.exec(file.content)) !== null) {
          this.routes.push({
            method: match[1].toUpperCase(),
            path: '/' + prefix,
            file: file.relativePath,
          });
        }
      }
    }

    // FastAPI: @app.get("/path") / @router.post("/path")
    if (ext === '.py' && !file.content.includes('urlpatterns')) {
      const fastapiPattern = /@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi;
      while ((match = fastapiPattern.exec(file.content)) !== null) {
        this.routes.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }
    }

    // Flask: @app.route('/path', methods=['GET', 'POST'])
    if (ext === '.py') {
      const flaskPattern = /@app\.route\(\s*['"]([^'"]+)['"](?:,\s*methods=\[([^\]]+)\])?\s*\)/gi;
      while ((match = flaskPattern.exec(file.content)) !== null) {
        const routePath = match[1];
        if (match[2]) {
          // Parse methods list: ['GET', 'POST']
          const methods = match[2].replace(/['"]/g, '').split(/\s*,\s*/);
          for (const method of methods) {
            this.routes.push({
              method: method.trim().toUpperCase(),
              path: routePath,
              file: file.relativePath,
            });
          }
        } else {
          this.routes.push({
            method: 'GET',
            path: routePath,
            file: file.relativePath,
          });
        }
      }
    }

    // Spring Boot: @GetMapping("/path") + class-level @RequestMapping("/prefix")
    if (ext === '.java') {
      const requestMappingMatch = /@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/.exec(file.content);
      const prefix = requestMappingMatch ? requestMappingMatch[1] : '';

      const mappingPattern = /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi;
      while ((match = mappingPattern.exec(file.content)) !== null) {
        const subpath = match[2];
        const fullPath = prefix ? prefix + subpath : subpath;
        this.routes.push({
          method: match[1].toUpperCase(),
          path: fullPath,
          file: file.relativePath,
        });
      }
    }
  }

  private detectSinatraRoutes(file: IndexedFile): void {
    if (!file.relativePath.endsWith('.rb')) return;
    // Exclude Rails routes.rb files (handled by detectRailsRoutes)
    if (file.relativePath.endsWith('routes.rb')) return;

    const pattern = /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s+do/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      this.routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: file.relativePath,
      });
    }
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
