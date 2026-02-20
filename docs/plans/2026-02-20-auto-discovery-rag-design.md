# Auto-Discovery RAG + Smart Widget Context — Design Document

> **Date**: 2026-02-20
> **Status**: Final (v6 — three audits complete, all fixes applied: C1-C6, I2-I9, M1-M7, N1-N4, G1-G6)
> **Depends on**: Phase 1-8 complete (core chatbot deployed)

## Problem

The chatbot has TWO fundamental problems:

### Problem 1: Database Queries Fail (Data Questions)
The chatbot requires **manual knowledge base entries** for every project. For example, MSP uses integer enums (status=1 means "Active", status=3 means "Deleted"), and without manually telling the chatbot this, it generates broken SQL like `WHERE status = 'active'` instead of `WHERE status = 1`.

### Problem 2: Guidance Answers Are Garbage (Navigation/How-To Questions)
When an admin asks "where can I see all contractors?", the chatbot gives generic internet advice ("check your company's database system, public records...") instead of saying "Go to the Contractors page in the left sidebar." This is because:
- The chatbot has **zero knowledge** about the admin panel's pages, menus, or features
- The widget sends **no page context** — just the question text and session ID
- The knowledge base is empty (requires manual entries nobody wants to write)
- The LLM hallucinates because it has no context to work with

Both problems share the same root cause: **the chatbot knows nothing about the application it's embedded in.**

## Goal

**Connect any database + embed the widget → chatbot auto-discovers everything → answers BOTH data AND guidance questions correctly. Zero manual setup.**

Specifically:
- Auto-discover column types, foreign keys, constraints, indexes, comments
- Auto-discover enum-like values by sampling actual data (without exposing PII)
- Auto-discover relationships (explicit FKs + inferred from naming conventions)
- **Auto-discover admin panel navigation** by having the widget read the page's DOM
- Use RAG (Retrieval-Augmented Generation) to feed only relevant context per question
- Support multi-step exploration when the LLM is uncertain
- **Handle all question types**: data queries, navigation, how-to, ambiguous, follow-ups, and "I don't know"

## How Admins Actually Talk to the Chatbot — Complete Taxonomy

Admins are non-technical. They will ask **literally anything**. Every question type needs a defined handling strategy.

### Category 1: Data Queries (→ SQL)
These need: schema + enum values + relationships (RAG auto-discovery)

| Example | Handling |
|---------|----------|
| "how many active contractors?" | SQL with `WHERE status = 1` (enum from RAG) |
| "show me jobs from last week" | SQL with date calculation (inject current date into prompt) |
| "which contractor has the most completed jobs?" | SQL with JOIN + GROUP BY |
| "compare this month vs last month revenue" | SQL with date ranges |
| "tell me about contractor John Smith" | SQL search by name |
| "contrcators pending" (typo) | LLM handles typos naturally |
| "top 10 highest earning contractors" | SQL with ORDER BY + LIMIT |
| "jobs with no contractor assigned" | SQL with NULL check |

### Category 2: Navigation (→ Page Context)
These need: widget's DOM-scraped navigation + current page URL

| Example | Handling |
|---------|----------|
| "where can I see contractors?" | Point to Contractors link from navigation |
| "where do I find payments?" | Point to Payments link from navigation |
| "take me to settings" | Point to Settings link (can't navigate, but show URL) |
| "how do I get back to dashboard?" | Point to Dashboard link |

### Category 3: How-To Workflows
These need: navigation context + knowledge of what each page does

| Example | Handling |
|---------|----------|
| "how do I create a new job?" | Point to Jobs → New Job page from navigation. Explain that the page has a form to fill out. |
| "how do I approve a contractor?" | Point to Contractors page. Explain pending contractors can be approved there. |
| "how do I issue a refund?" | Point to Disputes page. Explain refund process. |
| "how do I send a notification?" | Point to Notifications page. |

**Strategy**: The LLM can infer basic workflows from page names + DB structure. For example, if navigation has "Contractors → Pending" and the DB has a status enum, the LLM can say "Go to Contractors → Pending, then click Approve." For complex multi-step workflows, the manual knowledge base can supplement.

### Category 4: Business Logic / Concepts
These need: DB schema (table/column names tell a story) + RAG context

| Example | Handling |
|---------|----------|
| "what is the bid system?" | Infer from tables: `jobs` has `service_type` enum with Bid=2, tables like `bid_*` |
| "how does recurring dispatch work?" | Infer from `recurring_*` tables, dispatch-related columns |
| "what's the difference between bid and hourly jobs?" | Infer from `service_type` enum values + table structures |
| "what statuses can a job have?" | From RAG: enum_values document for jobs.status |
| "what payment methods do we support?" | From DB tables: `cards`, `wallets`, Stripe-related columns |

**Strategy**: The RAG documents (table summaries, enum values, relationships) give the LLM enough context to explain most business concepts. The LLM can say "Based on your database, jobs have these statuses: 1, 2, 3... and these service types: Quoted, Bid, Hourly."

### Category 5: Troubleshooting
These need: DB querying + status enum knowledge

| Example | Handling |
|---------|----------|
| "why can't I see this contractor?" | Query contractor status → might be Deleted (3) or Inactive (2) |
| "this payment failed, why?" | Query payment record status/error fields |
| "the job isn't showing up" | Query job status → might be Deleted or Cancelled |
| "customer says they can't login" | Query customer status → might be Inactive or Deleted |

**Strategy**: Classify as data question + explain. LLM generates a query like `SELECT status, ... FROM contractors WHERE id = X` then explains what the status value means.

### Category 6: Current Page Context
These need: widget's current URL + heading

| Example | Handling |
|---------|----------|
| "what does this page do?" | Explain based on current URL/heading |
| "what am I looking at?" | Describe the current page |
| "what can I do here?" | List actions available on current page (inferred from page name) |

### Category 7: Ambiguous Questions
These need: smart classification + offer both options

| Example | Handling |
|---------|----------|
| "show me contractors" | "You can view contractors in the sidebar (Contractors page). Or if you'd like me to list contractor data from the database, let me know what you're looking for." |
| "contractors" (just a word) | Ask for clarification: "Would you like me to show you the Contractors page, or query contractor data?" |
| "jobs" | Same — offer both navigation and data options |

### Category 8: Follow-ups & Corrections
These need: conversation history (already have 10-message cap)

| Example | Handling |
|---------|----------|
| "now filter by active only" | Use previous query context + add WHERE status = 1 |
| "no, I meant hourly jobs not bid" | Correct previous query |
| "show me more details" | Expand on previous answer |
| "and how many of those are in New York?" | Add location filter to previous query |

**Strategy**: Conversation history (last 10 messages) is already sent to the LLM. This works naturally.

### Category 9: Action Requests (Must Refuse)
These need: clear refusal + point to the right page

| Example | Handling |
|---------|----------|
| "delete contractor #123" | "I'm a read-only assistant — I can't modify data. You can manage contractors from the Contractors page (/admin/contractors)." |
| "approve all pending contractors" | Refuse, point to Pending Contractors page |
| "send a notification to all users" | Refuse, point to Notifications page |
| "change this job's status" | Refuse, point to the job detail page |
| "create a new customer" | Refuse, point to Customers → New page |

### Category 10: Off-Topic / Unknown
These need: graceful rejection — NEVER hallucinate

| Example | Handling |
|---------|----------|
| "what's the weather?" | "I'm an admin assistant for this application. I can help with database queries and navigating the admin panel. What would you like to know?" |
| "tell me a joke" | Same — redirect to purpose |
| "how do I set up Stripe?" | "I don't have specific documentation about Stripe setup. You might want to check Stripe's documentation or contact your developer." |
| "why is the server slow?" | "I don't have access to server performance metrics. You might want to check with your system administrator." |

### Category 11: Meta Questions (About the Chatbot)
These need: self-description injected into prompt

| Example | Handling |
|---------|----------|
| "what can you do?" | List capabilities: "I can query your database, help you find pages in the admin panel, explain business concepts, and troubleshoot issues." |
| "help" | Same — show capabilities |
| "how do I use this?" | "Just ask me a question! For example: 'How many active contractors do we have?' or 'Where can I find the payments page?'" |

### Category 12: Emotional / Frustrated
These need: empathy + problem-solving

| Example | Handling |
|---------|----------|
| "this stupid system isn't working!" | "I'm sorry you're having trouble. Can you tell me what specifically isn't working? I might be able to help you find the right page or check the data." |
| "nothing works" | "I understand that's frustrating. Let me help — what were you trying to do?" |
| "ugh" | "Seems like something's not going well. What can I help you with?" |

### Category 13: Multi-Language
GPT-4o-mini naturally handles multiple languages. If the admin asks in Hindi, the response should be in Hindi.

| Example | Handling |
|---------|----------|
| "kitne active contractors hain?" | Reply in Hindi with the data |
| "¿cuántos trabajos hay?" | Reply in Spanish |

**Strategy**: No code change needed — LLM handles this naturally. Add instruction to prompt: "Respond in the same language the admin uses."

### Category 14: Complex / Multi-Part Questions

| Example | Handling |
|---------|----------|
| "show me active contractors in New York with more than 10 jobs" | Complex SQL with JOINs and multiple filters |
| "what are the top 5 job types and how much revenue each generated?" | SQL with GROUP BY + SUM |
| "list customers who signed up this month but haven't placed a job" | SQL with LEFT JOIN + NULL check |

**Strategy**: These are data questions — RAG provides the schema context, LLM generates the SQL.

### Category 15: Date-Relative Queries
These need: current date/time injected into the prompt

| Example | Handling |
|---------|----------|
| "jobs from last week" | LLM needs to know today's date to calculate "last week" |
| "this month's earnings" | Same — needs current date |
| "how many customers signed up today?" | Same |

**Strategy**: Inject `Current date and time: {datetime.now()}` into the system prompt.

### Category 16: Export / Report Requests

| Example | Handling |
|---------|----------|
| "export all contractors to CSV" | "I can't generate file exports, but you can export from the Contractors page (/admin/contractors) — look for the Export button." |
| "give me a report of last month's revenue" | Can answer with data (SQL query), but can't format as a downloadable report |
| "show me a chart of jobs per month" | "I can give you the data, but I can't create charts. Here's the data: ..." |

### Summary: What Each Question Type Needs

| Category | Needs | Source |
|----------|-------|--------|
| Data queries | Schema + enums + relationships | RAG auto-discovery |
| Navigation | Page URLs and menu items | Widget DOM scraping |
| Workflows | Page names + basic page purpose | Widget nav + LLM inference |
| Business logic | Table/column names + enum values | RAG auto-discovery |
| Troubleshooting | DB querying + status knowledge | RAG + SQL execution |
| Current page | URL + heading + title | Widget page context |
| Ambiguous | Both data + nav options | Combined |
| Follow-ups | Conversation history | Already built (10-msg cap) |
| Action requests | Clear refusal + right page link | Widget nav + prompt rules |
| Off-topic | Graceful rejection | Prompt rules |
| Meta / help | Capability description | Static prompt text |
| Emotional | Empathy + redirect | Prompt rules |
| Multi-language | LLM natural ability | Prompt instruction |
| Complex queries | Full schema context | RAG auto-discovery |
| Date-relative | Current date/time | Injected into prompt |
| Export/reports | Refusal + point to page | Widget nav + prompt rules |

### What Needs CODE Changes vs. Just Better Prompting

**Code changes required:**
- Widget DOM scraping (Component 0) — for navigation, page context
- RAG auto-discovery (Components 1-8) — for database knowledge
- `ChatRequest` schema update — to accept `page_context`
- Current datetime injection — add `datetime.now()` to prompt

**Prompt engineering only (no code beyond the prompt text):**
- Off-topic rejection
- Action request refusal
- Meta/capability description
- Emotional handling
- Multi-language instruction
- Export/report handling
- Ambiguity handling
- "I don't know" behavior

## Current Architecture (What Exists)

### Schema Inspector (`app/services/schema_inspector.py`)
- Uses SQLAlchemy `inspect()` to get table names and column names
- **Does NOT extract**: column types, foreign keys, constraints, comments, indexes
- Output format: `TABLE contractors (id, first_name, last_name, email, status)`
- Cached in `projects.schema_cache` (TEXT column), refreshed every 24 hours

### Knowledge Base (`app/services/knowledge_service.py`)
- Manual CRUD API for entries with categories: navigation, workflow, concept, faq
- All active entries loaded and injected into the LLM system prompt as markdown
- **Problem**: requires manual population per project

### LLM Query Flow (`app/api/v1/conversations/router.py`)
1. Load full schema text + all knowledge entries
2. LLM Call 1: Classify question + generate SQL (single shot)
3. Validate SQL (4-layer: sqlparse, keyword blocklist, sqlglot AST, column existence)
4. Execute SQL (READ ONLY transaction)
5. LLM Call 2: Summarize results and stream response

### Widget (`widget/src/ChatWidget.tsx`)
- Sends only `{ question, session_id }` — **no page URL, no navigation context**
- Cannot read widget's own Shadow DOM from the host page, but CAN read the host page's DOM
- Currently has no awareness of where the admin is or what pages exist

### What's Missing
- No column type information → LLM guesses wrong types
- No enum value discovery → LLM uses string values instead of integers
- No relationship information → LLM doesn't know `jobs.created_by` references `customers.id`
- Full schema dumped every time → wastes tokens for large databases, adds noise
- Single-shot query → no way to explore/clarify before answering
- **No page context** → widget doesn't tell the chatbot what page the admin is on
- **No navigation context** → chatbot doesn't know what pages/menus exist in the admin panel
- **No "I don't know" behavior** → chatbot hallucinates generic answers instead of admitting ignorance
- **No ambiguity handling** → "show me contractors" should ask for clarification, not guess

## Solution: Auto-Discovery RAG + Smart Widget Context

The solution has TWO parts:
1. **Auto-Discovery RAG** (server-side) — auto-discover database schema, enums, relationships → stored in pgvector → retrieved per question
2. **Smart Widget Context** (client-side) — widget reads the host page's navigation/menus/URL from the DOM and sends it with every message → chatbot knows what pages exist and where the admin is

### Overview

```
┌─────────────────────────────────────────────────────────┐
│              WIDGET (runs in admin panel DOM)            │
│                                                         │
│  On every message, widget scrapes from host page:       │
│  ┌──────────────────────────────────────────────┐      │
│  │  • Current page URL + title                   │      │
│  │  • All navigation/sidebar links (text + href) │      │
│  │  • Breadcrumbs (if present)                   │      │
│  │  • Page heading (h1/h2)                       │      │
│  └──────────────────────────────────────────────┘      │
│       │                                                 │
│       ▼                                                 │
│  Sent as `page_context` with each chat message          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  AUTO-DISCOVERY PIPELINE                 │
│         (runs on project creation / re-index)           │
│                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │  Rich     │   │  Data    │   │  Doc     │            │
│  │  Schema   │──▶│  Sampler │──▶│  Chunker │            │
│  │  Inspect  │   │          │   │          │            │
│  └──────────┘   └──────────┘   └──────────┘            │
│       │                              │                  │
│       │  tables, columns,            │  text documents  │
│       │  types, FKs, comments        │  (200-500 tokens │
│       │                              │   each)          │
│       │                              ▼                  │
│       │                        ┌──────────┐            │
│       │                        │  Embed   │            │
│       │                        │  (OpenAI)│            │
│       │                        └──────────┘            │
│       │                              │                  │
│       │                              ▼                  │
│       │                        ┌──────────┐            │
│       │                        │  pgvector│            │
│       │                        │  (store) │            │
│       │                        └──────────┘            │
│       │                                                 │
│       ▼                                                 │
│  schema_cache (kept for SQL validator)                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    QUERY-TIME FLOW                       │
│              (runs on each chat message)                │
│                                                         │
│  User Question + Page Context (from widget)             │
│       │                                                 │
│       ▼                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │  Embed   │───▶│  pgvector│───▶│  Top 15  │          │
│  │  Question│    │  Search  │    │  Docs    │          │
│  └──────────┘    └──────────┘    └──────────┘          │
│                                       │                 │
│                                       ▼                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │  LLM Call 1: Generate SQL                        │  │
│  │  Context: schema + RAG docs + knowledge          │  │
│  │           + PAGE CONTEXT (nav, URL, heading)      │  │
│  │  Returns: SQL + confidence + question_type        │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                 │
│       ├── confidence >= 0.5 ──▶ validate & execute     │
│       │                                                 │
│       └── confidence < 0.5 ──▶ run exploration query   │
│              (max 1 retry)         │                    │
│                                    ▼                    │
│                              ┌──────────┐              │
│                              │  LLM     │              │
│                              │  Call 1b │              │
│                              │  (retry  │              │
│                              │  w/ more │              │
│                              │  context)│              │
│                              └──────────┘              │
│                                    │                    │
│                                    ▼                    │
│                              validate & execute         │
│                              (regardless of confidence) │
│                                    │                    │
│                                    ▼                    │
│                              LLM Call 2: stream answer  │
└─────────────────────────────────────────────────────────┘
```

### Component 0: Smart Widget Page Context

**Modify**: `widget/src/ChatWidget.tsx` + `widget/src/index.ts`
**Modify**: `app/api/v1/conversations/schemas.py` (ChatRequest)

The widget reads the host page's DOM on every message and sends navigation context to the API. This works for ANY admin panel — React, Rails, Django, anything with a web UI.

**What the widget scrapes from the host page:**

```typescript
function getPageContext(): PageContext {
  return {
    url: window.location.href,
    title: document.title,
    heading: document.querySelector('h1, h2')?.textContent?.trim() || null,
    breadcrumbs: Array.from(document.querySelectorAll('[class*="breadcrumb"] a, nav[aria-label="breadcrumb"] a'))
      .map(a => ({ text: a.textContent?.trim(), href: a.getAttribute('href') })),
    navigation: extractNavigation(),
  }
}

function extractNavigation(): NavItem[] {
  // Try multiple common patterns for navigation:
  const navSelectors = [
    'nav a',                           // semantic nav elements
    '[class*="sidebar"] a',            // sidebar navigation
    '[class*="menu"] a',               // menu classes
    '[class*="nav"] a',                // nav classes
    '[role="navigation"] a',           // ARIA role
  ]

  const links = new Set<string>()  // dedup by href
  const items: NavItem[] = []

  for (const selector of navSelectors) {
    document.querySelectorAll(selector).forEach(a => {
      const href = a.getAttribute('href')
      const text = a.textContent?.trim()
      if (href && text && !links.has(href) && href !== '#') {
        links.add(href)
        items.push({ text, href })
      }
    })
  }

  return items
}
```

**What gets sent with each message:**

```typescript
// Updated ChatRequest payload
{
  question: "where can I see all contractors?",
  session_id: "abc-123",
  page_context: {
    url: "https://admin.mowsnowpros.com/admin/dashboard",
    title: "Dashboard | MSP Admin",
    heading: "Dashboard",
    breadcrumbs: [],
    navigation: [
      { text: "Dashboard", href: "/admin/dashboard" },
      { text: "Customers", href: "/admin/customers" },
      { text: "Contractors", href: "/admin/contractors" },
      { text: "Jobs", href: "/admin/jobs" },
      { text: "Bid Jobs", href: "/admin/jobs/bid_jobs" },
      { text: "Properties", href: "/admin/properties" },
      { text: "Payments", href: "/admin/payments" },
      { text: "Earnings", href: "/admin/earnings" },
      { text: "Coupons", href: "/admin/coupons" },
      { text: "Settings", href: "/admin/settings" },
      // ... all sidebar/nav links
    ]
  }
}
```

**Updated `ChatRequest` schema:**

```python
class NavItem(BaseModel):
    text: str
    href: str

class PageContext(BaseModel):
    url: str | None = None
    title: str | None = None
    heading: str | None = None
    breadcrumbs: list[NavItem] | None = None
    navigation: list[NavItem] | None = None

class ChatRequest(BaseModel):
    question: str
    conversation_id: str | None = None
    session_id: str | None = None
    page_context: PageContext | None = None  # NEW
```

**How page context is used in the LLM prompt:**

The page context is formatted as a text section and injected into the system prompt:

```
## Current Page Context
The admin is currently on: Dashboard (https://admin.mowsnowpros.com/admin/dashboard)

## Available Admin Pages (from navigation)
- Dashboard → /admin/dashboard
- Customers → /admin/customers
- Contractors → /admin/contractors
- Jobs → /admin/jobs
- Bid Jobs → /admin/jobs/bid_jobs
- Properties → /admin/properties
- Payments → /admin/payments
- Earnings → /admin/earnings
- Coupons → /admin/coupons
- Settings → /admin/settings
```

**Widget initialization — `document.currentScript` fallback (audit I6):**

The widget's `index.ts` uses `document.currentScript` to read `data-*` attributes (API URL, project key). When the `<script>` tag has `async` or `defer`, `document.currentScript` is `null` at execution time. Fallback strategy:

```typescript
// Try currentScript first, then fall back to querySelector
const scriptEl = document.currentScript
  || document.querySelector('script[data-chatbot-id]')
  || document.querySelector('script[src*="widget.js"]');

if (!scriptEl) {
  console.error('[Chatbot] Could not find widget script element. Ensure the <script> tag has data-chatbot-id attribute.');
  return;
}
```

The `data-chatbot-id` attribute is a new explicit marker that widget users should add. The `src*="widget.js"` fallback handles existing installations without the marker.

**Why this works for ANY project:**
- The widget runs inside the admin panel's DOM — it sees whatever navigation exists
- Semantic selectors (`nav a`, `[role="navigation"]`, `[class*="sidebar"]`) work across frameworks
- If no navigation is found, the widget just sends the URL and title (still useful)
- No manual configuration needed — the widget auto-discovers the UI structure

**Performance:**
- DOM scraping takes <5ms (just reading links from existing elements)
- Navigation payload is ~500-1500 bytes (20-50 links with text and href)
- Adds ~200-500 tokens to the prompt — well within budget

**Now "where can I see all contractors?" works:**
1. Widget sends page_context with all navigation links including `{ text: "Contractors", href: "/admin/contractors" }`
2. LLM sees the navigation list in its context
3. LLM responds: "You can find the Contractors list in the sidebar navigation. Click 'Contractors' to see all contractors."
4. No manual knowledge base entry needed

**"What does this page do?" also works:**
1. Widget sends `url: "/admin/contractors"`, `heading: "All Contractors"`, `title: "Contractors | MSP Admin"`
2. LLM knows the admin is on the Contractors page and can describe what they can do there

**Widget SSE event type handling (MUST UPDATE):**

The current widget (`ChatWidget.tsx` lines 72-93) only parses `data:` lines from the SSE stream. The API sends different event types (`message`, `info`, `sql_generated`, `exploration`, `done`, `error`). The widget must be updated to parse the `event:` field too:

```typescript
// Current (broken for non-message events):
if (line.startsWith('data: ')) { ... }

// Updated (handles all event types):
let currentEvent = 'message'  // default
for (const line of lines) {
  if (line.startsWith('event: ')) {
    currentEvent = line.slice(7).trim()
  } else if (line.startsWith('data: ')) {
    const data = JSON.parse(line.slice(6))
    switch (currentEvent) {
      case 'message':
        // Append token to response (existing behavior)
        break
      case 'info':
        // Show info message (e.g., "Auto-discovery is running...")
        break
      case 'sql_generated':
        // Optional: show "Querying database..." indicator (can ignore)
        break
      case 'exploration':
        // Show "Exploring data..." indicator
        break
      case 'error':
        // Show error message
        break
      case 'done':
        // End of stream
        break
    }
    currentEvent = 'message'  // reset after data
  }
}
```

**Navigation token budget cap:**

Hard cap: max **80 navigation items**. If more are found, keep the first 80 (top-level items are usually listed first in the DOM). This ensures navigation stays under ~500 tokens.

**Total prompt token budget** (GPT-4o-mini has 128K context, but we target ~15K for quality):

| Section | Max Tokens | Trim Strategy |
|---------|-----------|---------------|
| System instructions | ~800 | Fixed (never trimmed) |
| Page context + navigation | ~500 | Cap at 80 nav items |
| Schema text (full table list) | ~3,000 | Truncate tables alphabetically |
| RAG context (top 15 docs) | ~5,000 | Reduce to top 10 if over budget |
| Knowledge base entries | ~2,000 | Truncate oldest entries first |
| Conversation history | ~3,000 | Already capped at 10 messages |
| **Total budget** | **~15,000** | |

If total exceeds 15K tokens: trim knowledge_text first → then reduce RAG to top 10 → then reduce navigation to 50 items.

**Handling missing page_context fields:**

When formatting `page_context` for the prompt, handle absent fields gracefully:
```python
def format_page_context(ctx: PageContext | None) -> str:
    if not ctx:
        return "(No page context available — widget may not be sending page info)"

    lines = []
    if ctx.url:
        title = ctx.title or "Unknown page"
        lines.append(f"The admin is currently on: {title} ({ctx.url})")
    if ctx.heading:
        lines.append(f"Page heading: {ctx.heading}")

    if ctx.navigation:
        lines.append("\nAvailable Admin Pages:")
        for nav in ctx.navigation[:80]:  # cap at 80
            lines.append(f"- {nav.text} → {nav.href}")
    else:
        lines.append("\n(No navigation links detected on this page)")

    return "\n".join(lines)
```

When `page_context` is `None` (API-only users), the prompt sections show "(No page context available)" instead of `None` or empty strings.

### Component 1: Rich Schema Inspector

**Enhance** `app/services/schema_inspector.py`

Current inspector only gets column names. The enhanced version uses SQLAlchemy's full inspection API:

```python
inspector.get_columns(table)        # name, type, nullable, default, comment
inspector.get_foreign_keys(table)   # constrained_columns, referred_table, referred_columns
inspector.get_pk_constraint(table)  # constrained_columns
inspector.get_indexes(table)        # name, column_names, unique
inspector.get_table_comment(table)  # text comment if set
```

Output: a rich schema object with full metadata per table.

The existing simple `format_for_prompt()` stays — the SQL validator still needs the flat table→column list. **Updated signature**: `format_for_prompt(exclude_tables: list[str] | None = None)` — filters out excluded tables from the output sent to the LLM (audit N1). The `schema_cache` is refreshed by both the existing cache logic AND by auto-discovery (auto-discovery updates it as part of its pipeline).

**Wide table handling**: Tables with >100 columns are split into multiple "table" documents (100 columns per doc) to stay within the 500-token target per document.

**Dialect awareness**: The rich inspector uses only SQLAlchemy's dialect-agnostic `Inspector` API. Features not supported by a dialect (e.g., `get_table_comment()` on SQLite) are wrapped in try/except and gracefully skipped. Non-PostgreSQL tenants get auto-discovery with reduced metadata (no comments, possibly no FK info) but still get column types and data sampling.

### Component 2: Data Sampler

**New**: `app/services/data_sampler.py`

Automatically discovers enum-like values by querying the tenant database.

**Which columns to sample:**
- Integer columns (likely enums: status, type, category, role)
- Boolean columns
- Short VARCHAR columns — **only column names, NOT actual string values** (see PII Protection below)

**How:**
1. `SELECT COUNT(DISTINCT col) FROM table` — if >50 distinct values, skip (not an enum)
2. For integer/boolean columns: `SELECT col::text AS val, COUNT(*) AS cnt FROM table GROUP BY col ORDER BY cnt DESC LIMIT 50`
3. For VARCHAR columns: only report cardinality + column name, never sample actual string values

**Safety:**
- All queries use `SET TRANSACTION READ ONLY`
- 2-second timeout per individual query (via `statement_timeout`)
- 60-second total timeout per project
- Skips sensitive columns (expanded blocklist — see PII Protection below)
- **SQL injection prevention**: Table and column names MUST be quoted using SQLAlchemy's `quoted_name()` or PostgreSQL double-quote escaping (`"table_name"."column_name"`). NEVER use f-strings or string interpolation for identifiers. Example:
  ```python
  # SAFE — using SQLAlchemy text() with quoted identifiers
  stmt = text(f'SELECT {quoted_name(col, quote=True)}::text AS val, COUNT(*) AS cnt '
              f'FROM {quoted_name(table, quote=True)} '
              f'GROUP BY {quoted_name(col, quote=True)} '
              f'ORDER BY cnt DESC LIMIT 50')
  ```

**PII Protection:**

The data sampler has an expanded blocklist beyond the existing `SENSITIVE_PATTERNS`:

```python
# Existing (passwords, tokens, secrets)
SENSITIVE_PATTERNS = ["password", "pwd", "token", "secret", "ssn", "api_key", "salt"]
SENSITIVE_PREFIXES = ["encr_", "stripe_", "bank_"]

# NEW — PII columns (never sample actual values)
PII_PATTERNS = ["email", "phone", "mobile", "address", "street", "zip", "postal",
                "first_name", "last_name", "full_name", "name", "dob", "birth",
                "social", "tax_id", "license", "passport", "ip_address"]
```

For columns matching PII patterns:
- **Integer PII columns** (rare): sample values but they're just numbers, no PII risk
- **String PII columns**: skip sampling entirely — only report "this column exists with N distinct values"

This means sampled values stored in `schema_documents.content` and sent to OpenAI for embedding will never contain actual PII strings.

**Example output for MSP's `contractors.status`:**
```
Column: contractors.status (INTEGER)
Value distribution:
  1 = 15,234 rows
  2 = 892 rows
  3 = 4,521 rows
  4 = 2,103 rows
  5 = 567 rows
```

**Example output for a string PII column:**
```
Column: contractors.email (VARCHAR 255)
This column has 15,234 distinct values (high cardinality — not an enum).
```

### Component 3: Document Chunker

**New**: `app/services/doc_chunker.py`

Converts rich schema + data samples into small, focused text documents for embedding.

**Document types:**

| Type | Count | Content |
|------|-------|---------|
| `table` | 1 per table (more for wide tables) | Table name, all columns with types, PKs, unique constraints, indexes, table comment |
| `enum_values` | 1 per sampled column | Table.column, data type, value distribution with counts |
| `relationship` | 1 per FK | Source table.column → target table.column, description |
| `relationship` | 1 per inferred FK | Based on naming convention (strict match only — see below) |

**Inferred FK naming convention** (strict rules to avoid false positives):
- Column must be named exactly `{singular_table_name}_id` (e.g., `contractor_id`)
- A table named `{plural}` must exist (e.g., `contractors`)
- That table must have an `id` column
- No explicit FK already exists for this column
- Columns like `external_contractor_id` or `old_contractor_id` are excluded (prefix before the table name)

**Example "table" document:**
```
Table: contractors
Columns:
  - id (INTEGER, PK)
  - first_name (VARCHAR 255)
  - last_name (VARCHAR 255)
  - email (VARCHAR 255, unique)
  - status (INTEGER, not null)
  - phone (VARCHAR 20)
  - created_at (TIMESTAMP WITH TIME ZONE)
  - updated_at (TIMESTAMP WITH TIME ZONE)
Primary Key: id
Indexes: ix_contractors_email (unique)
```

**Example "enum_values" document:**
```
Table: contractors, Column: status (INTEGER)
This column has 12 distinct values (likely an enum/status field).
Value distribution:
  1 = 15,234 rows (most common)
  3 = 4,521 rows
  4 = 2,103 rows
  2 = 892 rows
  5 = 567 rows
  ...
```

**Example "relationship" document:**
```
Foreign Key: jobs.contractor_id → contractors.id
The "contractor_id" column in "jobs" references the primary key "id" in "contractors".
Each job is associated with one contractor.
```

**Scale estimate:** 50-table database → ~200-300 documents, each 200-500 tokens.

### Component 4: Embedding Service

**New**: `app/services/embedding_service.py`

Wraps OpenAI's embedding API:
- **Model**: `text-embedding-3-small` (1536 dimensions)
- **Cost**: $0.02 per million tokens
- **Batch size**: up to 100 texts per API call
- **Full project indexing**: ~105K tokens (300 docs x 350 avg) = ~$0.003
- **Per query**: 1 embedding call = negligible

Two methods:
- `embed_texts(texts: list[str]) -> list[list[float]]` — batch embedding for indexing
- `embed_query(text: str) -> list[float]` — single embedding for query-time retrieval

**Error handling**: If OpenAI embedding API is unavailable, auto-discovery fails gracefully and sets `autodiscovery_status = "failed"` with error message. Chat falls back to schema-only mode.

### Component 5: pgvector Storage

**Table**: `schema_documents`

```sql
CREATE TABLE schema_documents (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    batch_id VARCHAR(36) NOT NULL,        -- UUID for atomic batch swap
    doc_type VARCHAR(32) NOT NULL,        -- "table", "enum_values", "relationship"
    source_table VARCHAR(128),
    source_column VARCHAR(128),
    content TEXT NOT NULL,                 -- the text that was embedded
    embedding vector(1536) NOT NULL,       -- OpenAI text-embedding-3-small
    metadata_json JSONB,                   -- extra structured data
    created_at TIMESTAMPTZ DEFAULT now()
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX ix_schema_documents_embedding
ON schema_documents USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 128);

-- Composite index for project filtering + batch management
CREATE INDEX ix_schema_documents_project_batch
ON schema_documents (project_id, batch_id);
```

**Key design decisions:**

- **`batch_id` column** (addresses audit C6): Instead of delete-then-insert (which creates a zero-document window), new documents are inserted with a new `batch_id`. After all inserts complete, the project's `autodiscovery_batch_id` is updated atomically. Old batch documents are then cleaned up. This ensures concurrent chat requests always see a complete set of documents.

- **`JSONB` instead of `TEXT`** for metadata (addresses audit M4): Enables querying metadata directly and provides JSON validation.

- **`ef_construction = 128`** (addresses audit I8): Better index quality than the default 64, negligible cost for this document count.

- **Scaling note** (addresses audit I9): The HNSW index covers all projects. For <5000 total documents (50+ projects) this is fine. For 100+ projects, consider partitioning by `project_id` or partial indexes. Not needed for initial deployment.

**Why pgvector over a separate vector DB:**
- Already have PostgreSQL in the stack
- No additional infrastructure
- Simpler deployment
- HNSW index is fast enough for <1000 documents per project
- pgvector 0.7+ has excellent performance

### Component 6: Auto-Discovery Orchestrator

**New**: `app/services/autodiscovery.py`

The main pipeline that ties everything together:

```
acquire_lock(project_id)               -- prevent concurrent runs
    → inspect_database_rich()
    → strip_sensitive_columns()
    → sample_all_tables()
    → chunk_to_documents()
    → embed_texts()
    → insert new docs with new batch_id
    → update project (batch_id, status, schema_cache)
    → delete old batch docs
release_lock()
```

**Concurrency control** (addresses audit C5):

Uses PostgreSQL advisory locks to prevent duplicate runs:

```python
AUTODISCOVERY_LOCK_NAMESPACE = 42  # fixed namespace to avoid collision with other advisory locks

async def _acquire_lock(session: AsyncSession, project_id: int) -> bool:
    """Try to acquire a two-key advisory lock. Returns False if already locked."""
    result = await session.execute(
        text("SELECT pg_try_advisory_lock(:namespace, :key)"),
        {"namespace": AUTODISCOVERY_LOCK_NAMESPACE, "key": project_id}
    )
    return result.scalar()

async def _release_lock(session: AsyncSession, project_id: int):
    await session.execute(
        text("SELECT pg_advisory_unlock(:namespace, :key)"),
        {"namespace": AUTODISCOVERY_LOCK_NAMESPACE, "key": project_id}
    )
```

If a lock can't be acquired (another run in progress), the function returns immediately without error.

**Atomic batch swap** (addresses audit C6):

```python
new_batch_id = str(uuid4())

# 1. Insert all new docs with new_batch_id
for doc, emb in zip(documents, embeddings):
    session.add(SchemaDocument(batch_id=new_batch_id, ...))
await session.flush()

# 2. Atomically update project to point to new batch
project.autodiscovery_batch_id = new_batch_id
project.autodiscovery_status = "completed"
project.autodiscovery_completed_at = func.now()
project.autodiscovery_doc_count = len(documents)
await session.commit()

# 3. Clean up old batch (non-critical, can fail safely)
await session.execute(
    delete(SchemaDocument).where(
        SchemaDocument.project_id == project.id,
        SchemaDocument.batch_id != new_batch_id,
    )
)
await session.commit()
```

**When does it run:**

| Trigger | How | Blocking? |
|---------|-----|-----------|
| Project creation | `asyncio.create_task()` | No (fire-and-forget) |
| Manual re-index | `POST /projects/{id}/reindex` → `asyncio.create_task()` | No (returns 202). Rate-limited: if `autodiscovery_status == "indexing"`, return 409 Conflict. Also, if last completed < 5 minutes ago, return 429 Too Many Requests. |
| First chat (if never indexed) | Falls back to schema-only mode, triggers async indexing | No (degraded but responsive) |
| Schema staleness | Background `asyncio.create_task()` during chat | No (uses current docs) |

**Why `asyncio.create_task()` instead of `BackgroundTasks`** (addresses audit C3):

FastAPI's `BackgroundTasks` runs in the same worker thread after the response. For a 30-120 second auto-discovery pipeline, this ties up a Gunicorn worker. Using `asyncio.create_task()` runs the task in the event loop without blocking the worker — the worker can handle other requests while auto-discovery runs.

**First-chat behavior** (addresses audit C4):

The first chat does NOT block on auto-discovery. Instead:
1. Chat detects `autodiscovery_status != "completed"`
2. Fires `asyncio.create_task(run_autodiscovery(project.id))`
3. Proceeds with **schema-only mode** (existing behavior — full schema dump, no RAG)
4. Sends an SSE event: `{"event": "info", "data": "Auto-discovery is running. Results will be more accurate after indexing completes."}`
5. Subsequent chats use RAG once indexing finishes

**Error handling with retry (audit I5):**

`asyncio.create_task()` is fire-and-forget — if it fails, nothing retries it. The wrapper function includes a single retry with exponential backoff:

```python
async def _run_autodiscovery_with_retry(project_id: int, max_retries: int = 1):
    """Fire-and-forget wrapper with retry logic."""
    for attempt in range(max_retries + 1):
        try:
            async with async_session_factory() as session:  # from app/db/session.py (not request-scoped)
                project = await session.get(Project, project_id)
                if not project:
                    return
                doc_count = await service.index_project(session, project)
                logger.info(f"Auto-discovery complete: {doc_count} documents (attempt {attempt + 1})")
                return
        except Exception as e:
            logger.error(f"Auto-discovery failed for project {project_id} (attempt {attempt + 1}): {e}")
            if attempt < max_retries:
                delay = 30 * (2 ** attempt)  # 30s, then 60s
                logger.info(f"Retrying auto-discovery in {delay}s...")
                await asyncio.sleep(delay)
            else:
                # Final failure — mark project as failed
                try:
                    async with async_session_factory() as session:
                        project = await session.get(Project, project_id)
                        if project:
                            project.autodiscovery_status = "failed"
                            project.autodiscovery_error = str(e)[:500]
                            await session.commit()
                except Exception:
                    logger.error(f"Failed to update project status for {project_id}")
```

All `asyncio.create_task()` calls use this wrapper:
```python
asyncio.create_task(_run_autodiscovery_with_retry(project.id))
```

**Project status tracking** (new columns on `projects` table):
- `autodiscovery_status`: "pending" | "indexing" | "completed" | "failed"
- `autodiscovery_completed_at`: timestamp of last successful index
- `autodiscovery_doc_count`: number of documents stored
- `autodiscovery_batch_id`: current active batch UUID
- `autodiscovery_error`: error message if failed (TEXT, nullable)
- `autodiscovery_exclude_tables`: JSON array of table names to skip (nullable)

### Component 7: RAG Retrieval

**New**: `app/services/rag_service.py`

At query time:
1. Embed the user's question
2. Cosine similarity search against `schema_documents` for this project's active batch
3. Return top 15 documents as formatted text

```python
stmt = (
    select(SchemaDocument)
    .where(
        SchemaDocument.project_id == project_id,
        SchemaDocument.batch_id == project.autodiscovery_batch_id,
    )
    .order_by(SchemaDocument.embedding.cosine_distance(query_embedding))
    .limit(top_k)
)
```

**Why top 15?**
- Each document is 200-500 tokens → 15 docs ≈ 3K-7.5K tokens
- Leaves plenty of room for system prompt (~500 tokens), schema text (~2-5K tokens), knowledge text (~0-3K tokens), conversation history (~1-3K tokens), and response
- GPT-4o-mini has 128K context window — total budget is ~15K tokens for context, well within limits
- Covers the 2-4 tables typically relevant to a question plus their enum values and relationships

**Query-time search tuning**: Set `hnsw.ef_search = 100` for better recall:
```python
await session.execute(text("SET LOCAL hnsw.ef_search = 100"))
```

**Fallback**: If no auto-discovery docs exist (status != "completed"), fall back to the existing behavior (full schema dump + manual knowledge entries).

**Staleness detection and re-indexing**: The existing `schema_refresh_interval_hours` (default 24h) is reused for auto-discovery staleness. At chat time, if `autodiscovery_completed_at` is older than `schema_refresh_interval_hours`, a background re-index is triggered (same fire-and-forget pattern). The current chat uses the existing documents — no blocking. The old schema-only refresh (`schema_cache` update) still runs independently to keep the SQL validator's column list fresh, but auto-discovery's `index_project()` also updates `schema_cache` as a side effect.

### Component 8: Multi-Step Query Strategy

When the LLM isn't confident about a query, it can request an exploration step.

**New fields on `SqlGenerationResult`** (`app/services/llm_service.py`):
```python
class SqlGenerationResult(BaseModel):
    question_type: str          # "data" or "guidance"
    sql_query: str | None = None
    explanation: str
    confidence: float
    needs_exploration: bool = False
    exploration_query: str | None = None
```

**Decision tree:**

```
LLM Call 1 returns SqlGenerationResult
    │
    ├── question_type == "guidance" → stream answer (no SQL)
    │
    ├── needs_exploration == true AND exploration_query is not None
    │       │
    │       ├── validate exploration_query
    │       │       ├── PASS → execute → append results to rag_context
    │       │       │           → LLM Call 1b (re-generate SQL, exploration disabled)
    │       │       │           → validate & execute final SQL → stream answer
    │       │       │
    │       │       └── FAIL → ignore exploration, proceed with original sql_query
    │       │
    │       └── exploration_query returns 0 rows → proceed with original sql_query
    │
    ├── sql_query is not None → validate & execute → stream answer
    │
    └── sql_query is None AND question_type == "data"
            → stream "I couldn't generate a query for this question"
```

**Key constraints:**
- **Max 1 exploration retry** — no infinite loops. After Call 1b, proceed regardless of confidence.
- **Exploration queries are validated** through the same 4-layer safety system
- **Exploration queries must not access excluded tables (audit I8)**: The SQL validator's table-existence check is extended to also reject queries that reference tables in the project's `autodiscovery_exclude_tables` list. This prevents the LLM from using exploration to probe tables the admin explicitly excluded.
- **Exploration query results go through the existing sensitive column filter** — the validator checks column existence and the executor only returns columns from non-sensitive tables
- **Exploration results are NOT stored** — they're ephemeral context for the current question only

### Component 9: LLM Call 2 (`stream_answer()`) — Updated Prompt

**Modify**: `app/services/llm_service.py` — `stream_answer()` method

Currently `stream_answer()` has two hardcoded system prompts (data vs. guidance). Both need updating:

**Updated signature:**
```python
async def stream_answer(
    self,
    question: str,
    context: str,              # SQL results (data) or knowledge text (guidance)
    question_type: str,
    conversation_history: list[dict],
    page_context_text: str = "",   # NEW — formatted page context
    rag_context: str = "",         # NEW — for guidance answers to reference DB concepts
) -> AsyncGenerator[str, None]:
```

**Updated prompts for LLM Call 2:**

For **data questions** (SQL results available):
```
You are a helpful admin assistant. The user asked a data question.
Below are the SQL query results. Summarize them clearly and concisely.
Use the page context to know where the admin is.
Current date and time: {current_datetime}

## Current Page Context
{page_context_text}

## Query Results
{context}
```

For **guidance questions** (no SQL):
```
You are a helpful admin assistant embedded in an admin panel.
The user asked a guidance question. Help them navigate or understand the system.
Current date and time: {current_datetime}

## Current Page Context
{page_context_text}

## Available Admin Pages
{page_navigation_from_context}

## Database Knowledge (auto-discovered)
{rag_context}

## Admin Panel Knowledge Base
{context}

## Rules
- Reference SPECIFIC pages and URLs from "Available Admin Pages"
- NEVER give generic advice or hallucinate pages that don't exist
- If you don't know, say so
- Respond in the same language the admin uses
```

This is critical — without page_context in LLM Call 2, guidance answers would still be garbage even after all the RAG + widget changes.

**How context flows through the router for guidance questions:**
```python
# In conversations/router.py, for guidance questions:
context = knowledge_text  # existing behavior
page_context_text = format_page_context(body.page_context)  # NEW
rag_context_text = rag_context  # NEW — so guidance can reference DB concepts too

async for token in llm_service.stream_answer(
    question=body.question,
    context=context,
    question_type=sql_result.question_type,
    conversation_history=history,
    page_context_text=page_context_text,    # NEW
    rag_context=rag_context_text,           # NEW
):
    ...
```

### Existing Knowledge Base — What Happens to It?

**It stays as-is.** The manual knowledge base becomes an **optional overlay**:
- RAG context covers database structure and data patterns (auto-discovered)
- Knowledge base covers application-specific guidance (manually added if desired)
- Both are injected into the prompt — they complement each other
- A project works fine with zero knowledge entries (RAG handles everything)

### Table Exclusion

Admins can exclude specific tables from auto-discovery via a new project field:

```python
# On the Project model
autodiscovery_exclude_tables: Mapped[str | None]  # JSON array, e.g. '["audit_logs", "sessions"]'
```

Configurable via:
- `PUT /projects/{id}` with `{"autodiscovery_exclude_tables": ["audit_logs", "sessions"]}`
- These tables are skipped during schema inspection AND data sampling
- They are ALSO excluded from the `schema_text` sent to the LLM prompt (filtered out of `format_for_prompt()` output)
- They still appear in the internal `schema_cache` (for the SQL validator's column-existence check only) but nowhere the LLM sees them
- **Rationale (audit I4)**: If excluded tables appear in `schema_text` but have no RAG context, the LLM gets confused and tries to query them with no type/enum information, producing broken SQL

### Admin Visibility

**New endpoint**: `GET /projects/{id}/schema-documents`

Returns a summary of discovered documents:
```json
{
  "status": "completed",
  "completed_at": "2026-02-20T15:30:00Z",
  "doc_count": 247,
  "error": null,
  "by_type": {
    "table": 42,
    "enum_values": 156,
    "relationship": 49
  }
}
```

With optional `?include_content=true` query param to see actual document contents (for debugging).

## Updated LLM System Prompt (for `generate_sql()` — LLM Call 1)

**Updated `generate_sql()` signature** (must receive new context):
```python
async def generate_sql(
    self,
    question: str,
    schema_text: str,
    knowledge_text: str,
    conversation_history: list[dict],
    page_context_text: str = "",        # NEW — formatted page context
    rag_context: str = "",              # NEW — auto-discovered schema details
) -> SqlGenerationResult:
```

```
You are a helpful admin assistant chatbot embedded in an admin panel.
You help administrators query their database, navigate the admin panel, and understand the system.
You ONLY answer questions about THIS admin panel and THIS database.
Respond in the same language the admin uses.
Current date and time: {current_datetime}

## Your Capabilities (tell the admin if they ask "help" or "what can you do?")
- Query the database for counts, lists, reports, and specific records
- Help find pages and features in the admin panel
- Explain business concepts based on the data structure
- Help troubleshoot issues by checking record statuses
- I am READ-ONLY — I cannot create, update, or delete anything

## Classification Rules
- "data": question asks for counts, totals, lists, specific records, comparisons, reports, or troubleshooting that needs DB lookup
- "guidance": question asks how to do something, where to find something, what a feature does, or about workflows
- When genuinely ambiguous (e.g., "show me contractors"), prefer "guidance" and mention the data option

## Current Page Context
The admin is currently on: {page_title} ({page_url})
Page heading: {page_heading}

## Available Admin Pages (from navigation)
{page_navigation}

## Database Schema (full table list)
{schema_text}

## Relevant Schema Details (auto-discovered)
{rag_context}

## Admin Panel Knowledge Base
{knowledge_text}

## Instructions — How to Handle Every Question Type

### Data Questions (database queries):
- Generate a safe, read-only SELECT query
- USE "Relevant Schema Details" for column types, enum values, foreign keys
- Integer columns with value distributions are enums — use integer values, not strings
- For date-relative queries ("last week", "this month"), use "Current date and time" above
- For troubleshooting ("why can't I see this contractor?"), query the record's status and explain what the status value means
- If confidence < 0.5, set needs_exploration=true and provide an exploration_query

### Navigation Questions ("where can I find X?"):
- Use "Available Admin Pages" to direct the admin to the right page
- Reference specific page names and URLs from the navigation list
- Example: "You can find contractors by clicking 'Contractors' in the sidebar (/admin/contractors)"
- ONLY reference pages that appear in the navigation — NEVER make up URLs

### Current Page Questions ("what does this page do?"):
- Use "Current Page Context" to understand where the admin is
- Describe what the page likely does based on its name, URL, and heading
- Mention related pages from the navigation

### How-To / Workflow Questions ("how do I create a job?"):
- Point the admin to the relevant page from the navigation
- Infer basic steps from page names (e.g., "Go to Jobs → New Job, fill in the form, and submit")
- If you're not sure about specific steps, say so: "I can point you to the right page, but I'm not sure about the exact steps."

### Business Logic / Concept Questions ("what is the bid system?"):
- Use the database schema to explain concepts (table names, column names, enum values tell a story)
- Example: "Based on the database, jobs can be of type Quoted (1), Bid (2), or Hourly (3)..."
- Use relationships and table structures to explain how things connect

### Ambiguous Questions ("show me contractors"):
- Prefer guidance but mention both options
- "You can view contractors from the 'Contractors' page in the sidebar (/admin/contractors). If you'd like me to query contractor data from the database, just let me know what you're looking for!"

### Follow-Up Questions ("now filter by active"):
- Use conversation history to understand what the admin is referring to
- Build on the previous query or answer

### Action Requests ("delete this contractor", "approve all pending"):
- You are READ-ONLY. Clearly explain this.
- Point the admin to the right page where they can perform the action themselves
- "I can't modify data, but you can manage contractors from the Contractors page (/admin/contractors)"

### Export / Report Requests:
- For data requests: answer with the query results
- For file exports: "I can show you the data, but for a downloadable export, check the [relevant page] — it may have an Export button."
- For charts/graphs: "I can provide the numbers, but I can't create visualizations."

### Emotional / Frustrated Messages ("this is broken!", "nothing works", "ugh"):
- Respond with empathy first, then redirect to problem-solving
- "I'm sorry you're having trouble. What specifically isn't working? I can help check the data or point you to the right page."

### Meta Questions ("what can you do?", "help"):
- List your capabilities clearly (see "Your Capabilities" section above)
- Give 2-3 example questions the admin can try

### Off-Topic Questions ("what's the weather?", "tell me a joke"):
- Politely redirect: "I'm designed to help with this admin panel and database. I can help you find pages, query data, or explain features. What would you like to know?"

### Unknown / Can't Answer:
- If you genuinely don't know, say so: "I don't have enough information about that. You might want to check with your administrator or the application documentation."
- NEVER make up an answer. NEVER give generic internet advice.

## HARD RULES — NEVER BREAK THESE:
1. NEVER give generic advice like "check your company's database" or "visit the official website"
2. NEVER hallucinate pages, features, or URLs that don't appear in the navigation
3. NEVER suggest you can modify data — you are strictly read-only
4. NEVER make up information you don't have — admit when you don't know
5. ALWAYS reference actual pages from the navigation when giving guidance
6. ALWAYS use integer enum values (not strings) when generating SQL
7. ALWAYS respond in the same language the admin uses
8. If the Knowledge Base and Auto-discovered sections conflict, prefer the Knowledge Base (it was manually curated)
```

## Cost Analysis

| Action | Cost | When |
|--------|------|------|
| Full project indexing | ~$0.003 | Once on setup + periodic re-index |
| Per-question embedding | ~$0.000002 | Every chat message |
| Per-question LLM (unchanged) | ~$0.002-0.005 | Every chat message |
| Exploration step (when needed) | ~$0.003 extra | ~20% of questions |

**Token math**: 300 docs x 350 avg tokens = 105K tokens. At $0.02/1M tokens = $0.0021. With overhead (batching, padding): ~$0.003.

**Re-indexing**: Runs every `schema_refresh_interval_hours` (default 24h). Same cost as initial indexing. At $0.003/day = ~$0.09/month per project.

**Total per question**: ~$0.002-0.008 (barely changes from current cost)

## Database Changes

### New Table: `schema_documents`
See Component 5 above.

### Modified Table: `projects`
New columns:
- `autodiscovery_status` (VARCHAR 32, default "pending")
- `autodiscovery_completed_at` (TIMESTAMPTZ, nullable)
- `autodiscovery_doc_count` (INTEGER, default 0)
- `autodiscovery_batch_id` (VARCHAR 36, nullable) — active document batch
- `autodiscovery_error` (TEXT, nullable) — error message if failed
- `autodiscovery_exclude_tables` (TEXT, nullable) — JSON array of tables to skip

### PostgreSQL Extension
- `pgvector` extension enabled via `CREATE EXTENSION IF NOT EXISTS vector`
- Docker image changed to `pgvector/pgvector:0.8.1-pg16-trixie` (Alpine-based, compatible with existing volume)
- **Note**: The `CREATE EXTENSION` command requires superuser privileges. In the Docker setup, the `chatbot` user is the superuser (set via `POSTGRES_USER`). For managed databases (RDS, Cloud SQL), the extension may need to be enabled via the cloud console first.
- **Graceful migration failure (audit I9)**: The Alembic migration wraps `CREATE EXTENSION` in a try/except. If pgvector is not installed on the PostgreSQL server (missing `.so` file), the migration logs a clear error message ("pgvector extension not available — install it or use the ankane/pgvector Docker image") and raises a descriptive exception. The `schema_documents` table creation is skipped if the extension fails, so the rest of the app still works in schema-only mode (no RAG). The migration's `downgrade()` also handles the case where the table doesn't exist.

## Docker Migration Steps

The PostgreSQL image change from `postgres:16-alpine` to `pgvector/pgvector:0.8.1-pg16-trixie` requires care:

1. `docker compose down` (stops containers, preserves volumes)
2. Update `docker-compose.yml` with new image
3. `docker compose up -d` (starts with new image, existing volume)
4. Verify: `docker exec sql-chatbot-db-1 psql -U chatbot -c "CREATE EXTENSION IF NOT EXISTS vector"` — should succeed
5. Run migrations: `docker compose exec api alembic upgrade head`

**If volume incompatibility occurs** (unlikely but possible):
1. `docker compose exec db pg_dump -U chatbot chatbot > backup.sql`
2. `docker compose down -v` (destroys volume)
3. `docker compose up -d` (fresh start with new image)
4. `docker compose exec db psql -U chatbot chatbot < backup.sql`
5. `alembic upgrade head`

## Dockerfile Changes

The `pgvector` Python package requires PostgreSQL client headers for compilation. Add to `Dockerfile`:

```dockerfile
RUN apt-get update && apt-get install -y curl libpq-dev gcc && rm -rf /var/lib/apt/lists/*
```

(Adding `libpq-dev` and `gcc` to the existing `apt-get install` line.)

Alternatively, `pgvector>=0.4.0` may ship pre-built wheels — check at implementation time. If wheels are available, no Dockerfile change needed.

## File Changes

### New Files (7)
| File | Purpose |
|------|---------|
| `app/models/schema_document.py` | SchemaDocument SQLAlchemy model with pgvector column |
| `app/services/data_sampler.py` | Auto-sample low-cardinality columns to discover enums (PII-safe) |
| `app/services/doc_chunker.py` | Convert rich schema + samples into embeddable text documents |
| `app/services/embedding_service.py` | OpenAI text-embedding-3-small wrapper |
| `app/services/autodiscovery.py` | Orchestrator: inspect → sample → chunk → embed → store (with locking + batch swap) |
| `app/services/rag_service.py` | pgvector similarity search at query time |
| `alembic/versions/xxxx_add_schema_documents.py` | Migration for pgvector extension + new table + project columns |

### Modified Files (14)
| File | Change |
|------|--------|
| `docker-compose.yml` | `postgres:16-alpine` → `pgvector/pgvector:0.8.1-pg16-trixie` |
| `Dockerfile` | Add `libpq-dev gcc` to apt-get install |
| `pyproject.toml` | Add `pgvector==0.4.*` |
| `app/models/__init__.py` | Import and register `SchemaDocument` |
| `app/models/project.py` | Add 6 new autodiscovery columns |
| `app/services/schema_inspector.py` | Add `inspect_database_rich()` with full metadata extraction |
| `app/services/llm_service.py` | Rewrite BOTH prompts: (1) `generate_sql()` system prompt with all 16 categories, page_context, rag_context, current_datetime, exploration fields; (2) `stream_answer()` system prompt — must also receive page_context for guidance answers (currently only gets knowledge_text). Also add `page_context_text` parameter to both methods. |
| `app/api/v1/conversations/router.py` | RAG retrieval + multi-step exploration + page_context formatting + current_datetime injection + async auto-discovery |
| `app/api/v1/conversations/schemas.py` | Add `PageContext` and `NavItem` models, add `page_context` to `ChatRequest` |
| `app/api/v1/projects/router.py` | Auto-discovery triggers + `/reindex` + `/schema-documents` endpoints |
| `app/api/v1/projects/schemas.py` | Add `autodiscovery_exclude_tables` to `ProjectUpdate`; add `autodiscovery_status`, `autodiscovery_completed_at`, `autodiscovery_doc_count`, `autodiscovery_error` to `ProjectResponse` |
| `widget/src/ChatWidget.tsx` | Add DOM scraping for page context (URL, title, heading, navigation links, breadcrumbs) + `document.currentScript` fallback (I6) + navigation hierarchy (M1) |
| `widget/src/index.ts` | Add `data-chatbot-id` fallback for async/defer script loading (I6) |
| `app/services/sql_validator.py` | Add excluded-table check to reject ALL queries (regular + exploration) referencing tables in `autodiscovery_exclude_tables` (I8). Validator's `validate()` method receives `exclude_tables: list[str] | None` parameter. |

### Widget Rebuild Required
After modifying `ChatWidget.tsx`, the widget must be rebuilt:
```bash
cd widget && npm run build
```
The built `widget/dist/widget.js` is served by the API and loaded by the admin panel.

### MSP Widget Embed Tag Update
The existing MSP embed tag in `admin_application.html.erb` should add the `data-chatbot-id` attribute for the I6 fallback:
```html
<script src="http://localhost:8000/widget.js"
        data-chatbot-id="msp-admin"
        data-api-url="http://localhost:8000"
        data-api-key="..."
        data-project-id="1">
</script>
```
This is a one-line change in the MSP repo (not the chatbot repo).

## Implementation Order

1. **Widget page context** — update widget to scrape DOM + update ChatRequest schema + format for prompt
2. **Infrastructure** — Docker image, Dockerfile, dependency, migration, model, model registration
3. **Rich inspector + data sampler** — testable independently against any PG database
4. **Chunker + embedder** — testable with mock data
5. **Orchestrator + triggers** — wires it together, testable via `/reindex`
6. **RAG retrieval** — testable given embedded documents exist
7. **Chat flow integration** — combine RAG + page context into LLM prompt
8. **Staleness detection + admin visibility** — polish

## Verification Plan

### Widget Page Context Tests
1. **Widget sends context**: Open MSP admin → open chatbot → send a message → check network tab → request body should include `page_context` with URL, title, navigation links
2. **Navigation guidance**: Ask "where can I see contractors?" → response mentions "Contractors" from sidebar with link `/admin/contractors` — NOT generic advice
3. **Current page awareness**: Navigate to /admin/contractors → ask "what does this page do?" → response references the Contractors page
4. **No hallucination**: Ask "how do I set up Stripe?" → response says "I don't have enough information" — NOT generic internet advice
5. **Ambiguous question**: Ask "show me contractors" → response mentions both the Contractors page AND offers to query the database
6. **Write refusal**: Ask "can you delete contractor #123?" → response explains it's read-only

### Auto-Discovery RAG Tests
7. **Docker**: `docker compose up -d` → pgvector container boots, volume intact
8. **Extension**: `docker exec sql-chatbot-db-1 psql -U chatbot -c "SELECT extversion FROM pg_extension WHERE extname='vector'"` → returns version
9. **Migration**: `alembic upgrade head` → `schema_documents` table + HNSW index created
10. **Re-index**: `POST /projects/1/reindex` → status goes "indexing" → "completed", doc_count > 0
11. **Documents**: `SELECT doc_type, COUNT(*) FROM schema_documents WHERE project_id=1 GROUP BY doc_type` → shows table, enum_values, relationship docs
12. **PII check**: `SELECT content FROM schema_documents WHERE doc_type='enum_values' AND source_column LIKE '%email%'` → should NOT contain actual email values
13. **Enum discovery**: Ask "how many active contractors?" → generates `WHERE status = 1`
14. **Relationship discovery**: Ask "show jobs for customer John" → uses `jobs.created_by = customers.id`
15. **Exploration**: Ask something uncertain → chatbot runs exploration query first, then answers
16. **Concurrent safety**: Fire two `/reindex` calls simultaneously → only one runs (advisory lock)
17. **Fallback**: Ask a question before indexing completes → schema-only mode works, info message shown
18. **Knowledge base**: Existing manual entries still loaded alongside RAG context

## Minor Fixes (Audit M1-M7)

### M1: Navigation Hierarchy
The `extractNavigation()` function returns a flat list. Some admin panels have nested menus (e.g., "Settings → General", "Settings → Billing"). The widget should preserve one level of hierarchy by detecting parent `<li>` elements with nested `<ul>`:

```typescript
function extractNavigation(): NavItem[] {
  // ... existing flat extraction ...

  // Enhance: detect parent-child relationships via nested list structure
  document.querySelectorAll('nav li > ul li a, [class*="sidebar"] li > ul li a').forEach(a => {
    const href = a.getAttribute('href')
    const text = a.textContent?.trim()
    const parentLi = a.closest('ul')?.closest('li')
    const parentText = parentLi?.querySelector(':scope > a')?.textContent?.trim()
    if (href && text && !links.has(href) && href !== '#') {
      links.add(href)
      items.push({
        text: parentText ? `${parentText} → ${text}` : text,
        href
      })
    }
  })

  return items
}
```

This adds "Settings → General" style labels when nested navigation is detected. Falls back to flat labels if no nesting exists.

### M2: onclick Menus
Some admin panels use `onclick` handlers instead of `<a>` tags for navigation (e.g., `<div onclick="navigate('/admin/settings')">`). These are NOT scraped by the widget. This is an accepted limitation — the widget scrapes standard `<a>` tags only. The fallback (URL + page title) still provides some context. A future enhancement could detect `onclick` patterns, but it's not worth the complexity for initial release.

### M3: RAG/Knowledge Base Deduplication
If a knowledge base entry covers the same topic as a RAG document (e.g., both describe the `contractors` table), both are included in the prompt. This is intentional — knowledge base entries are manually curated and may contain nuances the RAG doc doesn't. However, to avoid wasting tokens on near-duplicates:

- The `format_rag_context()` function adds a header: `"(Auto-discovered from database — manual knowledge entries below may override or supplement)"`
- The LLM prompt instruction says: "If the Knowledge Base and Auto-discovered sections conflict, prefer the Knowledge Base (it was manually curated)."

### M4: Structured Logging for Auto-Discovery
All auto-discovery operations use structured logging with consistent fields:

```python
logger.info("autodiscovery_started", extra={"project_id": project.id, "trigger": trigger})
logger.info("autodiscovery_inspected", extra={"project_id": project.id, "table_count": len(tables)})
logger.info("autodiscovery_sampled", extra={"project_id": project.id, "column_count": sampled_count})
logger.info("autodiscovery_embedded", extra={"project_id": project.id, "doc_count": len(documents)})
logger.info("autodiscovery_completed", extra={"project_id": project.id, "doc_count": doc_count, "duration_s": elapsed})
logger.error("autodiscovery_failed", extra={"project_id": project.id, "error": str(e), "attempt": attempt})
```

This makes it easy to filter and monitor auto-discovery in production logs.

### M5: Docker Widget Build
When the widget source (`widget/src/`) changes, the Docker image must be rebuilt to include the new `widget/dist/widget.js`. The `Dockerfile` already copies the widget dist. Add a note to the implementation checklist:

- After modifying `ChatWidget.tsx` or `index.ts`, run `cd widget && npm run build` BEFORE `docker compose build`
- The Docker build copies `widget/dist/` into the image — stale dist files will serve the old widget
- Consider adding `RUN cd widget && npm ci && npm run build` to the Dockerfile for CI/CD builds (but keep local dev as manual build for speed)

### M6: Model Relationships in SQLAlchemy
The `SchemaDocument` model should have a proper relationship to `Project`:

```python
class SchemaDocument(Base):
    __tablename__ = "schema_documents"
    # ... columns ...
    project = relationship("Project", back_populates="schema_documents")

class Project(Base):  # existing model — add:
    schema_documents = relationship("SchemaDocument", back_populates="project", cascade="all, delete-orphan")
```

The `cascade="all, delete-orphan"` ensures that deleting a project also deletes its schema documents (in addition to the `ON DELETE CASCADE` at the DB level).

### M7: CORS for Widget
The widget makes API calls from the host page's origin (e.g., `admin.mowsnowpros.com`) to the chatbot API (`localhost:8000` or a different domain). The existing CORS configuration in `app/main.py` must include the host page's origin:

- The current `allow_origins=["*"]` in development is fine
- For production, add the admin panel's domain to `allow_origins` — or make it configurable per project via an environment variable
- The widget sends `credentials: 'omit'` (no cookies) so CORS preflight is simpler
- SSE (EventSource) follows standard CORS rules — the API must return `Access-Control-Allow-Origin` for the host page's origin

## Known Limitations

1. **PostgreSQL only for full auto-discovery**: Non-PostgreSQL tenant databases get reduced metadata (no comments, possibly no FKs depending on dialect). Data sampling still works.
2. **No real-time schema sync**: Schema changes are detected on the next re-index cycle (default 24h) or manual trigger.
3. **Exploration queries can return sensitive data**: The exploration query goes through validation, but results could contain PII from the tenant database. These results are sent to OpenAI as LLM context. This is the same risk as the existing SQL execution flow — the tenant admin is querying their own data.
4. **HNSW index is global**: All projects share one index. Fine for <5000 total documents. For large scale, consider partitioning.
5. **Inferred FKs may have false positives**: Only strict `{singular_table}_id` matches are inferred. Columns like `external_contractor_id` are excluded, but edge cases may exist.
6. **Navigation scraping depends on DOM structure**: If the admin panel uses non-standard navigation (e.g., JavaScript-rendered menus with no `<a>` tags), the widget may not find all links. The fallback is the URL and page title, which still provides some context.
7. **Widget page context is per-message, not indexed**: Navigation context is sent fresh on every message — it's not stored in pgvector. This means guidance quality depends on the widget being present. API-only users (no widget) won't get navigation context.
8. **Deep workflow knowledge is limited**: The chatbot knows WHAT pages exist but not step-by-step workflows (e.g., "first click X, then fill in Y, then submit"). For detailed workflows, manual knowledge base entries can supplement.
9. **Role-based navigation**: Different admin roles may see different sidebar items. The widget scrapes whatever the CURRENT admin sees — so the chatbot automatically gives role-appropriate guidance. But it can't tell the admin about pages they don't have access to (which is actually correct behavior).
10. **SPA navigation changes**: If the admin panel is an SPA (React/Vue), the widget scrapes on each message send — so it picks up whatever navigation is rendered at that moment. If the SPA hasn't rendered nav yet, the widget may miss items. For SPAs, a small delay before scraping (100ms) helps.
11. **Shadow DOM access**: The widget itself runs in a closed Shadow DOM (can't be accessed from outside). But the widget's JavaScript CAN read the host page's DOM (document.querySelector works from inside Shadow DOM). This is standard browser behavior — Shadow DOM isolates inward, not outward.
