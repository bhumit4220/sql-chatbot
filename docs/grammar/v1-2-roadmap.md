# V1.2 Roadmap — Problems and Solutions

Every issue surfaced during the 9-app DB-verified test sweep, paired with a concrete fix.

---

## P1 — Confidently wrong answers (highest priority)

### 1. PG reserved-word collision (Gitea `user` table → "1" vs real 9) — ✅ DONE 2026-04-24

- **Problem:** Compiler emitted unquoted identifiers. `SELECT COUNT(*) FROM user` was parsed as `SELECT COUNT(*) FROM CURRENT_USER` → silently returned 1 row.
- **Solution shipped:** Added `q(name)` and `qc(table, col)` helpers in primitives.ts + primitives.rb. All primitives, modifiers, JOIN clauses, soft-delete injection now emit `"table"."col"`. Both regression tests added: TS + Ruby assert `SELECT COUNT(*) FROM "user"` form.
- **Verified live:** Gitea now returns `SELECT COUNT(*) FROM "user"` → 9 users (correct). Tests: 347 npm + 392 Rails = 739 passing.
- **Commit:** `182626c`

### 2. Table-name collision / disambiguation (Taiga `projects_projecttemplate` answered for "projects" → 2 vs real 0) — ✅ DONE 2026-04-24

- **Problem:** Both entities scored 0; rowCount tiebreaker picked the (wrong) template table.
- **Solution shipped:** Tokenize entity name on `_`, score each token against question (singular + plural forms via word boundary match). Sort by score, then by fewer name segments, then rowCount. Both TS and Ruby.
- **Verified live:** Taiga "how many projects" → `SELECT COUNT(*) FROM "projects_project"` → 0 (correct).
- **Commit:** `d95cdbf`. Tests: 742 passing (+3 new).

### 3. Plausible-but-wrong fundamental risk — ✅ DONE 2026-04-24 (sanity check landed)

- **Problem:** Generated SQL runs without error but the value is wildly wrong (e.g., 1 instead of 9). User has no signal.
- **Solution shipped:** Post-execute sanity check compares COUNT result to registry's known rowCount. Mismatch (>3x off, when known >5) → fall through to LLM. Both TS + Ruby paths.
- **Bonus:** TS Orchestrator grammar branch reordered to validate+execute+sanity-check BEFORE emitting `grammar_matched` event. User never sees a broken grammar response.
- **Verified:** 7 TS + 6 Ruby unit tests cover threshold logic. Live: Gitea sanity-check passes (9 = 9). Future "plausible but wrong" bugs caught universally.
- **Commit:** `4f8e7ae`. Tests: 755 passing (+13 new).

---

## P2 — Registry naming-convention gaps

### 4. Django plural-app naming (Taiga `userstories_userstory`, `epics_epic`) — ✅ DONE 2026-04-24

### 5. TypeORM `_entity` suffix (n8n `workflow_entity`, `tag_entity`) — ✅ DONE 2026-04-24

### 6. Keycloak prefix-naming (`keycloak_role`, `keycloak_group`) — ✅ DONE 2026-04-24

- **Solution shipped (all three in one drop):** Extended `registry-loader.ts` alias loop with three new rules:
  1. `singularize(prefix) === suffix` → expose suffix + plural (`userstories_userstory` → `userstory`/`userstories`)
  2. `last segment === "entity"` → expose stem (`workflow_entity` → `workflow`/`workflows`)
  3. Pre-pass detects common prefixes shared by 5+ entities → expose stripped form (`keycloak_role` → `role`/`roles`)
- **Plus** entity-candidate scoring upgrade: whitespace-collapsed length-weighted match so "user stories" → `userstories_userstory` wins over `users_user` (longer match dominates).
- **Live-verified across 3 apps, 9 questions, all grammar-matched:**
  - Taiga: user stories / epics / milestones
  - n8n: workflows / tags / credentials
  - Keycloak: users (user_entity) / roles (keycloak_role) / groups (keycloak_group)
- **Commit:** `7e036d1`. Tests: 759 passing (+4 new).

---

## P3 — Real-user phrasing handling (the 100% → 10-40% drop)

### 7. Vague intent on human phrasing ("how's the team doing", "biggest project we got")

- **Problem:** Intent extractor refuses or guesses wrong on slang/vague questions.
- **Solution (multi-part):**
  a) **Add a "primitive: ASK_CLARIFY" output** to intent extractor for ambiguous questions. UI prompts user to disambiguate.
  b) **Improve system prompt** with examples of slang/vague questions mapped to primitives.
  c) **Fuzzy entity matching** (Levenshtein distance ≤2) for typo tolerance — "ordrs" → "orders", "agnts" → "agents".
- **Effort:** 2-3 hours.

### 8. LLM fallback silent SQL errors reach user (Redmine "any issues piling up" → `syntax error at or near "is"`)

- **Problem:** Fallback LLM generated SQL with reserved-word alias; PG error rendered as the answer.
- **Solution:** In `handleData` fallback path, on PG error:
  a) Retry once with error message as feedback (already done for column errors — extend to syntax errors and missing-table errors).
  b) If retry still errors, render `"I couldn't answer that, can you rephrase?"` instead of the raw PG error.
- **Effort:** 1 hour.

### 9. LIST results truncated / one row lost in answer LLM (Chatwoot "5 labels listed as 4")

- **Problem:** Answer-stream LLM occasionally drops items when listing.
- **Solution:** For LIST primitives that return ≤10 rows, render a fixed template programmatically (`The X are: a, b, c, ...`) instead of streaming through answer LLM.
- **Effort:** 1 hour.

---

## P4 — App-specific convention parsing

### 10. `custom_context` not honored by grammar (MSP `status=3 = deleted`)

- **Problem:** Developer wrote conventions in `c.custom_context`; grammar ignores it.
- **Solution:** Parse `custom_context` for patterns like `{table}.{column} = {value}` and `<column> means <semantic>`. Feed parsed rules into registry as additional aliases / scopes.
- **Effort:** 1.5-2 hours.

### 11. Bare-int columns not detected as enums (Chatwoot agent roles, MSP coupon_type)

- **Problem:** Magic-int columns aren't declared as Rails enums; data profiler runs but its findings don't reach `Field.enumValues`.
- **Solution:** Wire data profiler output into registry: for any int column with ≤8 distinct values across ≤50% of rows, register the values as `enumValues`.
- **Effort:** 1 hour.

---

## P5 — Deployment / embedding

### 12. CSP / Trusted Types blocks widget (Mattermost, Directus, Umami, Miniflux)

- **Problem:** Strict cross-origin policies prevent `<script src="http://chatbot-server/widget.js">`.
- **Solution:**
  a) **Server-side mount middleware**: Rails gem (exists ✓). Add **Django middleware** + **Next.js handler** + **Express middleware** (Express exists ✓) so widget is served from app origin.
  b) **Reverse-proxy recipes doc** (one page): nginx/Caddy/Cloudflare snippets that proxy `/chatbot/*` to the chatbot server. Covers any app that can configure its proxy.
- **Effort:** Middleware = ~1 day each. Recipes doc = 1 hour.

### 13. Widget tries to fetch `/chatbot-manifest.json` from host origin (404)

- **Problem:** Stale relative path in widget.
- **Solution:** Use `${baseUrl}/api/manifest` consistently in widget source.
- **Effort:** 15 min.

---

## P6 — Test methodology

### 14. Test results inflated by schema-perfect questions

- **Problem:** "How many users" hides UX issues real users would hit.
- **Solution:** All future test fixtures must use realistic phrasing (typos, slang, vague). Each fixture has 8+ questions of mixed phrasing types. Saved as memory feedback.
- **Effort:** Already done — `feedback_human_phrased_questions` memory.

### 15. Test results inflated by eyeballing answers

- **Problem:** Widget answer text "looked plausible" but wasn't DB-verified.
- **Solution:** Every test fixture must include `ground_truth_sql` per question. Test runner runs both, compares, marks correct/wrong.
- **Effort:** Methodology change. Saved as memory feedback.

### 16. Time-sensitive answers data-drift between test runs

- **Problem:** "Earnings this year" returns different number depending on when test runs.
- **Solution:** For time-sensitive questions, capture chatbot answer + ground truth in the **same session** (snapshot DB state once per test session).
- **Effort:** Test runner change, ~1 hour.

---

## Already fixed in V1.1 (committed on branch)

| Issue | Status |
|---|---|
| TOP_N + order_by duplicate ORDER BY clauses | ✓ Fixed (template_compiler absorbs modifiers) |
| `order_by` crash on undefined direction | ✓ Fixed (defaults to "desc") |
| Field aliasing (rating → avg_rating) | ✓ Fixed in RegistryBuilder |
| Entity aliasing (service areas → service_area) | ✓ Fixed |
| Django prefix `<app>_<model>` (basic case) | ✓ Fixed |
| Grammar SQL execution error reaches user | ✓ Fixed (validation+exec before grammar_matched event, falls through to LLM on error) |
| Widget UI race condition (skipped questions) | ✓ Fixed in test harness (wait for button-not-disabled) |

---

## Priority recommendation

**Fix in this order for max bang/buck:**

1. **#1 quote identifiers** — 30 min, prevents silent corruption universally
2. **#2 entity disambiguation** + **#4 Django plurals** + **#5 TypeORM `_entity`** — together ~2 hours, lifts naming-convention apps significantly
3. **#3a sanity-check counts vs reltuples** — 1 hour, catches "plausible but wrong" class
4. **#8 fallback graceful error** + **#9 list truncation** — 2 hours, removes user-visible errors
5. **#7 fuzzy entity matching + ASK_CLARIFY** — 3 hours, addresses the human-phrasing gap
6. **#10 custom_context parsing** + **#11 data-profiler-to-enum** — 3 hours, MSP-style apps jump in accuracy
7. **#12 reverse-proxy doc** (1 hour) → unblocks all CSP-locked apps; **Django middleware** later

**Total fast-track effort to production-ready V1.2: ~12-15 hours.**
