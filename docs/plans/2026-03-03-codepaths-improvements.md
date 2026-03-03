# codePaths Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix CLI `--code` to accept multiple paths, add missing file extensions, and update README documentation.

**Architecture:** Four independent changes — CLI bug fix (type change + test updates), CodeIndexer extension list addition, and README documentation overhaul. All changes are non-breaking.

**Tech Stack:** TypeScript, Node.js `parseArgs`, Vitest

---

### Task 1: Fix CLI `--code` to accept multiple values

**Files:**
- Modify: `packages/agent/src/cli.ts:12` (CliFlags interface)
- Modify: `packages/agent/src/cli.ts:54` (parseArgs code option)
- Modify: `packages/agent/src/cli.ts:91` (mergeConfig codePaths line)
- Test: `packages/agent/src/__tests__/cli.test.ts`

**Step 1: Update the failing tests first (TDD — make tests expect new behavior)**

In `packages/agent/src/__tests__/cli.test.ts`, update these assertions:

Line 20 — change:
```typescript
expect(result.code).toBe('./app');
```
to:
```typescript
expect(result.code).toEqual(['./app']);
```

Line 82 — change:
```typescript
expect(result.code).toBe('./src');
```
to:
```typescript
expect(result.code).toEqual(['./src']);
```

Then add a new test after the single `--code` test (after line 21):

```typescript
it('parses multiple --code flags', () => {
  const result = parseCliArgs(['--code', './app', '--code', './config']);
  expect(result.code).toEqual(['./app', './config']);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent && npx vitest run src/__tests__/cli.test.ts`
Expected: 3 FAIL (the 2 updated assertions + the new test)

**Step 3: Update CliFlags interface**

In `packages/agent/src/cli.ts`, line 12, change:
```typescript
  code?: string;
```
to:
```typescript
  code?: string[];
```

**Step 4: Update parseArgs to accept multiple values**

In `packages/agent/src/cli.ts`, line 54, change:
```typescript
      code: { type: 'string' },
```
to:
```typescript
      code: { type: 'string', multiple: true },
```

**Step 5: Update mergeConfig to use array directly**

In `packages/agent/src/cli.ts`, line 91, change:
```typescript
    codePaths: flags.code ? [flags.code] : file.codePaths || ['./src'],
```
to:
```typescript
    codePaths: flags.code?.length ? flags.code : file.codePaths || ['./src'],
```

**Step 6: Run tests to verify they pass**

Run: `cd packages/agent && npx vitest run src/__tests__/cli.test.ts`
Expected: ALL PASS

**Step 7: Run full test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL 246+ tests PASS

**Step 8: Commit**

```bash
git add packages/agent/src/cli.ts packages/agent/src/__tests__/cli.test.ts
git commit -m "fix: support multiple --code flags in CLI"
```

---

### Task 2: Add file extensions for Kotlin, Rust, Dart, Scala

**Files:**
- Modify: `packages/agent/src/services/code-indexer.ts:25`
- Test: `packages/agent/src/__tests__/code-indexer.test.ts`

**Step 1: Add test for new extensions**

In `packages/agent/src/__tests__/code-indexer.test.ts`, find the test `'only reads supported file extensions'` (line 71). After the existing supported files (`app.vue`), add:

```typescript
    writeFile(dir, 'app.kt', 'kotlin');
    writeFile(dir, 'app.rs', 'rust');
    writeFile(dir, 'app.dart', 'dart');
    writeFile(dir, 'app.scala', 'scala');
```

And update the expected count from `8` to `12` (line 90):
```typescript
    expect(indexer.fileCount()).toBe(12);
```

**Step 2: Run test to verify it fails**

Run: `cd packages/agent && npx vitest run src/__tests__/code-indexer.test.ts -t "only reads supported file extensions"`
Expected: FAIL — expected 12 but got 8

**Step 3: Add extensions to SUPPORTED_EXTENSIONS**

In `packages/agent/src/services/code-indexer.ts`, line 25, change:
```typescript
const SUPPORTED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.rb', '.py', '.erb', '.vue', '.php', '.java', '.go', '.cs', '.ex', '.exs', '.svelte']);
```
to:
```typescript
const SUPPORTED_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.rb', '.py', '.erb', '.vue', '.php', '.java', '.go', '.cs', '.ex', '.exs', '.svelte', '.kt', '.rs', '.dart', '.scala']);
```

**Step 4: Run test to verify it passes**

Run: `cd packages/agent && npx vitest run src/__tests__/code-indexer.test.ts -t "only reads supported file extensions"`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL tests PASS

**Step 6: Commit**

```bash
git add packages/agent/src/services/code-indexer.ts packages/agent/src/__tests__/code-indexer.test.ts
git commit -m "feat: add Kotlin, Rust, Dart, Scala file extensions to code indexer"
```

---

### Task 3: Update README documentation

**Files:**
- Modify: `packages/agent/README.md`

**Step 1: Update CLI flags table**

In `packages/agent/README.md`, find the CLI flags table row for `--code` (line 88). Change:
```markdown
| `--code` | | Directory to index (single path) |
```
to:
```markdown
| `--code` | | Directory to index (repeatable: `--code ./app --code ./config`) |
```

**Step 2: Update codePaths row in config table**

Find the config table row for `codePaths` (line 73). Change:
```markdown
| `codePaths` | string[] | Directories to index for code questions (default: `["./src"]`) |
```
to:
```markdown
| `codePaths` | string[] | Directories to scan for route detection, enum discovery, and business logic context (default: `["./src"]`) |
```

**Step 3: Add "Code Indexing" section**

After the "Configuration" section (after line 76, the backward compat note), add:

```markdown
## Code Indexing

The `codePaths` option (or `--code` CLI flag) controls which directories the chatbot scans for source code. This powers three features:

1. **Route detection** — navigation and guidance answers (Express, Rails, Django, Next.js, etc.)
2. **Enum & constant discovery** — model-level enums (Rails `enum`, Django `choices`, TypeORM decorators, etc.) are surfaced as context for accurate SQL generation
3. **Business logic context** — validation rules, calculations, and domain logic help the LLM generate better queries

### Framework-Specific Paths

| Framework | Recommended `codePaths` |
|-----------|------------------------|
| Express / React / Next.js / Hono | `["./src"]` |
| Rails | `["./app", "./config"]` |
| Django | `["./myapp"]` (your app directories) |
| Laravel | `["./app", "./routes"]` |
| Flask / FastAPI | `["./app"]` or `["."]` |
| Spring Boot (Java/Kotlin) | `["./src/main/java"]` or `["./src/main/kotlin"]` |
| Go (Gin / Echo / Fiber) | `["./cmd", "./internal"]` |
| Phoenix / Elixir | `["./lib"]` |
| SvelteKit / Nuxt | `["./src"]` |
| ASP.NET | `["./Controllers"]` |
| Rust (Actix / Axum) | `["./src"]` |
| Sinatra | `["."]` |

**Tip:** When in doubt, point to your project root. The indexer automatically skips `node_modules`, `.git`, `dist`, `build`, `vendor`, `target`, `__pycache__`, etc.

### Supported File Types

`.js`, `.ts`, `.jsx`, `.tsx`, `.rb`, `.py`, `.erb`, `.vue`, `.php`, `.java`, `.go`, `.cs`, `.ex`, `.exs`, `.svelte`, `.kt`, `.rs`, `.dart`, `.scala`

### Limits

- Maximum 2000 files indexed (configurable)
- Files are scanned on first request (lazy initialization)
- Use `/chatbot/api/refresh` to re-index after code changes
```

**Step 4: Update "Supported Frameworks" section**

Find the "Supported Frameworks" section (line 343). Replace the entire section:

```markdown
## Supported Frameworks

The code indexer detects routes and patterns from 17+ frameworks:

**JavaScript/TypeScript:** Express.js, Fastify, Hono, Koa, React Router, Next.js (pages + app router), NestJS, SvelteKit, Nuxt
**Ruby:** Rails, Sinatra
**Python:** Django, FastAPI, Flask
**Java/Kotlin:** Spring Boot
**Go:** Gin, Echo, Fiber
**C#:** ASP.NET (minimal APIs + attribute routing)
**Elixir:** Phoenix
```

**Step 5: Commit**

```bash
git add packages/agent/README.md
git commit -m "docs: improve codePaths documentation and update supported frameworks list"
```

---

### Task 4: Run full test suite and verify

**Step 1: Run complete test suite**

Run: `cd packages/agent && npx vitest run`
Expected: ALL tests PASS (248+ with the new tests added)

**Step 2: Verify build succeeds**

Run: `cd packages/agent && npm run build`
Expected: Clean build, no errors

**Step 3: Spot-check CLI help behavior**

Run: `cd packages/agent && node dist/cli.js --help 2>&1 || true`
Expected: No crash (parseArgs with strict:false won't error on unknown flags)
