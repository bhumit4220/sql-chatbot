# Auto-Discovery RAG + Smart Widget Context — Implementation Plan

> **For Claude:** REQUIRED — Read this file + `memory/sql-chatbot-progress.md` at session start. Resume from the next unchecked `[ ]` task.

**Goal:** Add auto-discovery RAG (pgvector) + smart widget page context so the chatbot auto-discovers database schema/enums/relationships and admin panel navigation — zero manual setup.

**Architecture:** Widget scrapes host DOM for navigation → API receives page_context → RAG retrieves relevant schema docs via pgvector cosine similarity → LLM generates better SQL and guidance answers.

**Tech Stack:** Python 3.12, FastAPI, OpenAI (GPT-4o-mini + text-embedding-3-small), pgvector 0.4, SQLAlchemy async, React IIFE widget

**Design Doc:** `docs/plans/2026-02-20-auto-discovery-rag-design.md` (v6, ~1550 lines — the SPEC)

**Codebase Key Paths:**
- Session factory: `app/database.py` → `async_session_factory`
- Settings: `app/config.py` → `Settings`
- Models: `app/models/` → registered in `app/models/__init__.py`
- Services: `app/services/`
- API: `app/api/v1/`
- Widget: `widget/src/`
- Single migration: `alembic/versions/bc7309ea4e44_create_all_tables.py`

---

## Phase 1: Widget Page Context (3 tasks)

### Task 1.1: Update ChatRequest schema to accept page_context

**Files:**
- Modify: `app/api/v1/conversations/schemas.py`

**Steps:**
- [ ] 1.1.1 — Add `NavItem`, `PageContext` models and `page_context` field to `ChatRequest` in `schemas.py`
- [ ] 1.1.2 — Verify API still accepts old requests without `page_context` (backwards compat)
- [ ] 1.1.3 — Commit: "feat: add page_context to ChatRequest schema"

**Code for 1.1.1:**
```python
# app/api/v1/conversations/schemas.py — replace entire file
from pydantic import BaseModel

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
    page_context: PageContext | None = None
```

### Task 1.2: Add format_page_context helper + wire into router

**Files:**
- Modify: `app/api/v1/conversations/router.py`

**Steps:**
- [ ] 1.2.1 — Add `format_page_context()` function to router (top of file, before endpoints)
- [ ] 1.2.2 — In `chat_stream` endpoint, call `format_page_context(body.page_context)` and store result
- [ ] 1.2.3 — Pass `page_context_text` to `llm_service.generate_sql()` and `llm_service.stream_answer()` (these functions don't accept it yet — will be updated in Phase 7; for now, just compute and store the variable)
- [ ] 1.2.4 — Test: send a chat request with page_context JSON, verify no errors
- [ ] 1.2.5 — Commit: "feat: add format_page_context helper to conversation router"

**Code for 1.2.1:**
```python
def format_page_context(ctx) -> str:
    """Format widget page context for LLM prompt injection."""
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
        for nav in ctx.navigation[:80]:  # cap at 80 items
            lines.append(f"- {nav.text} → {nav.href}")
    else:
        lines.append("\n(No navigation links detected on this page)")

    return "\n".join(lines)
```

### Task 1.3: Update widget to scrape DOM and send page_context

**Files:**
- Modify: `widget/src/ChatWidget.tsx`
- Modify: `widget/src/index.ts`

**Steps:**
- [ ] 1.3.1 — Add `getPageContext()` and `extractNavigation()` functions to `ChatWidget.tsx`
- [ ] 1.3.2 — Update the fetch call in `ChatWidget.tsx` to include `page_context` in the POST body
- [ ] 1.3.3 — Update SSE parsing to handle `event:` lines (not just `data:` lines)
- [ ] 1.3.4 — Add `document.currentScript` fallback chain in `index.ts` (I6 fix)
- [ ] 1.3.5 — Build widget: `cd widget && npm run build`
- [ ] 1.3.6 — Update MSP embed tag in `admin_application.html.erb` with `data-chatbot-id`
- [ ] 1.3.7 — Test: open MSP admin, open chatbot, send message, check network tab for `page_context` in request body
- [ ] 1.3.8 — Commit: "feat: widget scrapes DOM for page context and sends with each message"

---

## Phase 2: Infrastructure (4 tasks)

### Task 2.1: Switch Docker to pgvector image + add Python dependency

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `pyproject.toml`

**Steps:**
- [ ] 2.1.1 — In `docker-compose.yml`, change `postgres:16-alpine` to `pgvector/pgvector:0.8.1-pg16-trixie`
- [ ] 2.1.2 — In `Dockerfile`, change `apt-get install -y curl` to `apt-get install -y curl libpq-dev gcc`
- [ ] 2.1.3 — In `pyproject.toml`, add `pgvector>=0.4.0,<0.5.0` to dependencies
- [ ] 2.1.4 — Run `docker compose down && docker compose up -d`
- [ ] 2.1.5 — Verify pgvector: `docker exec sql-chatbot-db-1 psql -U chatbot -c "CREATE EXTENSION IF NOT EXISTS vector"`
- [ ] 2.1.6 — Rebuild API: `docker compose build api && docker compose up -d`
- [ ] 2.1.7 — Verify health: `curl http://localhost:8000/health`
- [ ] 2.1.8 — Commit: "infra: switch to pgvector Docker image, add pgvector Python package"

### Task 2.2: Add OpenAI embedding model to config

**Files:**
- Modify: `app/config.py`

**Steps:**
- [ ] 2.2.1 — Add `embedding_model: str = "text-embedding-3-small"` and `embedding_dimensions: int = 1536` to `Settings`
- [ ] 2.2.2 — Commit: "config: add embedding model settings"

### Task 2.3: Create SchemaDocument model

**Files:**
- Create: `app/models/schema_document.py`
- Modify: `app/models/__init__.py`

**Steps:**
- [ ] 2.3.1 — Create `app/models/schema_document.py` with pgvector `Vector` column
- [ ] 2.3.2 — Register in `app/models/__init__.py`
- [ ] 2.3.3 — Commit: "model: add SchemaDocument with pgvector embedding column"

**Code for 2.3.1:**
```python
from sqlalchemy import Integer, String, Text, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from pgvector.sqlalchemy import Vector
from app.models.base import Base
from datetime import datetime

class SchemaDocument(Base):
    __tablename__ = "schema_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False)
    doc_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_table: Mapped[str | None] = mapped_column(String(128))
    source_column: Mapped[str | None] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(1536), nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    project = relationship("Project", back_populates="schema_documents")
```

### Task 2.4: Create Alembic migration

**Files:**
- Create: `alembic/versions/xxxx_add_autodiscovery.py`
- Modify: `app/models/project.py`

**Steps:**
- [ ] 2.4.1 — Add 6 autodiscovery columns to `app/models/project.py` + `schema_documents` relationship
- [ ] 2.4.2 — Generate migration: `docker compose exec api alembic revision --autogenerate -m "add_autodiscovery_schema_documents"`
- [ ] 2.4.3 — Edit migration to add `CREATE EXTENSION IF NOT EXISTS vector` at top (with try/except) + HNSW index + composite index
- [ ] 2.4.4 — Run migration: `docker compose exec api alembic upgrade head`
- [ ] 2.4.5 — Verify: `docker exec sql-chatbot-db-1 psql -U chatbot -c "\d schema_documents"`
- [ ] 2.4.6 — Commit: "migration: add pgvector extension, schema_documents table, autodiscovery columns"

**Columns to add to Project model:**
```python
# Add to app/models/project.py
autodiscovery_status: Mapped[str] = mapped_column(String(32), default="pending", server_default="pending")
autodiscovery_completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
autodiscovery_doc_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
autodiscovery_batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
autodiscovery_error: Mapped[str | None] = mapped_column(Text, nullable=True)
autodiscovery_exclude_tables: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON array

schema_documents = relationship("SchemaDocument", back_populates="project", cascade="all, delete-orphan")
```

---

## Phase 3: Rich Schema Inspector + Data Sampler (2 tasks)

### Task 3.1: Enhance schema_inspector.py with rich inspection

**Files:**
- Modify: `app/services/schema_inspector.py`

**Steps:**
- [ ] 3.1.1 — Add `inspect_database_rich()` method that returns full metadata (types, FKs, PKs, indexes, comments)
- [ ] 3.1.2 — Update `format_for_prompt()` to accept `exclude_tables` parameter
- [ ] 3.1.3 — Test: run rich inspector against MSP database, verify output includes column types and FKs
- [ ] 3.1.4 — Commit: "feat: rich schema inspector with types, FKs, indexes, comments"

### Task 3.2: Create data_sampler.py

**Files:**
- Create: `app/services/data_sampler.py`

**Steps:**
- [ ] 3.2.1 — Create `DataSampler` class with PII blocklist, enum detection, quoted identifiers
- [ ] 3.2.2 — Test: run sampler against MSP database, verify enum values discovered for status columns
- [ ] 3.2.3 — Verify: no PII strings in output (email, name columns show cardinality only)
- [ ] 3.2.4 — Commit: "feat: data sampler for enum-like column discovery with PII protection"

---

## Phase 4: Document Chunker + Embedding Service (2 tasks)

### Task 4.1: Create doc_chunker.py

**Files:**
- Create: `app/services/doc_chunker.py`

**Steps:**
- [ ] 4.1.1 — Create `DocChunker` class that converts rich schema + samples into text documents
- [ ] 4.1.2 — Implement table docs, enum_values docs, relationship docs (explicit FK + inferred FK)
- [ ] 4.1.3 — Test: pass mock schema data, verify document count and content format
- [ ] 4.1.4 — Commit: "feat: document chunker for schema-to-text conversion"

### Task 4.2: Create embedding_service.py

**Files:**
- Create: `app/services/embedding_service.py`

**Steps:**
- [ ] 4.2.1 — Create `EmbeddingService` with `embed_texts()` (batch) and `embed_query()` (single)
- [ ] 4.2.2 — Test: embed a sample text, verify 1536-dimension vector returned
- [ ] 4.2.3 — Commit: "feat: OpenAI embedding service wrapper"

---

## Phase 5: Orchestrator + Triggers (2 tasks)

### Task 5.1: Create autodiscovery.py orchestrator

**Files:**
- Create: `app/services/autodiscovery.py`

**Steps:**
- [ ] 5.1.1 — Create `AutodiscoveryService` with `index_project()` pipeline
- [ ] 5.1.2 — Add advisory lock acquire/release helpers
- [ ] 5.1.3 — Add atomic batch swap logic (insert new → update project → delete old)
- [ ] 5.1.4 — Add `_run_autodiscovery_with_retry()` wrapper for fire-and-forget
- [ ] 5.1.5 — Add structured logging (M4)
- [ ] 5.1.6 — Test: call `index_project()` for MSP project, verify documents created in DB
- [ ] 5.1.7 — Commit: "feat: autodiscovery orchestrator with locking and batch swap"

### Task 5.2: Add API triggers (reindex endpoint + project creation hook)

**Files:**
- Modify: `app/api/v1/projects/router.py`
- Modify: `app/api/v1/projects/schemas.py`

**Steps:**
- [ ] 5.2.1 — Add `POST /projects/{id}/reindex` endpoint with rate limiting (409/429)
- [ ] 5.2.2 — Add `GET /projects/{id}/schema-documents` endpoint
- [ ] 5.2.3 — Update `ProjectResponse` schema with autodiscovery fields
- [ ] 5.2.4 — Update `ProjectUpdate` schema with `autodiscovery_exclude_tables`
- [ ] 5.2.5 — Fire `asyncio.create_task()` on project creation
- [ ] 5.2.6 — Test: `POST /projects/1/reindex` → status goes to "indexing" then "completed"
- [ ] 5.2.7 — Test: `GET /projects/1/schema-documents` → shows doc count by type
- [ ] 5.2.8 — Commit: "feat: reindex and schema-documents API endpoints"

---

## Phase 6: RAG Retrieval (1 task)

### Task 6.1: Create rag_service.py

**Files:**
- Create: `app/services/rag_service.py`

**Steps:**
- [ ] 6.1.1 — Create `RAGService` with `retrieve()` method (embed question → cosine search → top 15 docs)
- [ ] 6.1.2 — Add `hnsw.ef_search = 100` tuning
- [ ] 6.1.3 — Add `format_rag_context()` that joins document contents with headers
- [ ] 6.1.4 — Test: embed a question, retrieve docs, verify relevance (e.g., "active contractors" retrieves contractors.status enum doc)
- [ ] 6.1.5 — Commit: "feat: RAG retrieval service with pgvector cosine search"

---

## Phase 7: Chat Flow Integration (2 tasks)

### Task 7.1: Update LLM service with new prompts + parameters

**Files:**
- Modify: `app/services/llm_service.py`

**Steps:**
- [ ] 7.1.1 — Update `generate_sql()` signature: add `page_context_text`, `rag_context` params
- [ ] 7.1.2 — Rewrite `generate_sql()` system prompt with all 16 categories (from design doc)
- [ ] 7.1.3 — Add `needs_exploration` and `exploration_query` fields to `SqlGenerationResult`
- [ ] 7.1.4 — Update `stream_answer()` signature: add `page_context_text`, `rag_context` params
- [ ] 7.1.5 — Rewrite `stream_answer()` prompts for data and guidance (from design doc)
- [ ] 7.1.6 — Add current datetime injection to both prompts
- [ ] 7.1.7 — Commit: "feat: rewrite LLM prompts with RAG context, page context, 16 categories"

### Task 7.2: Wire everything together in conversation router

**Files:**
- Modify: `app/api/v1/conversations/router.py`
- Modify: `app/services/sql_validator.py`

**Steps:**
- [ ] 7.2.1 — Add RAG retrieval call before `generate_sql()` (embed question → retrieve docs → format)
- [ ] 7.2.2 — Pass `page_context_text` and `rag_context` to `generate_sql()` and `stream_answer()`
- [ ] 7.2.3 — Add multi-step exploration logic (if `needs_exploration` → validate → execute → retry)
- [ ] 7.2.4 — Add first-chat fallback: if autodiscovery not complete, use schema-only mode + fire async indexing + send SSE info event
- [ ] 7.2.5 — Filter excluded tables from `schema_text` before sending to LLM
- [ ] 7.2.6 — Add excluded-table check to `SqlValidator.validate()` (I8)
- [ ] 7.2.7 — Add staleness detection: if `autodiscovery_completed_at` older than refresh interval, trigger background re-index
- [ ] 7.2.8 — Test end-to-end: ask "how many active contractors?" → should generate `WHERE status = 1`
- [ ] 7.2.9 — Test: ask "where can I see contractors?" → should reference actual nav links
- [ ] 7.2.10 — Test: ask "delete contractor #123" → should refuse
- [ ] 7.2.11 — Commit: "feat: integrate RAG + page context + exploration into chat flow"

---

## Phase 8: Polish + Verification (1 task)

### Task 8.1: Full verification + cleanup

**Steps:**
- [ ] 8.1.1 — Run all 18 verification tests from design doc
- [ ] 8.1.2 — Test concurrent `/reindex` calls → only one runs
- [ ] 8.1.3 — Test PII: verify no email/name strings in schema_documents
- [ ] 8.1.4 — Rebuild Docker image: `docker compose build && docker compose up -d`
- [ ] 8.1.5 — Rebuild widget: `cd widget && npm run build`
- [ ] 8.1.6 — Clean up any leftover debug code
- [ ] 8.1.7 — Final commit: "feat: auto-discovery RAG + smart widget context complete"

---

## Total: 8 phases, 17 tasks, ~65 checkboxes

Each checkbox = one atomic step. Progress file is updated after EVERY checkbox.
