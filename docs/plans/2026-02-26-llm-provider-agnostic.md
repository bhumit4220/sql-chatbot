# LLM Provider-Agnostic Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the hardcoded OpenAI dependency from the cloud service so it can talk to ANY OpenAI-compatible LLM provider (llama.cpp locally for free, or OpenAI/DeepSeek/Groq as paid options).

**Architecture:** Replace `packages/cloud/src/llm/openai.ts` with a provider-agnostic `client.ts` that reads `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` from environment variables. The OpenAI SDK's `baseURL` parameter already supports custom endpoints, so the change is mostly renaming + env var wiring. All three routes (`classify`, `generate-sql`, `answer`) and the integration test need import updates.

**Tech Stack:** Node.js, TypeScript, OpenAI SDK (unchanged — it's the HTTP client, not the provider), Vitest, Express

---

## Summary of Changes

| File | Action |
|------|--------|
| `packages/cloud/src/llm/openai.ts` | Delete (replaced by `client.ts`) |
| `packages/cloud/src/llm/client.ts` | Create — provider-agnostic LLM client |
| `packages/cloud/src/server.ts` | Update import: `initOpenAI` → `initLLM` |
| `packages/cloud/src/routes/classify.ts` | Update import: `callOpenAI` → `callLLM` |
| `packages/cloud/src/routes/generate-sql.ts` | Update import: `callOpenAI` → `callLLM` |
| `packages/cloud/src/routes/answer.ts` | Update import: `streamOpenAI` → `streamLLM` |
| `packages/cloud/src/__tests__/llm-client.test.ts` | Create — unit tests for the new LLM client |
| `packages/cloud/src/__tests__/server.integration.test.ts` | Update mock path |
| `packages/cloud/.env.example` | Create — document all provider configs |

---

## Task 1: Write unit tests for the new LLM client

**Files:**
- Create: `packages/cloud/src/__tests__/llm-client.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/cloud/src/__tests__/llm-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the openai module — capture create calls for contract assertions
const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      baseURL: string;
      apiKey: string;
      constructor(opts: any) {
        this.baseURL = opts.baseURL;
        this.apiKey = opts.apiKey;
      }
      chat = {
        completions: {
          create: mockCreate.mockImplementation(async (opts: any) => {
            if (opts.stream) {
              return (async function* () {
                yield { choices: [{ delta: { content: 'Hello' } }] };
              })();
            }
            return {
              choices: [{ message: { content: '{"type":"data"}' } }],
            };
          }),
        },
      };
    },
  };
});

import { initLLM, callLLM, streamLLM, getLLMConfig } from '../llm/client.js';

describe('LLM Client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockCreate.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initLLM', () => {
    it('uses default OpenAI config when no env vars set', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_API_KEY;
      delete process.env.LLM_MODEL;

      initLLM();
      const config = getLLMConfig();

      expect(config.baseURL).toBe('https://api.openai.com/v1');
      expect(config.model).toBe('gpt-4o-mini');
    });

    it('reads LLM_BASE_URL from environment', () => {
      process.env.LLM_BASE_URL = 'http://localhost:8080/v1';
      process.env.LLM_API_KEY = 'not-needed';

      initLLM();
      const config = getLLMConfig();

      expect(config.baseURL).toBe('http://localhost:8080/v1');
    });

    it('reads LLM_MODEL from environment', () => {
      process.env.LLM_MODEL = 'qwen3-4b';
      process.env.LLM_API_KEY = 'not-needed';

      initLLM();
      const config = getLLMConfig();

      expect(config.model).toBe('qwen3-4b');
    });

    it('falls back to OPENAI_API_KEY when LLM_API_KEY not set', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-fallback';
      delete process.env.LLM_API_KEY;

      initLLM();
      const config = getLLMConfig();

      expect(config.apiKey).toBe('sk-openai-fallback');
    });

    it('prefers LLM_API_KEY over OPENAI_API_KEY', () => {
      process.env.OPENAI_API_KEY = 'sk-old';
      process.env.LLM_API_KEY = 'sk-new';

      initLLM();
      const config = getLLMConfig();

      expect(config.apiKey).toBe('sk-new');
    });

    it('returns stored init-time values, not live env vars', () => {
      process.env.LLM_BASE_URL = 'http://localhost:8080/v1';
      process.env.LLM_MODEL = 'qwen3-4b';
      process.env.LLM_API_KEY = 'key-at-init';

      initLLM();

      // Mutate env AFTER init
      process.env.LLM_BASE_URL = 'http://changed:9999/v1';
      process.env.LLM_MODEL = 'changed-model';
      process.env.LLM_API_KEY = 'changed-key';

      const config = getLLMConfig();
      expect(config.baseURL).toBe('http://localhost:8080/v1');
      expect(config.model).toBe('qwen3-4b');
      expect(config.apiKey).toBe('key-at-init');
    });

    it('warns when no API key is set with default OpenAI base URL', () => {
      delete process.env.LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_BASE_URL;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      initLLM();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No LLM_API_KEY or OPENAI_API_KEY set')
      );
      warnSpy.mockRestore();
    });

    it('does NOT warn when no API key is set with local base URL', () => {
      delete process.env.LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;
      process.env.LLM_BASE_URL = 'http://localhost:8080/v1';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      initLLM();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('callLLM', () => {
    it('returns response content', async () => {
      initLLM();
      const result = await callLLM([{ role: 'user', content: 'test' }]);
      expect(result).toBe('{"type":"data"}');
    });

    it('passes jsonMode as response_format to the SDK', async () => {
      process.env.LLM_MODEL = 'test-model';
      initLLM();
      await callLLM(
        [{ role: 'user', content: 'test' }],
        { jsonMode: true, temperature: 0.2 }
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          temperature: 0.2,
          response_format: { type: 'json_object' },
        })
      );
    });

    it('uses env var model as default', async () => {
      process.env.LLM_MODEL = 'custom-model';
      initLLM();
      await callLLM([{ role: 'user', content: 'test' }]);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'custom-model' })
      );
    });

    it('allows per-call model override', async () => {
      process.env.LLM_MODEL = 'default-model';
      initLLM();
      await callLLM([{ role: 'user', content: 'test' }], { model: 'override-model' });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'override-model' })
      );
    });
  });

  describe('streamLLM', () => {
    it('yields streamed tokens', async () => {
      initLLM();
      const tokens: string[] = [];
      for await (const token of streamLLM([{ role: 'user', content: 'test' }])) {
        tokens.push(token);
      }
      expect(tokens).toEqual(['Hello']);
    });

    it('passes stream: true to the SDK', async () => {
      initLLM();
      // Consume the generator to trigger the call
      for await (const _ of streamLLM([{ role: 'user', content: 'test' }])) { /* drain */ }
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true })
      );
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/cloud && npx vitest run src/__tests__/llm-client.test.ts`
Expected: FAIL — module `../llm/client.js` does not exist

**Step 3: Commit**

```bash
git add packages/cloud/src/__tests__/llm-client.test.ts
git commit -m "test: add failing tests for provider-agnostic LLM client"
```

---

## Task 2: Create the provider-agnostic LLM client

**Files:**
- Create: `packages/cloud/src/llm/client.ts`

**Step 1: Write the implementation**

```typescript
// packages/cloud/src/llm/client.ts
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

let client: OpenAI;
let configuredBaseURL: string;
let configuredApiKey: string;
let defaultModel: string;

/**
 * Initialize the LLM client. Reads configuration from environment variables.
 *
 * NOTE: The old initOpenAI(apiKey?) accepted an optional apiKey parameter.
 * This was intentionally removed — no call site ever passed it.
 * All configuration now comes from environment variables.
 */
export function initLLM() {
  configuredApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  configuredBaseURL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  defaultModel = process.env.LLM_MODEL || 'gpt-4o-mini';

  // Warn if no API key is set but pointing at a remote provider
  if (!configuredApiKey && configuredBaseURL === 'https://api.openai.com/v1') {
    console.warn('WARNING: No LLM_API_KEY or OPENAI_API_KEY set. OpenAI requests will fail.');
  }

  client = new OpenAI({ apiKey: configuredApiKey, baseURL: configuredBaseURL });
}

/** Returns the config values that were stored during initLLM(). */
export function getLLMConfig() {
  return { baseURL: configuredBaseURL, apiKey: configuredApiKey, model: defaultModel };
}

interface CallOptions {
  jsonMode?: boolean;
  temperature?: number;
  model?: string;
}

export async function callLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): Promise<string> {
  if (!client) initLLM();

  const response = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.1,
    response_format: options.jsonMode ? { type: 'json_object' } : undefined,
  });

  return response.choices[0]?.message?.content || '';
}

export async function* streamLLM(
  messages: ChatCompletionMessageParam[],
  options: CallOptions = {}
): AsyncGenerator<string> {
  if (!client) initLLM();

  const stream = await client.chat.completions.create({
    model: options.model || defaultModel,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
```

**Step 2: Run the new tests to verify they pass**

Run: `cd packages/cloud && npx vitest run src/__tests__/llm-client.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/cloud/src/llm/client.ts
git commit -m "feat: add provider-agnostic LLM client with env var configuration"
```

---

## Task 3: Update all imports (routes + server)

**Files:**
- Modify: `packages/cloud/src/routes/classify.ts:2` — change import
- Modify: `packages/cloud/src/routes/generate-sql.ts:2` — change import
- Modify: `packages/cloud/src/routes/answer.ts:2` — change import
- Modify: `packages/cloud/src/server.ts:7` — change import

**Step 1: Update classify.ts**

```diff
- import { callOpenAI } from '../llm/openai.js';
+ import { callLLM } from '../llm/client.js';
```

And line 15:
```diff
-     const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
+     const result = await callLLM(messages, { jsonMode: true, temperature: 0.1 });
```

**Step 2: Update generate-sql.ts**

```diff
- import { callOpenAI } from '../llm/openai.js';
+ import { callLLM } from '../llm/client.js';
```

And line 18:
```diff
-     const result = await callOpenAI(messages, { jsonMode: true, temperature: 0.1 });
+     const result = await callLLM(messages, { jsonMode: true, temperature: 0.1 });
```

**Step 3: Update answer.ts**

```diff
- import { streamOpenAI } from '../llm/openai.js';
+ import { streamLLM } from '../llm/client.js';
```

And line 25:
```diff
-     for await (const token of streamOpenAI(messages)) {
+     for await (const token of streamLLM(messages)) {
```

**Step 4: Update server.ts**

```diff
- import { initOpenAI } from './llm/openai.js';
+ import { initLLM } from './llm/client.js';
```

And line 34:
```diff
-   initOpenAI();
+   initLLM();
```

**Step 5: Delete the old file**

```bash
rm packages/cloud/src/llm/openai.ts
```

**Step 6: Update the integration test mock path**

In `packages/cloud/src/__tests__/server.integration.test.ts`, the mock targets `'openai'` (the npm package), NOT our local file. So **no change needed** — the mock intercepts the `openai` npm import regardless of which local file imports it.

Verify by reading the mock: `vi.mock('openai', ...)` — this mocks the npm package, not a file path. The new `client.ts` still imports from `'openai'`, so the mock still works.

**Step 7: Run ALL tests**

Run: `cd packages/cloud && npx vitest run`
Expected: ALL PASS (llm-client, classify, generate-sql, answer, auth, server.integration)

**Step 8: Commit**

```bash
git add -A packages/cloud/src/
git commit -m "refactor: replace openai.ts with provider-agnostic client.ts

Update all route imports (callOpenAI → callLLM, streamOpenAI → streamLLM)
and server init (initOpenAI → initLLM). Delete the old openai.ts file."
```

---

## Task 4: Create .env.example with all provider configurations

**Files:**
- Create: `packages/cloud/.env.example`

**Step 1: Write the .env.example**

```bash
# packages/cloud/.env.example
#
# LLM Provider Configuration
# ===========================
# The cloud service talks to any OpenAI-compatible API endpoint.
# Change these three variables to switch providers — no code changes needed.
#
# LLM_BASE_URL  — The LLM provider's API endpoint
# LLM_API_KEY   — API key (set to any value for local llama.cpp)
# LLM_MODEL     — The model name to use
#
# --- Free: llama.cpp running locally ---
# LLM_BASE_URL=http://localhost:8080/v1
# LLM_API_KEY=not-needed
# LLM_MODEL=qwen3-4b
#
# --- Free: Ollama running locally ---
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_API_KEY=not-needed
# LLM_MODEL=qwen3:4b
#
# --- Cheap: DeepSeek API ---
# LLM_BASE_URL=https://api.deepseek.com/v1
# LLM_API_KEY=sk-your-deepseek-key
# LLM_MODEL=deepseek-chat
#
# --- Cheap + fast: Groq API ---
# LLM_BASE_URL=https://api.groq.com/openai/v1
# LLM_API_KEY=gsk-your-groq-key
# LLM_MODEL=llama-3.3-70b-versatile
#
# --- Best quality: OpenAI (default if nothing set) ---
# LLM_BASE_URL=https://api.openai.com/v1
# LLM_API_KEY=sk-your-openai-key
# LLM_MODEL=gpt-4o-mini
#
# Backwards compatibility: OPENAI_API_KEY is still read as fallback
# if LLM_API_KEY is not set. New deployments should use LLM_API_KEY.

# Active configuration — uncomment ONE provider block above, or set directly:
# LLM_BASE_URL=
# LLM_API_KEY=
# LLM_MODEL=

# Cloud service
PORT=3100

# API key database path
API_KEYS_DB=./data/api-keys.sqlite3
```

**Step 2: Commit**

```bash
git add packages/cloud/.env.example
git commit -m "docs: add .env.example with all LLM provider configurations"
```

---

## Task 5: Set up llama.cpp locally with Qwen3-4B

This task is a local setup task, not a code change. It prepares the local environment for testing.

**Step 1: Install llama.cpp**

Check if already available:
```bash
which llama-server || echo "not installed"
```

If not installed, install via the package manager or build from source:
```bash
# Option A: Install pre-built binary (if available)
# Check https://github.com/ggml-org/llama.cpp/releases for latest

# Option B: Build from source
cd /tmp
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
make -j$(nproc)
# Binary will be at ./llama-server
```

**Step 2: Download the Qwen3-4B model (Q5_K_M quantization)**

```bash
# Create a models directory
mkdir -p ~/models

# Download from HuggingFace (~3.2GB)
# Check https://huggingface.co/Qwen/Qwen3-4B-GGUF for exact filename
wget -O ~/models/qwen3-4b-q5_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/qwen3-4b-q5_k_m.gguf"
```

**Step 3: Start the llama.cpp server**

```bash
llama-server \
  --model ~/models/qwen3-4b-q5_k_m.gguf \
  --port 8080 \
  --ctx-size 4096 \
  --threads 4
```

**Step 4: Verify the server responds**

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b",
    "messages": [{"role": "user", "content": "Say hello in one word"}],
    "temperature": 0.1
  }'
```

Expected: A JSON response with `choices[0].message.content` containing a greeting.

**Step 5: No commit needed** — this is local environment setup.

---

## Task 6: Manual E2E test — all 5 question types with local model

This task verifies the full pipeline works with the local model. Run the cloud service pointed at llama.cpp and test each question type.

**Prerequisites:** llama.cpp running on port 8080 (Task 5), cloud service configured with `LLM_BASE_URL=http://localhost:8080/v1`.

**Step 1: Start the cloud service with local LLM config**

```bash
cd packages/cloud
LLM_BASE_URL=http://localhost:8080/v1 LLM_API_KEY=not-needed LLM_MODEL=qwen3-4b npx tsx src/server.ts
```

**Step 2: Test classification (non-streaming, JSON mode)**

```bash
curl -s http://localhost:3100/api/v1/classify \
  -H "Authorization: Bearer YOUR-TEST-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many active customers?",
    "schemaSummary": "TABLE customers (id INT, name TEXT, status INT)"
  }' | jq .
```

Expected: `{"type": "data", "confidence": 0.9+}` — valid JSON, correct classification.

**Step 3: Test SQL generation (non-streaming, JSON mode)**

```bash
curl -s http://localhost:3100/api/v1/generate-sql \
  -H "Authorization: Bearer YOUR-TEST-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many active customers?",
    "schema": "TABLE customers (id INT, name TEXT, status INT, created_at TIMESTAMP)",
    "enums": "customers.status: 1=Active, 2=Inactive, 3=Deleted",
    "discoveredContext": "",
    "history": []
  }' | jq .
```

Expected: `{"sql": "SELECT COUNT(*) FROM customers WHERE status = 1"}` — valid SQL using enum integer value.

**Step 4: Test answer streaming (SSE)**

```bash
curl -N http://localhost:3100/api/v1/answer \
  -H "Authorization: Bearer YOUR-TEST-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many active customers?",
    "questionType": "data",
    "sqlResult": "{\"columns\":[\"count\"],\"rows\":[{\"count\":342}]}",
    "history": []
  }'
```

Expected: SSE stream of `data: {"token":"..."}` events ending with `data: [DONE]`.

**Step 5: Test navigation question**

```bash
curl -s http://localhost:3100/api/v1/classify \
  -H "Authorization: Bearer YOUR-TEST-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Where do I manage contractors?",
    "schemaSummary": "TABLE contractors (id, name)",
    "pageContext": "Nav: [Dashboard, Customers, Jobs, Contractors, Settings]"
  }' | jq .
```

Expected: `{"type": "navigation", ...}`

**Step 6: Test unsafe question**

```bash
curl -s http://localhost:3100/api/v1/classify \
  -H "Authorization: Bearer YOUR-TEST-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "'; DROP TABLE customers; --",
    "schemaSummary": "TABLE customers (id, name)"
  }' | jq .
```

Expected: `{"type": "unsafe", ...}`

**Step 7: Document results**

Note which tests pass/fail. If any fail, proceed to Task 7 for prompt adjustments.

**Step 8: No commit** — this is manual verification.

---

## Task 7: Prompt adjustments for smaller models (if needed)

This task is CONDITIONAL — only needed if Task 6 reveals issues with the local model.

**Common issues and fixes:**

### Issue A: Model returns text preamble before JSON

Symptom: `callLLM` with `jsonMode: true` returns `"Sure! Here is the classification: {"type": "data"...}"`

Fix: Add explicit instruction to the end of each system prompt that uses JSON mode.

**Files:** `packages/cloud/src/prompts/classify.ts`, `packages/cloud/src/prompts/generate-sql.ts`

Add to the end of each system prompt:
```
CRITICAL: Your entire response must be valid JSON. Do not include any text before or after the JSON object.
```

### Issue B: Model uses wrong enum values (labels instead of integers)

Symptom: SQL generation returns `WHERE status = 'Active'` instead of `WHERE status = 1`

Fix: Make the enum instruction more explicit in `generate-sql.ts` system prompt.

### Issue C: Model adds extra JSON fields

Symptom: Classification returns `{"type": "data", "confidence": 0.95, "reasoning": "..."}`

Fix: This is harmless — our code only reads the fields it needs. No change required.

### Issue D: Streaming produces garbled output

Symptom: SSE tokens are malformed or incomplete

Fix: This would indicate a llama.cpp compatibility issue, not a prompt issue. Check llama.cpp version and `--ctx-size` setting.

**Testing after any prompt change:**

Run: `cd packages/cloud && npx vitest run`
Then re-run the manual tests from Task 6.

**Commit (only if changes were made):**

```bash
git add packages/cloud/src/prompts/
git commit -m "fix: adjust prompts for compatibility with smaller local models"
```

---

## Task 8: Final verification and cleanup

**Step 1: Run the full test suite**

```bash
cd packages/cloud && npx vitest run
```

Expected: ALL PASS

**Step 2: Verify TypeScript compiles cleanly**

```bash
cd packages/cloud && npx tsc --noEmit
```

Expected: No errors

**Step 3: Verify no references to old file remain**

Search for any remaining `openai.ts` or `callOpenAI` or `streamOpenAI` or `initOpenAI` references:

```bash
grep -r "openai\.ts\|callOpenAI\|streamOpenAI\|initOpenAI" packages/cloud/src/ --include="*.ts"
```

Expected: Zero matches (the `openai` npm package import in `client.ts` is fine — we're searching for our old file/function names).

Note: The `openai` **npm package** import in `client.ts` is correct and expected — it's the SDK, not our provider-specific code.

**Step 4: Verify .env.example exists and is complete**

```bash
cat packages/cloud/.env.example
```

**Step 5: Final commit (if any cleanup was needed)**

```bash
git add -A packages/cloud/
git commit -m "chore: final cleanup for LLM provider-agnostic refactor"
```

---

## Edge Cases & Risks

| Risk | Mitigation |
|------|-----------|
| llama.cpp doesn't support `response_format: { type: 'json_object' }` | It does — verified in llama.cpp docs. If a future version breaks this, fall back to prompt-only JSON enforcement. |
| `OPENAI_API_KEY` env var still used by existing deployments | Backwards compatible — `client.ts` reads `LLM_API_KEY` first, falls back to `OPENAI_API_KEY`. |
| Streaming differences between providers | The OpenAI SDK normalizes the SSE format. All OpenAI-compatible providers use the same chunked response format. |
| Local model slower than OpenAI | Expected — local CPU inference is ~10-50 tokens/sec vs. OpenAI's ~100+ tokens/sec. Acceptable for development and free tier. |
| Model file not found / llama.cpp not running | `callLLM` will throw a connection error. The existing error handling in routes already catches and returns 500. |
| Some providers don't accept `response_format` parameter | Some providers return 400 for unrecognized fields (not all silently ignore them). If a provider rejects `response_format`, the workaround is to strip it from the request and rely on prompt-only JSON enforcement (the prompts already say "Respond with JSON only"). This would be a targeted fix per provider, not a code rewrite. |
