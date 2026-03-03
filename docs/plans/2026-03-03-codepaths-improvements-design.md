# codePaths Improvements Design

**Date:** 2026-03-03
**Branch:** v1-development
**Scope:** Bug fix + feature + documentation

## Problem

1. CLI `--code` flag only accepts a single value despite docs claiming multiple are supported
2. Missing file extensions for Kotlin, Rust, Dart, Scala ecosystems
3. README `codePaths` documentation is sparse — doesn't explain its importance for SQL accuracy
4. README "Supported Frameworks" list is outdated (shows 4, actually supports 17+)

## Changes

### 1. Fix CLI `--code` to accept multiple values

**File:** `packages/agent/src/cli.ts`

- Change `parseArgs` option from `{ type: 'string' }` to `{ type: 'string', multiple: true }`
- Update `CliFlags` interface: `code?: string` → `code?: string[]`
- Update `mergeConfig()`: `flags.code ? [flags.code]` → `flags.code?.length ? flags.code`
- Update 2 test assertions in `cli.test.ts` to expect arrays

**Behavior:**
- `--code ./app --code ./config` → `codePaths: ['./app', './config']`
- `--code ./src` (single) → `codePaths: ['./src']`
- No `--code` flag → falls back to config file or default `['./src']`

**No public API changes.** `mergeConfig()` output type is unchanged (`codePaths: string[]`).

### 2. Add file extensions

**File:** `packages/agent/src/services/code-indexer.ts`

Add to `SUPPORTED_EXTENSIONS`:
- `.kt` — Kotlin (Ktor, Spring Boot Kotlin, Exposed)
- `.rs` — Rust (Actix-web, Diesel, SeaORM)
- `.dart` — Dart (Dart Frog, Serverpod)
- `.scala` — Scala (Play Framework, Slick)

### 3. Update README codePaths documentation

**File:** `packages/agent/README.md`

- Expand the `codePaths` row in the config table to mention enum/business logic discovery
- Add a "Code Indexing" section explaining why it matters and framework-specific `--code` values
- Update "Supported Frameworks" to list all 17+ detected frameworks
- Update `--code` CLI flag description to note multiple values are accepted

### 4. No changes needed

- Path resolution (relative from CWD) — already correct
- `resolveConfig()` in `config.ts` — already accepts `codePaths: string[]`
- Middleware API — unchanged
- `chatbot.config.json` format — unchanged

## Risk Assessment

| Change | Breaks tests? | Breaks users? | Runtime risk? |
|--------|--------------|---------------|---------------|
| Multiple `--code` | 2 assertions updated | No | None |
| New extensions | No | No | None |
| README docs | No | No | None |

## Test Plan

- Update 2 existing CLI test assertions
- Add new test: `--code` with multiple values
- Add new test: verify new extensions are in SUPPORTED_EXTENSIONS
- Run full test suite (246+ tests)
