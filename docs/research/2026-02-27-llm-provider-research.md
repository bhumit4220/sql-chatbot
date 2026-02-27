# LLM Provider Research — Findings & Recommendations

> **Date:** 2026-02-27
> **Branch:** feature/llm-provider-agnostic
> **Status:** Research complete, parked for later. Moving to V1 release.

---

## Context

We're making the cloud service LLM-provider-agnostic. The original plan defaulted to **Qwen3-4B via llama.cpp** as the free local option. This research investigated whether that's the right choice, given concerns about RAM usage (~3.2GB) and concurrent request handling (only 2-3 users on a 4-core CPU).

---

## Key Finding: CPU Throughput Has a Hard Ceiling

On a 4-core CPU, llama.cpp produces **~10-11 tokens/second total** regardless of how many parallel slots you configure. Adding `--parallel 4` doesn't create more throughput — it divides the same speed among more users.

| Concurrent Users | Tok/s Per User (4B) | Tok/s Per User (1.7B) | Experience |
|-----------------|---------------------|----------------------|------------|
| 1 | 10-11 | 15-25 | Good |
| 2 | 5-6 | 8-12 | Acceptable |
| 4 | 2-3 | 4-6 | Slow |
| 8 | 1-2 | 2-3 | Poor |
| 16+ | <1 | 1-2 | Unusable |

---

## Models Evaluated

### Viable Options

| Model | Params | GGUF Size (Q4_K_M) | RAM | SQL Capability | All 5 Tasks? | Speed (4-core CPU) |
|-------|--------|--------------------|----|----------------|-------------|-------------------|
| **Qwen3-4B** | 4B | 2.5GB (Q5_K_M: 3.2GB) | ~4GB | Good | Yes | ~8-12 tok/s |
| **Qwen3-1.7B** | 1.7B | 1.28GB | ~1.8GB | Moderate | Yes | ~15-25 tok/s |
| **Qwen3-0.6B** | 0.6B | 0.48GB | ~0.7GB | Poor (classify only) | No | ~25-40 tok/s |

### Evaluated and Rejected

| Model | Why Rejected |
|-------|-------------|
| Phi-4-mini (3.8B) | Same size class as Qwen3-4B, no RAM savings. GGUF actually larger (4.5GB). |
| SmolLM3-3B | Close to Qwen3-4B in RAM. No SQL benchmarks. Less community validation. |
| Ministral-3-3B | Still 3B, modest RAM savings. Mistral underperforms Qwen on coding at same size. |
| Gemma 2 2B | Weaker than Qwen3-1.7B on general reasoning. SQL fine-tune (GEMMA-SQL) loses general capabilities. |
| Qwen3.5-35B-A3B (MoE) | Incredible performance but needs ~21-24GB RAM. MoE = all experts must fit in memory even though only 3B active per token. |

### SQL Accuracy Benchmarks (Sub-3B)

| Approach | Benchmark | Accuracy |
|----------|-----------|----------|
| GEMMA-SQL (Gemma 2B fine-tuned) | Spider | 66.8% |
| MATS (multi-agent, 1B components) | Spider | 87.1% |
| GPT-4o-mini (our current) | BIRD | ~41-50% |

Key insight: Multi-agent systems with small models can outperform single large models on SQL.

---

## Inference Engines Evaluated

| Engine | CPU Concurrency | OpenAI-Compatible API | Verdict |
|--------|----------------|----------------------|---------|
| **llama.cpp** (current choice) | 2-3 users (4B), 3-5 (1.7B) | Yes | Best for CPU. Keep it. |
| Ollama | Same as llama.cpp (wraps it) | Yes | Adds 200MB+ overhead, no speed gain. |
| vLLM | Not designed for CPU | Yes | GPU-only in practice. |
| MLC LLM | Comparable to llama.cpp | No (needs adapter) | No advantage, less community. |
| LocalAI | Wraps llama.cpp | Yes | API wrapper, no throughput gain. |

---

## Free Cloud Tiers (OpenAI-Compatible)

| Provider | Free Limit | Speed | OpenAI API | Credit Card |
|----------|-----------|-------|------------|-------------|
| **Groq** | 14,400 req/day | ~500+ tok/s | Yes | Not required |
| **Cerebras** | 30 RPM, 1M tok/day | ~2,600 tok/s | Yes | Not required |
| **OpenRouter** | 29+ free models | Varies | Yes | Not required |
| Cloudflare Workers AI | 100K req/day | Varies | Partial | Not required |

Groq and Cerebras are **massively faster** than local CPU — they do in 0.1s what a 4-core CPU does in 10s.

---

## Recommended Architecture

### Option C: Hybrid Local + Cloud (Best Overall)

```
Normal traffic (1-5 users):
  Cloud Service → llama.cpp + Qwen3-1.7B locally (free, 1.3GB RAM)

Overflow / high traffic:
  Cloud Service → Groq or Cerebras free tier (14,400 req/day, OpenAI-compatible)
```

| Metric | Local Only (4B) | Local Only (1.7B) | Hybrid (1.7B + Cloud) |
|--------|----------------|-------------------|----------------------|
| Model RAM | 3.2GB | 1.3GB | 1.3GB |
| Concurrent users | 2-3 | 3-5 | 5-20+ |
| SQL quality | Good | Moderate | Good (cloud = 8B+ models) |
| Monthly cost | $0 | $0 | $0 (within free tiers) |
| Vendor lock-in | None | None | Low (local is fallback) |

### Phase 2 Optimization: Multi-Model Routing

Use different models for different tasks (our code already routes by question type):

| Task | Model | RAM | Rationale |
|------|-------|-----|-----------|
| Classify + Unsafe blocking | Qwen3-0.6B | 0.5GB | Simple pattern matching |
| SQL + Answers + Navigation | Qwen3-1.7B | 1.3GB | Needs reasoning |

Total: ~1.8GB. Add this later — not needed for V1.

---

## Implementation Plan Status

The implementation plan at `docs/plans/2026-02-26-llm-provider-agnostic.md` is **reviewed, audited, and ready to execute**. It covers:

1. Refactoring `openai.ts` → `client.ts` with env var support
2. Updating all routes and server initialization
3. Unit tests + integration test updates
4. `.env.example` with all provider configs
5. llama.cpp local setup + E2E testing
6. Prompt adjustments for smaller models

**What to update when we return to this:**
- Default model: consider Qwen3-1.7B instead of Qwen3-4B
- Add Groq as recommended cloud option in `.env.example`
- Overflow routing (local → cloud fallback) as a separate feature

---

## Sources

- [vLLM or llama.cpp: Choosing the Right Engine](https://developers.redhat.com/articles/2025/09/30/vllm-or-llamacpp-choosing-right-llm-inference-engine-your-use-case)
- [Ollama vs llama.cpp vs vLLM: 2026 Comparison](https://www.decodesfuture.com/articles/llama-cpp-vs-ollama-vs-vllm-local-llm-stack-guide)
- [CPU-only LLM Inference Benchmark](https://tiffena.me/blog/llm-cpu-only-inference-benchmark-llama.cpp-server-flags/)
- [llama.cpp Parallelization Discussion](https://github.com/ggml-org/llama.cpp/discussions/4130)
- [llama.cpp Parallelism on A40 GPUs](https://medium.com/@ferraricorneloup.teo/how-many-developers-can-one-gpu-serve-benchmarking-llama-cpp-parallelism-on-a40-gpus-0ea2a8c36045)
- [Optimal Parallel Inference Parameters](https://github.com/ggml-org/llama.cpp/discussions/18308)
- [Free LLM APIs 2026](https://www.analyticsvidhya.com/blog/2026/01/top-free-llm-apis/)
- [Groq Pricing](https://groq.com/pricing)
- [Cerebras Pricing](https://www.cerebras.ai/pricing)
- [OpenRouter Free Models](https://openrouter.ai/collections/free-models)
- [Qwen3-1.7B GGUF](https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF)
- [Qwen3 Technical Report](https://arxiv.org/html/2505.09388v1)
- [GEMMA-SQL Paper](https://arxiv.org/abs/2511.04710)
- [MATS Multi-agent SQL Framework](https://arxiv.org/html/2512.18622v1)
- [Running LLMs on Edge Devices](https://www.sitepoint.com/llms-raspberry-pi-edge/)
- [Qwen llama.cpp Docs](https://qwen.readthedocs.io/en/latest/run_locally/llama.cpp.html)
