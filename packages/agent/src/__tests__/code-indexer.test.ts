import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeIndexer } from '../services/code-indexer.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-indexer-test-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('CodeIndexer', () => {
  let tmpDirs: string[];
  let indexer: CodeIndexer;

  beforeEach(() => {
    tmpDirs = [];
    indexer = new CodeIndexer();
  });

  afterEach(() => {
    tmpDirs.forEach(cleanDir);
  });

  function createTmpDir(): string {
    const dir = makeTempDir();
    tmpDirs.push(dir);
    return dir;
  }

  it('indexes files from multiple codePaths', async () => {
    const dir1 = createTmpDir();
    const dir2 = createTmpDir();

    writeFile(dir1, 'src/app.ts', 'console.log("hello")');
    writeFile(dir1, 'src/utils.js', 'module.exports = {}');
    writeFile(dir2, 'lib/helper.ts', 'export function help() {}');

    await indexer.index([dir1, dir2]);

    expect(indexer.fileCount()).toBe(3);
  });

  it('skips node_modules, .git, dist, build directories', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/app.ts', 'good file');
    writeFile(dir, 'node_modules/pkg/index.js', 'skip me');
    writeFile(dir, '.git/config', 'skip me');
    writeFile(dir, 'dist/bundle.js', 'skip me');
    writeFile(dir, 'build/output.js', 'skip me');
    writeFile(dir, 'vendor/lib.rb', 'skip me');
    writeFile(dir, 'tmp/cache.js', 'skip me');
    writeFile(dir, '__pycache__/mod.py', 'skip me');
    writeFile(dir, '.next/server.js', 'skip me');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(1);
  });

  it('only reads supported file extensions', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app.ts', 'typescript');
    writeFile(dir, 'app.js', 'javascript');
    writeFile(dir, 'app.tsx', 'tsx');
    writeFile(dir, 'app.jsx', 'jsx');
    writeFile(dir, 'app.rb', 'ruby');
    writeFile(dir, 'app.py', 'python');
    writeFile(dir, 'app.erb', 'erb');
    writeFile(dir, 'app.vue', 'vue');
    writeFile(dir, 'app.css', 'skip css');
    writeFile(dir, 'app.html', 'skip html');
    writeFile(dir, 'app.json', 'skip json');
    writeFile(dir, 'app.md', 'skip markdown');
    writeFile(dir, 'app.txt', 'skip text');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(8);
  });

  it('detects Express routes (app.get, router.post, etc.)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes/users.js', `
const express = require('express');
const router = express.Router();

router.get('/users', (req, res) => {
  res.json([]);
});

router.post('/users', (req, res) => {
  res.json({});
});

app.get('/health', (req, res) => {
  res.send('ok');
});

app.delete('/users/:id', (req, res) => {
  res.sendStatus(204);
});

module.exports = router;
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/:id' }));
  });

  it('detects React Router routes (<Route path="..." />)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/App.tsx', `
import { Route, Routes } from 'react-router-dom';

function App() {
  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/users/:id" element={<UserDetail />} />
      <Route path='/settings' element={<Settings />} />
    </Routes>
  );
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/dashboard' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/settings' }));
  });

  it('detects Next.js file-based routes (pages/ directory structure)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'pages/index.tsx', 'export default function Home() {}');
    writeFile(dir, 'pages/about.tsx', 'export default function About() {}');
    writeFile(dir, 'pages/users/index.tsx', 'export default function Users() {}');
    writeFile(dir, 'pages/users/[id].tsx', 'export default function User() {}');
    writeFile(dir, 'pages/posts/[...slug].tsx', 'export default function Post() {}');
    writeFile(dir, 'pages/api/health.ts', 'export default function handler() {}');
    // _app and _document should be skipped
    writeFile(dir, 'pages/_app.tsx', 'export default function App() {}');
    writeFile(dir, 'pages/_document.tsx', 'export default function Doc() {}');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/posts/:slug*' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/health' }));

    // _app and _document should not produce routes
    const routePaths = routes.map(r => r.path);
    expect(routePaths).not.toContain('/_app');
    expect(routePaths).not.toContain('/_document');
  });

  it('detects Next.js app/ router routes (page.tsx files)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app/page.tsx', 'export default function Home() {}');
    writeFile(dir, 'app/about/page.tsx', 'export default function About() {}');
    writeFile(dir, 'app/users/[id]/page.tsx', 'export default function User() {}');
    writeFile(dir, 'app/(auth)/login/page.tsx', 'export default function Login() {}');
    // layout and loading should NOT produce routes
    writeFile(dir, 'app/layout.tsx', 'export default function Layout() {}');
    writeFile(dir, 'app/loading.tsx', 'export default function Loading() {}');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/login' }));

    // layout and loading should not produce routes
    const routePaths = routes.map(r => r.path);
    expect(routePaths).not.toContain('/layout');
    expect(routePaths).not.toContain('/loading');
  });

  it('detects Rails routes from routes.rb', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'home#index'
  resources :users
  get '/about', to: 'pages#about'
  post '/login', to: 'sessions#create'
  namespace :admin do
    resources :reports
  end
end
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/login' }));
  });

  it('search() returns matching files with snippets', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/models/user.ts', `
import { db } from '../db';

export class User {
  static async findById(id: number) {
    return db.query('SELECT * FROM users WHERE id = $1', [id]);
  }

  static async findByEmail(email: string) {
    return db.query('SELECT * FROM users WHERE email = $1', [email]);
  }
}
`);
    writeFile(dir, 'src/models/post.ts', 'export class Post {}');

    await indexer.index([dir]);
    const results = indexer.search(['findById', 'email']);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toContain('user.ts');
    expect(results[0].content).toContain('findById');
  });

  it('search() is case-insensitive', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/app.ts', 'function CreateUser() { return true; }');

    await indexer.index([dir]);
    const results = indexer.search(['createuser']);

    expect(results.length).toBe(1);
    expect(results[0].file).toContain('app.ts');
  });

  it('search() returns results ranked by match count', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/one-match.ts', 'function alpha() { return "hello"; }');
    writeFile(dir, 'src/two-matches.ts', 'function alpha() { return beta(); }');
    writeFile(dir, 'src/no-match.ts', 'function gamma() { return 42; }');

    await indexer.index([dir]);
    const results = indexer.search(['alpha', 'beta']);

    expect(results.length).toBe(2);
    // two-matches should come first (higher match count)
    expect(results[0].file).toContain('two-matches.ts');
    expect(results[0].matchCount).toBe(2);
    expect(results[1].file).toContain('one-match.ts');
    expect(results[1].matchCount).toBe(1);
  });

  it('getRouteSummary() returns formatted route text', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes/api.js', `
router.get('/api/users', handler);
router.post('/api/users', handler);
`);

    await indexer.index([dir]);
    const summary = indexer.getRouteSummary();

    expect(summary).toContain('Routes detected:');
    expect(summary).toMatch(/GET\s+\/api\/users/);
    expect(summary).toMatch(/POST\s+\/api\/users/);
    // Should include the file reference
    expect(summary).toContain('api.js');
  });

  it('fileCount() returns correct count', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'a.ts', 'a');
    writeFile(dir, 'b.ts', 'b');
    writeFile(dir, 'c.js', 'c');
    writeFile(dir, 'skip.css', 'skip');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(3);
  });

  it('caps at 2000 files and logs a warning', async () => {
    const dir = createTmpDir();

    // Write just a few files but mock the cap to a low number to test the warning
    writeFile(dir, 'a.ts', 'a');
    writeFile(dir, 'b.ts', 'b');
    writeFile(dir, 'c.ts', 'c');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create indexer with a low cap to test the warning behavior
    const cappedIndexer = new CodeIndexer({ maxFiles: 2 });
    await cappedIndexer.index([dir]);

    expect(cappedIndexer.fileCount()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('file cap reached')
    );

    warnSpy.mockRestore();
  });

  it('getRouteSummary() returns empty message when no routes detected', async () => {
    const dir = createTmpDir();
    writeFile(dir, 'src/utils.ts', 'export const add = (a: number, b: number) => a + b;');

    await indexer.index([dir]);
    const summary = indexer.getRouteSummary();

    expect(summary).toBe('No routes detected.');
  });

  // --- New framework tests ---

  it('indexes .php, .java, .go, .cs, .ex, .exs, .svelte files', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app.php', '<?php echo "hello"; ?>');
    writeFile(dir, 'App.java', 'class App {}');
    writeFile(dir, 'main.go', 'package main');
    writeFile(dir, 'Program.cs', 'class Program {}');
    writeFile(dir, 'router.ex', 'defmodule Router do end');
    writeFile(dir, 'helper.exs', 'IO.puts "hello"');
    writeFile(dir, 'Page.svelte', '<h1>Hello</h1>');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(7);
  });

  it('skips .svelte-kit, .nuxt, target, bin, obj, deps, _build directories', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/app.ts', 'good file');
    writeFile(dir, '.svelte-kit/output.js', 'skip');
    writeFile(dir, '.nuxt/app.js', 'skip');
    writeFile(dir, 'target/classes/App.java', 'skip');
    writeFile(dir, 'bin/Debug/App.cs', 'skip');
    writeFile(dir, 'obj/Debug/App.cs', 'skip');
    writeFile(dir, 'deps/phoenix/lib.ex', 'skip');
    writeFile(dir, '_build/dev/lib.ex', 'skip');

    await indexer.index([dir]);

    expect(indexer.fileCount()).toBe(1);
  });

  it('detects Fastify routes (server.get, fastify.post)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes.ts', `
server.get('/health', async (req, reply) => { return { ok: true }; });
fastify.post('/users', async (req, reply) => { return {}; });
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
  });

  it('detects Gin routes (r.GET, r.POST)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'main.go', `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    r.GET("/ping", func(c *gin.Context) {})
    r.POST("/users", func(c *gin.Context) {})
    r.DELETE("/users/:id", func(c *gin.Context) {})
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/ping' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/:id' }));
  });

  it('detects Echo routes (e.GET, e.Post)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'server.go', `
package main

func main() {
    e := echo.New()
    e.GET("/users", getUsers)
    e.Post("/users", createUser)
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
  });

  it('detects SvelteKit file-based routes (+page.svelte, +server.ts)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/routes/+page.svelte', '<h1>Home</h1>');
    writeFile(dir, 'src/routes/about/+page.svelte', '<h1>About</h1>');
    writeFile(dir, 'src/routes/users/[id]/+page.svelte', '<h1>User</h1>');
    writeFile(dir, 'src/routes/api/health/+server.ts', 'export function GET() {}');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'ALL', path: '/api/health' }));
  });

  it('detects Nuxt 3 file-based routes (pages/ with [id])', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'pages/index.vue', '<template><h1>Home</h1></template>');
    writeFile(dir, 'pages/about.vue', '<template><h1>About</h1></template>');
    writeFile(dir, 'pages/users/[id].vue', '<template><h1>User</h1></template>');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/about' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
  });

  it('detects Nuxt 2 file-based routes (pages/ with _id)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'pages/users/_id.vue', '<template><h1>User</h1></template>');
    writeFile(dir, 'pages/posts/_slug.vue', '<template><h1>Post</h1></template>');

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/posts/:slug' }));
  });

  it('detects Django routes (path, re_path, url)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'myapp/urls.py', `
from django.urls import path, re_path

urlpatterns = [
    path('', views.index),
    path('users/', views.users_list),
    path('users/<int:pk>/', views.user_detail),
    re_path('^articles/(?P<slug>[\\w-]+)/$', views.article),
]
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'ALL', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'ALL', path: '/users/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'ALL', path: '/users/<int:pk>/' }));
  });

  it('detects Laravel routes (Route::get, Route::resource)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'routes/web.php', `
<?php

Route::get('/dashboard', [DashboardController::class, 'index']);
Route::post('/login', [AuthController::class, 'login']);
Route::resource('photos', PhotoController::class);
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/dashboard' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/login' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/photos' }));
  });

  it('detects ASP.NET minimal API routes (app.MapGet, app.MapPost)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'Program.cs', `
var app = builder.Build();
app.MapGet("/weatherforecast", () => { });
app.MapPost("/users", (User user) => { });
app.MapDelete("/users/{id}", (int id) => { });
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/weatherforecast' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/{id}' }));
  });

  it('detects ASP.NET attribute routes ([HttpGet], [Route])', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'Controllers/UsersController.cs', `
[Route("api/users")]
public class UsersController : ControllerBase
{
    [HttpGet("{id}")]
    public ActionResult<User> Get(int id) { }

    [HttpPost("create")]
    public ActionResult Create(User user) { }
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'ALL', path: 'api/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '{id}' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: 'create' }));
  });

  it('detects Phoenix routes (get "/path", Controller, :action)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'lib/myapp_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/", MyAppWeb do
    get "/", PageController, :index
    post "/users", UserController, :create
    delete "/users/:id", UserController, :delete
  end
end
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/:id' }));
  });

  it('detects NestJS routes (@Controller + @Get)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/users/users.controller.ts', `
import { Controller, Get, Post } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return {}; }

  @Post('')
  create(@Body() dto: CreateUserDto) { return {}; }
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
  });

  it('detects FastAPI routes (@app.get, @router.post)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'main.py', `
from fastapi import FastAPI

app = FastAPI()

@app.get("/items")
def read_items():
    return []

@app.post("/items")
def create_item(item: Item):
    return item

@router.delete("/items/{item_id}")
def delete_item(item_id: int):
    pass
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/items' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/items' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/items/{item_id}' }));
  });

  it('detects Flask routes (@app.route with methods)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app.py', `
from flask import Flask

app = Flask(__name__)

@app.route('/hello')
def hello():
    return 'Hello!'

@app.route('/users', methods=['GET', 'POST'])
def users():
    return []
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/hello' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
  });

  it('detects Spring Boot routes (@GetMapping + @RequestMapping prefix)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'UserController.java', `
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {

    @GetMapping("/users")
    public List<User> getUsers() { return List.of(); }

    @PostMapping("/users")
    public User createUser(@RequestBody User user) { return user; }

    @DeleteMapping("/users/{id}")
    public void deleteUser(@PathVariable long id) { }
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/users/{id}' }));
  });

  it('detects Sinatra routes (get "/path" do)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'app.rb', `
require 'sinatra'

get '/hello' do
  'Hello World'
end

post '/users' do
  'Created'
end

delete '/users/:id' do
  'Deleted'
end
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/hello' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/:id' }));
  });

  it('does not detect Sinatra routes in routes.rb files', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'config/routes.rb', `
Rails.application.routes.draw do
  get '/about', to: 'pages#about'
end
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    // Should only detect via Rails detector, not Sinatra
    const aboutRoutes = routes.filter(r => r.path === '/about');
    expect(aboutRoutes).toHaveLength(1);
    expect(aboutRoutes[0].method).toBe('GET');
  });

  it('detects Hono routes (app.get, app.post)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'src/index.ts', `
import { Hono } from 'hono';
const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));
app.post('/api/items', async (c) => { return c.json({}); });
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/health' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/items' }));
  });

  it('detects Fiber routes (app.Get, app.Post)', async () => {
    const dir = createTmpDir();

    writeFile(dir, 'main.go', `
package main

import "github.com/gofiber/fiber/v2"

func main() {
    app := fiber.New()
    app.Get("/api/users", getUsers)
    app.Post("/api/users", createUser)
}
`);

    await indexer.index([dir]);
    const routes = indexer.getRoutes();

    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/users' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/users' }));
  });
});
