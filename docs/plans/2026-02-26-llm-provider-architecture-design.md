# LLM Provider Architecture — Design Document

> **Date:** 2026-02-26
> **Design branch:** v3-development (this document)
> **Implementation branch:** feature/llm-provider-agnostic (to be created from v3-development)
> **Status:** Approved design, pending implementation

---

## 1. The Problem

Our cloud service (Node.js/Express) is **hardcoded to OpenAI's GPT-4o-mini**. This creates three problems:

1. **Cost** — Every customer question costs money (OpenAI charges per API call). As customers grow, costs grow linearly with no cap.
2. **Vendor lock-in** — If OpenAI raises prices, changes their API, or goes down, our entire product breaks.
3. **No free tier** — We can't offer a free/self-hosted option because the product requires a paid API key to function.

---

## 2. Research Summary

We investigated several approaches to remove the OpenAI dependency. Here's what we found:

### 2.1 PicoClaw

**What it is:** An ultra-lightweight AI assistant written in Go (~10MB binary, <10MB RAM). Open source. Supports multiple LLM providers (OpenAI, Anthropic, DeepSeek, Groq, etc.) through config. Can also use PicoLM for fully offline/local AI.

**What we learned:**
- PicoClaw is a **standalone chat bot** (Telegram, Discord, CLI) — not a library or API we can embed
- It has no HTTP API for other apps to call
- It has no SQL generation, schema understanding, or page crawling capabilities
- It does NOT have its own AI brain — it routes to external LLM providers

**Concepts worth borrowing:**
- Pluggable LLM provider via simple config (change one setting, different provider)
- Local model as a first-class option (not just cloud APIs)
- Lightweight footprint philosophy

**Verdict:** Cannot use directly, but the pluggable-provider concept is exactly what we need.

**Links:**
- [PicoClaw GitHub](https://github.com/sipeed/picoclaw)
- [PicoClaw Website](https://picoclaw.net/)

### 2.2 PicoLM

**What it is:** An ultra-tiny LLM inference engine written in ~2,500 lines of C. Runs AI models locally on hardware as small as a $10 RISC-V board with 256MB RAM.

**How it works:**
- Loads GGUF model files (a standard format for AI models)
- Memory-maps the model — only loads one layer at a time (~29MB in RAM for a 1B model)
- Has a **JSON grammar constraint** — forces the AI to always output valid JSON by blocking invalid tokens during generation
- Communicates via stdin/stdout (Unix pipes) — no HTTP API
- Runs TinyLlama 1B model (1 billion parameters)

**Why we can't use it:**
- Only supports small models (1B parameters). Our product needs at least 4B for reliable SQL generation, code explanation, navigation guidance, and answer formatting across all 5 question types.
- No HTTP API — our cloud service needs to call the engine over HTTP.
- No SSE streaming — we need word-by-word streaming for the chat widget.

**Key concept borrowed:** JSON grammar constraint for guaranteed structured output.

**Links:**
- [PicoLM GitHub](https://github.com/RightNow-AI/picolm)

### 2.3 Ollama

**What it is:** A user-friendly tool for running AI models locally. Wraps llama.cpp with a nice CLI, model management, and auto-download.

**Pros:** Easy to use, big community, supports all models
**Cons:** Heavy (~200MB+ installed), runs as a background service, adds overhead we don't need

**Verdict:** Good for end-user development/testing, but too heavy as a production dependency.

**Links:**
- [Ollama Website](https://ollama.com/)

### 2.4 llama.cpp (Chosen)

**What it is:** An open-source LLM inference engine written in C/C++. Runs AI models locally. Has a built-in HTTP server that speaks the **OpenAI-compatible API format**.

**Why this is the right choice:**

| Requirement | llama.cpp |
|------------|-----------|
| Runs any model size (1B to 70B+) | Yes |
| HTTP API our cloud service can call | Yes (OpenAI-compatible format) |
| SSE streaming (word-by-word) | Yes |
| JSON grammar constraint | Yes (GBNF grammars) |
| Free and open source (MIT license) | Yes |
| Commercial use allowed | Yes |
| Lightweight | ~5-10MB binary, no runtime dependencies |
| Battle-tested | 60,000+ GitHub stars, massive community |
| CPU-only mode (no GPU needed) | Yes |

**The killer feature:** llama.cpp's HTTP server speaks the exact same API format as OpenAI (`POST /v1/chat/completions`). This means our cloud service can switch between OpenAI and llama.cpp by changing **one URL** — no code changes.

**Links:**
- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)

### 2.5 Local AI Models Researched

We need a model (brain) that handles ALL 5 of our question types, not just SQL.

| Model | Size | SQL Accuracy (BIRD benchmark) | Code Explanation | Navigation/Guidance | JSON Output | Free |
|-------|------|-------------------------------|------------------|--------------------|----|------|
| GPT-4o-mini (current) | Paid API | ~41-50% | Good | Good | Good | No |
| **Qwen3-4B** | 3-4GB RAM | Good | Very Good | Very Good | Excellent | Yes |
| **Qwen3-8B** | 5-6GB RAM | Very Good | Excellent | Excellent | Excellent | Yes |
| Arctic-Text2SQL-R1-7B | 5-6GB RAM | 68.9% (best) | Weak (SQL-only) | Weak | Good | Yes |
| SQLCoder-7b-2 | 5-6GB RAM | ~60-65% | Weak (SQL-only) | Weak | Good | Yes |
| SLM-SQL-1.5B | 2GB RAM | 67% | Weak (SQL-only) | Weak | Moderate | Yes |
| TinyLlama 1B | <1GB RAM | Poor | Poor | Poor | Poor | Yes |

**Recommended models:**
- **Qwen3-4B** — Best lightweight all-rounder. Handles all 5 tasks. ~3-4GB RAM.
- **Qwen3-8B** — Better accuracy if more RAM is available. ~5-6GB RAM.

SQL-specific models (Arctic, SQLCoder, SLM-SQL) score higher on SQL benchmarks but **cannot** handle code explanation, navigation, guidance, or conversational answer formatting. Since our product needs all 5 capabilities, a general-purpose model is the right choice.

**Key insight:** Fine-tuned local models at 4B+ parameters actually **outperform GPT-4o-mini on SQL generation benchmarks**. Switching to a local model is not a downgrade — it's potentially an upgrade in SQL accuracy, while being free.

---

## 3. Chosen Architecture

### 3.1 Overview

Make the cloud service **LLM-provider-agnostic**. Instead of hardcoding OpenAI, support any provider that speaks the OpenAI-compatible API format. The LLM endpoint is configured via environment variables.

**Before (current):**
```
Widget → Cloud Service → OpenAI API (hardcoded, paid)
            ↕
        Framework Agent
```

**After (new):**
```
Widget → Cloud Service → Any LLM endpoint (configurable)
            ↕                   |
        Framework Agent         ├── llama.cpp + Qwen3-4B (free, local)
        (Rails, Django,         ├── OpenAI (paid, best quality)
         Laravel, Node...)      ├── DeepSeek (cheap)
                                ├── Groq (fast + cheap)
                                └── Any OpenAI-compatible endpoint
```

### 3.2 Why Three Layers Still Matter

The product has three layers, and each exists for a reason:

```
WIDGET (universal)
  - Runs on ANY webpage regardless of backend framework
  - Crawls the page: sidebar links, breadcrumbs, headings, URL
  - Provides chat UI in a shadow DOM
  - Sends: question + page context + conversation history

FRAMEWORK AGENT (one per framework — Rails gem is the first)
  - Auto-discovers: database schema, enums, model relationships, code
  - Executes SQL queries (read-only)
  - Indexes and searches application code
  - Handles auth using the host app's own auth system
  - Thin layer — just collects info and passes it to the cloud service

CLOUD SERVICE (the brain — framework-agnostic)
  - Contains all prompts and AI logic
  - Classifies questions into 5 types
  - Generates SQL from natural language + schema context
  - Explains code from provided snippets
  - Gives navigation/guidance using page context
  - Formats and streams answers
  - Talks to the LLM engine (whichever is configured)
```

If we merged the cloud service into the Rails gem, only Rails apps could use our product. The cloud service MUST remain separate and framework-agnostic so that future agents (Django, Laravel, Node.js) can all use the same AI brain.

### 3.3 How Each Feature Works

Every feature follows the same pattern: **someone collects info → packs it into a prompt → sends to LLM → LLM reads and responds.** The LLM itself has no knowledge of the customer's app. All context is provided in every request.

**Data questions (SQL generation):**
```
Agent auto-discovers schema + enums + relationships at boot
    ↓
Cloud service builds prompt:
  "Here is the schema: customers(id, name, status)...
   Enums: status 1=Active, 2=Inactive, 3=Deleted
   Relationships: jobs.created_by → customers.id
   Question: How many active customers?
   Generate SQL."
    ↓
LLM responds: SELECT COUNT(*) FROM customers WHERE status = 1
    ↓
Agent executes SQL, gets result: [{count: 1250}]
    ↓
Cloud service builds another prompt:
  "SQL result was [{count: 1250}]. Write a friendly answer."
    ↓
LLM streams: "You have 1,250 active customers."
```

**Code explanation:**
```
Agent searches its code index for relevant snippets
    ↓
Cloud service builds prompt:
  "Here is code from the app:
   def net_sales
     total_revenue - discounts - refunds
   end
   Explain how net sales is calculated."
    ↓
LLM streams explanation in plain English
```

**Navigation (where is X?):**
```
Widget crawls the page — extracts sidebar links, breadcrumbs, URL
    ↓
Cloud service builds prompt:
  "Page has these sidebar links: Dashboard, Customers, Jobs, Contractors...
   Question: Where do I manage contractors?
   Guide the user using the actual navigation."
    ↓
LLM streams: "Click 'Contractors' in the sidebar."
```

**Guidance (how do I do X?):**
```
Widget crawls the page — same as navigation
    ↓
Cloud service builds prompt with page context
    ↓
LLM streams step-by-step instructions using actual page elements
```

**Unsafe (security):**
```
Cloud service asks LLM to classify the question
    ↓
LLM returns: {"type": "unsafe", "reason": "SQL injection attempt"}
    ↓
System blocks the request immediately
```

### 3.4 What Changes in Code

The change is minimal. All OpenAI calls go through ONE file: `packages/cloud/src/llm/openai.ts`. It has two functions:

- `callOpenAI()` — non-streaming (used by classify and generate-sql)
- `streamOpenAI()` — streaming (used by answer)

Both already accept an `options.model` parameter. We just need to:

1. Make the OpenAI client read `LLM_BASE_URL` from environment (instead of defaulting to OpenAI's URL)
2. Make the default model read from `LLM_MODEL` environment variable (instead of hardcoding `gpt-4o-mini`)
3. Rename the functions/file from "openai" to "llm" (since it's no longer OpenAI-specific)

**Current code:**
```typescript
// packages/cloud/src/llm/openai.ts
import OpenAI from 'openai';

export function initOpenAI(apiKey?: string) {
  client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
}

export async function callOpenAI(messages, options) {
  const response = await client.chat.completions.create({
    model: options.model || 'gpt-4o-mini',  // hardcoded
    messages,
    // ...
  });
}
```

**New code:**
```typescript
// packages/cloud/src/llm/client.ts
import OpenAI from 'openai';

export function initLLM() {
  client = new OpenAI({
    apiKey: process.env.LLM_API_KEY || 'not-needed',
    baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  });
}

export async function callLLM(messages, options) {
  const response = await client.chat.completions.create({
    model: options.model || process.env.LLM_MODEL || 'gpt-4o-mini',
    messages,
    // ...
  });
}
```

The OpenAI SDK already supports custom `baseURL`. llama.cpp, DeepSeek, Groq, and most providers use the same API format. So this one change unlocks all providers.

**Files that change:**

| File | Change |
|------|--------|
| `packages/cloud/src/llm/openai.ts` | Rename to `client.ts`, add `LLM_BASE_URL` and `LLM_MODEL` env vars |
| `packages/cloud/src/routes/classify.ts` | Update import from `openai` to `client` |
| `packages/cloud/src/routes/generate-sql.ts` | Update import from `openai` to `client` |
| `packages/cloud/src/routes/answer.ts` | Update import from `openai` to `client` |
| `packages/cloud/src/server.ts` | Update `initOpenAI()` to `initLLM()` |
| Everything else | **No changes** |

---

## 4. Configuration

### 4.1 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | The LLM provider's API endpoint |
| `LLM_API_KEY` | Yes (unless local) | — | API key for the provider. Set to any value for llama.cpp (it doesn't check). |
| `LLM_MODEL` | No | `gpt-4o-mini` | The model name to use |

### 4.2 Provider Configuration Examples

**Free — llama.cpp running locally:**
```bash
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=not-needed
LLM_MODEL=qwen3-4b
```

**Free — Ollama running locally:**
```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=not-needed
LLM_MODEL=qwen3:4b
```

**Cheap — DeepSeek API:**
```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-your-deepseek-key
LLM_MODEL=deepseek-chat
```

**Cheap + fast — Groq API:**
```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk-your-groq-key
LLM_MODEL=llama-3.3-70b-versatile
```

**Best quality — OpenAI:**
```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-openai-key
LLM_MODEL=gpt-4o-mini
```

**Best quality — Anthropic (via OpenAI-compatible proxy):**
```bash
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=sk-ant-your-key
LLM_MODEL=claude-sonnet-4-5-20250514
```

### 4.3 llama.cpp Server Setup

```bash
# 1. Download llama.cpp (one-time)
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp && make

# 2. Download a model (one-time)
# Qwen3-4B GGUF from HuggingFace (~3GB)
wget https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/qwen3-4b-q4_k_m.gguf

# 3. Start the server
./llama-server \
  --model qwen3-4b-q4_k_m.gguf \
  --port 8080 \
  --ctx-size 4096 \
  --threads 4

# Server is now running at http://localhost:8080
# Compatible with OpenAI API format at http://localhost:8080/v1/chat/completions
```

---

## 5. Scaling Strategy

### 5.1 Growth Phases

**Phase 1 — Early stage (1-10 customers):**
```
Single server running:
  - Cloud service (Node.js, port 3100)
  - llama.cpp (Qwen3-4B, port 8080)

Cost: $20-50/month for a VPS (4 CPU cores, 8GB RAM)
Handles: ~5-10 concurrent requests
```

**Phase 2 — Growing (10-100 customers):**
```
Separate the LLM onto its own server, or run multiple copies:

  Load Balancer
    ├── Cloud Service (instance 1)
    ├── Cloud Service (instance 2)
    └── ...
         ↓
  LLM Load Balancer
    ├── llama.cpp (instance 1)
    ├── llama.cpp (instance 2)
    └── ...

Cost: $100-300/month
Handles: ~50-100 concurrent requests
```

**Phase 3 — Scale (100+ customers):**
```
Switch LLM_BASE_URL to a managed API (DeepSeek, Groq, or OpenAI).
They handle scaling. We just pay per request and charge customers more.

OR run llama.cpp on GPU instances for higher throughput.

Cost: varies by provider and usage
Handles: unlimited (provider scales for us)
```

**Phase 4 — Monetization (our hosted tier):**
```
We run the cloud service + LLM as a managed endpoint.
Customers point their agent to our URL.
We charge a monthly subscription or per-query fee.

Free tier:  Customer runs their own llama.cpp (self-hosted)
Paid tier:  Customer uses our endpoint (we handle everything)
```

### 5.2 Why This Scales

The key insight: **changing the LLM backend is just changing one URL**. No code changes, no redeployment of agents or widgets. This means:

- Start with the cheapest option (local llama.cpp)
- Scale up when needed (more instances, or switch to a paid API)
- Let customers choose their own provider (their budget, their choice)
- Offer our own hosted endpoint as the premium option

---

## 6. Cost Comparison

| Setup | Monthly Cost | Per-Query Cost | Who Pays for LLM |
|-------|-------------|---------------|-------------------|
| **llama.cpp on VPS** (self-hosted) | $20-50 (server only) | $0 | Us (server cost) |
| **DeepSeek API** | Variable | ~$0.001-0.003 | Us or customer |
| **Groq API** | Variable | ~$0.001-0.005 | Us or customer |
| **OpenAI GPT-4o-mini** (current) | Variable | ~$0.005-0.01 | Us or customer |
| **OpenAI GPT-4o** | Variable | ~$0.01-0.05 | Customer |

**Example: 10,000 queries/month**

| Provider | Cost |
|----------|------|
| llama.cpp (local) | $0 (just server cost) |
| DeepSeek | ~$10-30 |
| GPT-4o-mini | ~$50-100 |
| GPT-4o | ~$100-500 |

---

## 7. Quantization Guide

When running models locally with llama.cpp, models are compressed (quantized) to reduce size and RAM usage. The trade-off is accuracy:

| Quantization | Size (4B model) | RAM Needed | Quality Loss | Good for SQL? |
|-------------|----------------|------------|-------------|---------------|
| Q8_0 | ~4.5 GB | ~6 GB | ~0.1% | Best — recommended if RAM allows |
| Q5_K_M | ~3.2 GB | ~5 GB | ~1-2% | Very good — best balance |
| Q4_K_M | ~2.5 GB | ~4 GB | ~3-5% | Good — use with retry logic |
| Q3_K_M | ~2.0 GB | ~3 GB | ~10% | Risky — may produce wrong SQL |
| Q2_K | ~1.5 GB | ~2.5 GB | ~15-20% | Do not use for SQL |

**Recommendation:** Use **Q5_K_M** for the best balance of size and accuracy. SQL generation is a precision task — one wrong column name breaks the query. Don't over-compress.

---

## 8. Technical Details

### 8.1 How llama.cpp Works Internally

1. **Loads the model file** (GGUF format) using memory mapping — only reads pieces as needed, not the whole file
2. **Tokenizes the input** — converts English words into numbers using a dictionary
3. **Runs through transformer layers** — each layer adds more understanding (a 4B model has ~32 layers)
4. **Predicts the next word** — outputs probabilities for every possible word, picks the most likely one
5. **Repeats step 4** — generates one word at a time until the response is complete
6. **Streams each word** — sends via SSE as soon as it's generated (no waiting for full response)

### 8.2 JSON Grammar Constraint (borrowed from PicoLM concept)

#### The Problem

Our classification endpoint MUST return clean JSON every time:
```json
{"type": "data", "confidence": 0.95, "searchTerms": []}
```

But AI models sometimes go off-script:
```
Sure! Based on the question, I'd classify this as a "data" type query
with about 95% confidence...
```

This breaks our pipeline — the code tries to `JSON.parse()` the response and crashes.

With OpenAI, we use `response_format: { type: "json_object" }` which mostly works but isn't 100% guaranteed. With a local model, the risk of malformed output is higher.

#### The Solution — Grammar-Constrained Generation

PicoLM introduced us to this concept: **force the AI to ONLY generate valid tokens at each step.**

How it works, step by step:

```
AI is generating token #1:
  Possible tokens: "Sure" (35%), "{" (40%), "The" (25%)
  Grammar check: JSON must start with { or [
  BLOCKED: "Sure", "The"
  ALLOWED: "{"
  → AI outputs: {

AI is generating token #2:
  Possible tokens: "hello" (20%), "\"type\"" (50%), "123" (30%)
  Grammar check: after { must come " (for a key)
  BLOCKED: "hello", "123"
  ALLOWED: "\"type\""
  → AI outputs: "type"

AI is generating token #3:
  Grammar check: after key must come :
  → AI outputs: :

...and so on until the JSON is complete.
```

At every single token, the grammar **masks** (blocks) all tokens that would create invalid JSON. The AI can only choose from tokens that keep the output valid. It's physically impossible to get malformed output.

#### How We Use It

**Three methods available, depending on the LLM provider:**

**Method 1: OpenAI-compatible `response_format` (works with OpenAI, llama.cpp, Ollama, most providers)**
```typescript
const response = await client.chat.completions.create({
  model: 'qwen3-4b',
  messages: [...],
  response_format: { type: 'json_object' },  // ← forces JSON output
});
```
This is what we already use today. It works with llama.cpp's OpenAI-compatible API out of the box.

**Method 2: JSON Schema constraint (works with llama.cpp, Ollama v0.5+)**
```typescript
const response = await client.chat.completions.create({
  model: 'qwen3-4b',
  messages: [...],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'classification',
      schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['data', 'data_with_code', 'code', 'navigation', 'guidance', 'unsafe'] },
          confidence: { type: 'number' },
          searchTerms: { type: 'array', items: { type: 'string' } }
        },
        required: ['type', 'confidence']
      }
    }
  }
});
```
Even stricter — not only must the output be valid JSON, it must match our exact schema. The AI cannot invent random fields or return wrong types.

**Method 3: GBNF grammar (llama.cpp native, most powerful)**
```
# Custom grammar rule for our classification output
root   ::= "{" ws "\"type\"" ws ":" ws type "," ws "\"confidence\"" ws ":" ws number "}"
type   ::= "\"data\"" | "\"code\"" | "\"navigation\"" | "\"guidance\"" | "\"unsafe\""
number ::= [0-9] "." [0-9]+
ws     ::= " "?
```
Most control, but harder to maintain. We likely won't need this — Method 1 or 2 covers our needs.

#### Our Approach

We already use Method 1 (`jsonMode: true`) for classify and generate-sql routes. This works with both OpenAI and llama.cpp. No code change needed.

If we find the local model sometimes produces wrong field names or types, we upgrade to Method 2 (JSON Schema) for stricter control. This is a minor prompt/config change, not a code rewrite.

#### Where This Applies

| Route | Needs JSON? | Method |
|-------|------------|--------|
| `/api/v1/classify` | Yes — must return `{type, confidence, searchTerms}` | Method 1 (jsonMode) or Method 2 (schema) |
| `/api/v1/generate-sql` | Yes — must return `{sql}` | Method 1 (jsonMode) or Method 2 (schema) |
| `/api/v1/answer` | No — returns natural language (streamed) | Not applicable |

### 8.3 OpenAI SDK Compatibility

The OpenAI Node.js SDK (`openai` npm package, which we already use) supports a `baseURL` parameter:

```typescript
const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',  // llama.cpp server
  apiKey: 'not-needed',
});
```

All existing code that calls `client.chat.completions.create()` works unchanged. The SDK doesn't care whether it's talking to OpenAI's servers or a local llama.cpp instance — the request/response format is identical.

---

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Local model gives worse answers than GPT-4o-mini | Benchmarks show 4B+ models match or beat GPT-4o-mini on SQL. Test thoroughly before switching. Keep OpenAI as a fallback option. |
| llama.cpp server crashes under load | Use process manager (systemd/pm2) for auto-restart. Scale horizontally behind load balancer. |
| Some prompts may need tweaking for smaller models | Prompts may need minor adjustments. Keep prompt templates configurable. Test all 5 question types. |
| Customer's VPS too small for local model | Offer our hosted endpoint as paid tier. Or recommend DeepSeek API ($0.001/query). |
| JSON output not guaranteed with all providers | Use llama.cpp's grammar constraint for local. For cloud APIs, keep existing JSON mode (`response_format: json_object`). |

---

## 10. Branch & Implementation Strategy

### Branch Plan
```
master (stable)
  └── v3-development (current V3 work — all 8 phases done)
        └── feature/llm-provider-agnostic (this work — new branch)
              - Make cloud service LLM-agnostic
              - Test with llama.cpp + Qwen3-4B
              - Test all 5 question types
              - Update configuration docs
              - Merge back into v3-development when verified
```

### Implementation Order
1. Create branch `feature/llm-provider-agnostic` from `v3-development`
2. Refactor `packages/cloud/src/llm/openai.ts` → `client.ts` (add env var support)
3. Update imports in all 3 routes + server.ts
4. Set up llama.cpp locally with Qwen3-4B for testing
5. Test all 5 question types with local model
6. Adjust prompts if needed for smaller model
7. Update `.env.example` with all provider configs
8. Merge to `v3-development`

---

## 11. Decision Summary

| Decision | Choice | Reason |
|----------|--------|--------|
| LLM dependency | Remove OpenAI lock-in, make provider configurable | Cost, flexibility, no vendor lock-in |
| Default free engine | llama.cpp | Lightweight, battle-tested, OpenAI-compatible API, streaming, JSON grammars |
| Default free model | Qwen3-4B (Q5_K_M quantization) | Best all-rounder for all 5 tasks at ~3-4GB RAM |
| NOT using PicoClaw | It's a standalone chat bot, not an embeddable component | No API, no SQL capability, wrong tool |
| NOT using PicoLM | Only runs 1B models, no HTTP API, no streaming | Too limited for our 5 tasks |
| NOT using Ollama | Too heavy (~200MB+) as a production dependency | We only need the engine, not the manager |
| Architecture | Keep 3 layers (widget, agent, cloud service) | Cloud service must stay framework-agnostic for future Django/Laravel/Node agents |
| Monetization | Free tier (self-hosted LLM) + Paid tier (our hosted endpoint) | Open-core model, proven at scale |
