# V1.2 Roadmap — Problems and Solutions

Every issue surfaced during the 9-app DB-verified test sweep, paired with a concrete fix.

---

## P1 — Confidently wrong answers (highest priority)

### 1. PG reserved-word collision (Gitea `user` table → "1" vs real 9) — ✅ DONE 2026-04-24

- **Problem:** Compiler emitted unquoted identifiers. `SELECT COUNT(*) FROM user` was parsed as `SELECT COUNT(*) FROM CURRENT_USER` → silently returned 1 row.
- **Solution shipped:** Added `q(name)` and `qc(table, col)` helpers in primitives.ts + primitives.rb. All primitives, modifiers, JOIN clauses, soft-delete injection now emit `"table"."col"`. Both regression tests added: TS + Ruby assert `SELECT COUNT(*) FROM "user"` form.
- **Verified live:** Gitea now returns `SELECT COUNT(*) FROM "user"` → 9 users (correct). Tests: 347 npm + 392 Rails = 739 passing.
- **Commit:** `182626c`

### 2. Table-name collision / disambiguation (Taiga `projects_projecttemplate` answered for "projects" → 2 vs real 0)

- **Problem:** Entity-candidate selection picks the highest-scoring partial match. "projects" matched both `project` and `projecttemplate`.
- **Solution:** In `entity-candidates.ts`, prefer entities whose name **exactly** equals the question term (or its singular form) before substring matches. Add tie-breaker: prefer fewer underscore segments (simpler name).
- **Effort:** 1 hour; new test cases: "how many projects" with both `projects_project` and `projects_projecttemplate` in registry → must pick `projects_project`.

### 3. Plausible-but-wrong fundamental risk

- **Problem:** Generated SQL runs successfully but the *interpretation* is wrong (Gitea reserved word, Taiga template-vs-project). User has no signal.
- **Solution (defense-in-depth):**
  a) **Sanity check**: for COUNT primitives, compare result against `pg_class.reltuples` — if result is wildly off (e.g., COUNT returns 1 but reltuples shows 9), surface a warning bubble.
  b) **Confidence indicator** in widget answer: show the SQL that was run + a "verify in DB" link.
  c) **Telemetry**: log every COUNT result alongside reltuples; review for outliers.
- **Effort:** 3-4 hours; (a) is the highest-value piece — would have flagged the Gitea bug immediately.

---

## P2 — Registry naming-convention gaps

### 4. Django plural-app naming (Taiga `userstories_userstory`, `epics_epic`)

- **Problem:** Existing `<app>_<model>` alias only strips when prefix === suffix exactly.
- **Solution:** Extend alias rule in `registry-loader.ts`: if `singularize(prefix) === suffix`, register stripped form as alias. Covers `userstories_userstory → user_story`, `epics_epic → epic`, etc.
- **Effort:** 30 min + tests.

### 5. TypeORM `_entity` suffix (n8n `workflow_entity`, `tag_entity`)

- **Problem:** Entity name in registry includes `_entity` suffix; LLM says `entity:'workflow'` and registry lookup fails.
- **Solution:** In schema-only registry: if entity name ends with `_entity`, also register the stripped form (`workflow`) as an alias. Same pattern as Django prefix fix.
- **Effort:** 15 min single rule.

### 6. Keycloak prefix-naming (`user_entity`, `keycloak_role`, `keycloak_group`)

- **Problem:** Domain prefix on entities (`keycloak_role`) blocks LLM term match for "roles".
- **Solution:** Detect common prefix across multiple table names; register stripped aliases. If 5+ tables share `keycloak_` prefix, alias `keycloak_X` → `X`.
- **Effort:** 1 hour.

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
