# MSP Web — sql-chatbot-rails Gem Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old `chatbot_agent` V3 gem with the new `sql-chatbot-rails` gem in the msp-web-copy Rails project, verifying end-to-end that schema discovery, code indexing, widget serving, and chat all work on a real 53-table PostgreSQL database.

**Architecture:** Swap gem reference in Gemfile, replace the initializer with SqlChatbot.configure, update routes to mount the new engine, and update the admin layout to load the widget from the engine's `/chatbot/widget.js` route instead of an external localhost URL.

**Tech Stack:** Ruby 2.7.1, Rails 6.0.3, PostgreSQL (msp_development_jan_08_live_dump, 53 tables), Devise auth.

**Projects:**
- Gem: `/home/sotsys-322/Ruby Projects/sql-chatbot/sql-chatbot-rails/`
- Target: `/home/sotsys-322/Ruby Projects/msp-web-copy/`

**Key constraints:**
- msp-web-copy uses Ruby 2.7.1. The gem currently requires `>= 3.1.0` but all code parses cleanly under 2.7.1 and all dependencies (ruby-openai, pg) support 2.7.1. Task 1 lowers the requirement.
- MSP has non-standard FKs (`jobs.created_by` → `customers.id`), `status=3` soft deletes, and polymorphic associations that need custom context injected into prompts. Task 2 adds a `custom_context` config option to the gem.
- Database uses Makara (read replica adapter). `SqlExecutor` issues `SET statement_timeout` before `BEGIN` — both calls should route to the same backend in local dev (both point to localhost), but this is a production concern to verify.

**Rollback:** If integration fails: revert Gemfile line 115 to `chatbot_agent`, run `bundle install`, revert routes and initializer, restart server.

---

## Chunk 1: Gem Compatibility Fixes (on feature/rails-gem branch)

### Task 1: Lower Ruby version requirement in gemspec — DONE (d2571dd)

### Task 2: Add `custom_context` config option to gem — DONE (9807b69)

---

## Chunk 2: Wire Up in msp-web-copy — ALL DONE

### Task 3: Replace old gem with new gem in Gemfile — DONE
### Task 4: Replace initializer — DONE
### Task 5: Update routes — DONE
### Task 6: Update admin layout — widget script — DONE

---

## Chunk 3: Verification — ALL DONE

### Task 7: Verify with curl
- [x] Health endpoint: `GET /chatbot/api/health` → `{"status":"ok","tables":54,"codeFiles":828}`
- [x] Widget: `GET /chatbot/widget.js` → 200 OK, serves React IIFE

### Task 8: Start Rails server and verify health endpoint — DONE

### Task 9: Test widget and chat in browser — DONE
- [x] Widget loads in MSP admin dashboard (closed Shadow DOM)
- [x] Chat panel opens via FAB button click
- [x] **Customer count test (curl):** classify=data → SQL `SELECT COUNT(*) ... WHERE deleted_at IS NULL AND status != 3` → 3,389 customers
- [x] **Non-standard FK test (curl):** `JOIN customers c ON j.created_by = c.id` — custom_context works perfectly
- [x] **Widget chat test:** Sent "How many active jobs are there?" via CDP, received streamed answer in widget panel

### Task 10: Test with alternative provider
- [x] Switched from OpenRouter (free, rate-limited) to OpenAI gpt-4o-mini — fast, reliable
- [ ] Groq provider test — skipped (OpenAI gpt-4o-mini working well)

### Additional fix: CSRF protection
- [x] Fixed `ActionController::InvalidCrossOriginRequest` by using `skip_forgery_protection` instead of just `skip_before_action :verify_authenticity_token` (commit 745214a)
