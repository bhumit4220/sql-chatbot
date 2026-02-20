# SQL Chatbot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Python/FastAPI AI chatbot that connects to any PostgreSQL database to answer natural language questions via safe read-only SQL, and guides admins via a knowledge base — delivered as an embeddable JavaScript widget.

**Architecture:** Two-call LLM flow (structured SQL generation → streaming answer) with 5-layer SQL security. Multi-tenant: each project gets its own DB connection + knowledge base + API keys. Admin API (JWT) for management, widget API (API key) for end users. Redis for rate limiting.

**Tech Stack:** Python 3.12, FastAPI, OpenAI GPT-4o mini, SQLAlchemy async + asyncpg, sqlparse + sqlglot, Redis, Alembic, React IIFE widget via Vite, Docker.

**Design Document:** `docs/plans/2026-02-18-admin-chatbot-design.md` — the authoritative reference for all details.

**Project Root:** All paths below are relative to `sql-chatbot/` (a new directory at the repo root or a separate repo — created in Task 1).

---

## Phase 1: Project Scaffolding & Infrastructure

### Task 1: Project Scaffolding

**Files:**
- Create: `sql-chatbot/pyproject.toml`
- Create: `sql-chatbot/.env.example`
- Create: `sql-chatbot/.gitignore`
- Create: `sql-chatbot/app/__init__.py`
- Create: `sql-chatbot/app/config.py`
- Create: `sql-chatbot/tests/__init__.py`
- Create: `sql-chatbot/tests/conftest.py`

**Step 1: Create project directory and pyproject.toml**

```toml
# sql-chatbot/pyproject.toml
[project]
name = "sql-chatbot"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi==0.115.*",
    "uvicorn[standard]==0.32.*",
    "gunicorn==22.*",
    "openai==1.59.*",
    "sqlalchemy[asyncio]==2.0.*",
    "asyncpg==0.30.*",
    "alembic==1.14.*",
    "sqlparse==0.5.*",
    "sqlglot==25.*",
    "sse-starlette==2.1.*",
    "python-jose[cryptography]==3.3.*",
    "passlib[bcrypt]==1.7.*",
    "cryptography==43.*",
    "pydantic-settings==2.7.*",
    "structlog==24.*",
    "redis==5.*",
]

[project.optional-dependencies]
dev = [
    "pytest==8.*",
    "pytest-asyncio==0.24.*",
    "httpx==0.27.*",
    "ruff==0.8.*",
    "aiosqlite==0.20.*",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
target-version = "py312"
line-length = 120

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP"]
```

**Step 2: Create .env.example**

```bash
# sql-chatbot/.env.example
DATABASE_URL=postgresql+asyncpg://chatbot:secret@localhost:5432/chatbot
REDIS_URL=redis://localhost:6379/0
OPENAI_API_KEY=sk-your-key-here
JWT_SECRET_KEY=change-me-to-a-random-string
ENCRYPTION_KEY=generate-with-python-c-from-cryptography.fernet-import-Fernet;print(Fernet.generate_key().decode())
DEBUG=true
```

**Step 3: Create config.py with pydantic-settings**

```python
# sql-chatbot/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379/0"
    openai_api_key: str
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60
    encryption_key: str
    debug: bool = False

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
```

**Step 4: Create .gitignore, __init__.py files, and conftest.py**

```python
# sql-chatbot/tests/conftest.py
import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"
```

**Step 5: Install dependencies and verify**

Run: `cd sql-chatbot && pip install -e ".[dev]"`
Expected: Clean install, no errors.

**Step 6: Run empty test suite**

Run: `cd sql-chatbot && pytest -v`
Expected: "no tests ran" or "0 items collected"

**Step 7: Commit**

```bash
git add sql-chatbot/
git commit -m "feat: scaffold sql-chatbot project with dependencies and config"
```

---

### Task 2: Database Engine & Session Setup

**Files:**
- Create: `sql-chatbot/app/database.py`
- Create: `sql-chatbot/app/models/__init__.py`
- Create: `sql-chatbot/app/models/base.py`
- Create: `sql-chatbot/tests/test_database.py`

**Step 1: Write the failing test**

```python
# sql-chatbot/tests/test_database.py
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session


async def test_get_session_yields_async_session():
    """get_session should yield an AsyncSession."""
    async for session in get_session():
        assert isinstance(session, AsyncSession)
        break
```

**Step 2: Run test to verify it fails**

Run: `cd sql-chatbot && pytest tests/test_database.py -v`
Expected: FAIL (ImportError — module doesn't exist yet)

**Step 3: Implement database.py and base model**

```python
# sql-chatbot/app/database.py
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
)

async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
```

```python
# sql-chatbot/app/models/base.py
from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

```python
# sql-chatbot/app/models/__init__.py
from app.models.base import Base, TimestampMixin

__all__ = ["Base", "TimestampMixin"]
```

**Step 4: Update conftest.py for test DB**

```python
# sql-chatbot/tests/conftest.py
import os

# Use SQLite for tests (override before any import of settings)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/1")
os.environ.setdefault("OPENAI_API_KEY", "sk-test-fake-key")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENCRYPTION_KEY", "dGVzdC1lbmNyeXB0aW9uLWtleS0xMjM0NTY3ODk=")

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.base import Base


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def db_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.fixture
async def db_session(db_engine):
    session_factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
        await session.rollback()
```

**Step 5: Run test to verify it passes**

Run: `cd sql-chatbot && pytest tests/test_database.py -v`
Expected: PASS

**Step 6: Commit**

```bash
git add sql-chatbot/app/database.py sql-chatbot/app/models/ sql-chatbot/tests/
git commit -m "feat: add async database engine, session factory, and base model"
```

---

### Task 3: Alembic Setup

**Files:**
- Create: `sql-chatbot/alembic.ini`
- Create: `sql-chatbot/alembic/env.py`
- Create: `sql-chatbot/alembic/script.py.mako`
- Create: `sql-chatbot/alembic/versions/` (directory)

**Step 1: Initialize Alembic**

Run: `cd sql-chatbot && alembic init alembic`

**Step 2: Configure alembic.ini**

Edit `alembic.ini`:
- Set `sqlalchemy.url` to empty (we'll use env.py to read from settings)

**Step 3: Configure alembic/env.py for async**

Replace `alembic/env.py` with async-compatible version that imports `Base.metadata` from `app.models.base` and reads `DATABASE_URL` from `app.config.settings`. Use `run_async_migrations()` pattern from SQLAlchemy async docs.

Key points:
- `target_metadata = Base.metadata`
- `connectable = create_async_engine(settings.database_url)`
- Use `async with connectable.connect() as connection: await connection.run_sync(do_run_migrations)`

**Step 4: Verify Alembic config works**

Run: `cd sql-chatbot && alembic check`
Expected: No errors (may say "no revisions")

**Step 5: Commit**

```bash
git add sql-chatbot/alembic.ini sql-chatbot/alembic/
git commit -m "feat: configure Alembic for async migrations"
```

---

### Task 4: Core ORM Models + First Migration

**Files:**
- Create: `sql-chatbot/app/models/admin.py`
- Create: `sql-chatbot/app/models/project.py`
- Create: `sql-chatbot/app/models/api_key.py`
- Create: `sql-chatbot/app/models/knowledge_entry.py`
- Create: `sql-chatbot/app/models/conversation.py`
- Create: `sql-chatbot/app/models/message.py`
- Create: `sql-chatbot/app/models/audit_log.py`
- Modify: `sql-chatbot/app/models/__init__.py`
- Create: `sql-chatbot/tests/test_models.py`

**Step 1: Write failing tests for model creation**

```python
# sql-chatbot/tests/test_models.py
import pytest
from app.models.admin import Admin
from app.models.project import Project
from app.models.api_key import ApiKey
from app.models.knowledge_entry import KnowledgeEntry
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.audit_log import AuditLog


async def test_create_admin(db_session):
    admin = Admin(email="test@example.com", password_hash="hashed", role="owner")
    db_session.add(admin)
    await db_session.flush()
    assert admin.id is not None
    assert admin.email == "test@example.com"


async def test_create_project(db_session):
    admin = Admin(email="owner@example.com", password_hash="hashed", role="owner")
    db_session.add(admin)
    await db_session.flush()

    project = Project(
        name="Test Project",
        connection_string_encrypted="encrypted-string",
        owner_admin_id=admin.id,
    )
    db_session.add(project)
    await db_session.flush()
    assert project.id is not None
    assert project.udid is not None


async def test_create_api_key(db_session):
    admin = Admin(email="key@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    key = ApiKey(key_prefix="proj_abc1", key_hash="sha256hash", project_id=project.id)
    db_session.add(key)
    await db_session.flush()
    assert key.id is not None
    assert key.is_active is True


async def test_create_knowledge_entry(db_session):
    admin = Admin(email="know@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entry = KnowledgeEntry(
        project_id=project.id,
        category="navigation",
        title="Test Page",
        content="Go to /admin/test",
    )
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None
    assert entry.is_active is True


async def test_create_conversation_and_message(db_session):
    admin = Admin(email="conv@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    conv = Conversation(project_id=project.id, session_id="sess-abc-123")
    db_session.add(conv)
    await db_session.flush()

    msg = Message(conversation_id=conv.id, role="user", content="How many jobs today?")
    db_session.add(msg)
    await db_session.flush()
    assert msg.id is not None


async def test_create_audit_log(db_session):
    log = AuditLog(
        event_type="sql_executed",
        question="How many jobs?",
        sql_query="SELECT count(*) FROM jobs",
        validation_result=0,
        execution_time_ms=150.5,
        ip_address="192.168.1.1",
    )
    db_session.add(log)
    await db_session.flush()
    assert log.id is not None
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_models.py -v`
Expected: FAIL (ImportError)

**Step 3: Implement all ORM models**

Refer to design doc data model (lines 264-379) for exact fields, types, and constraints.

```python
# sql-chatbot/app/models/admin.py
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Admin(Base, TimestampMixin):
    __tablename__ = "admins"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), default="member")  # "owner" | "member"
```

```python
# sql-chatbot/app/models/project.py
import uuid

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    udid: Mapped[str] = mapped_column(String(36), unique=True, index=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255))
    connection_string_encrypted: Mapped[str] = mapped_column(Text)
    schema_cache: Mapped[str | None] = mapped_column(Text, nullable=True)
    schema_cached_at: Mapped[str | None] = mapped_column(nullable=True)
    schema_refresh_interval_hours: Mapped[int] = mapped_column(Integer, default=24)
    daily_token_limit: Mapped[int] = mapped_column(Integer, default=500_000)
    owner_admin_id: Mapped[int] = mapped_column(ForeignKey("admins.id"))
```

```python
# sql-chatbot/app/models/api_key.py
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ApiKey(Base, TimestampMixin):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    key_prefix: Mapped[str] = mapped_column(String(12))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    rate_limit_per_minute: Mapped[int] = mapped_column(Integer, default=30)
    rate_limit_per_day: Mapped[int] = mapped_column(Integer, default=500)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

```python
# sql-chatbot/app/models/knowledge_entry.py
from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class KnowledgeEntry(Base, TimestampMixin):
    __tablename__ = "knowledge_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    category: Mapped[str] = mapped_column(String(32))  # navigation, workflow, concept, faq
    title: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON array string (SQLite compat for tests)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
```

```python
# sql-chatbot/app/models/conversation.py
import uuid

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    udid: Mapped[str] = mapped_column(String(36), unique=True, index=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Composite index for session lookup
    )
```

Note: For PostgreSQL production, add a composite index on `(project_id, session_id)` in the migration. SQLite tests use individual indexes.

```python
# sql-chatbot/app/models/message.py
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # "user" | "assistant"
    content: Mapped[str] = mapped_column(Text)
    question_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    sql_query: Mapped[str | None] = mapped_column(Text, nullable=True)
    sql_results_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

```python
# sql-chatbot/app/models/audit_log.py
from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    api_key_id: Mapped[int | None] = mapped_column(ForeignKey("api_keys.id"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(64))
    question: Mapped[str] = mapped_column(Text)
    sql_query: Mapped[str | None] = mapped_column(Text, nullable=True)
    validation_result: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 0=passed, 1=rejected, 2=error, 3=guidance_only
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_time_ms: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    result_row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    token_usage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str] = mapped_column(String(45))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
```

**Step 4: Update models/__init__.py to import all models**

```python
# sql-chatbot/app/models/__init__.py
from app.models.base import Base, TimestampMixin
from app.models.admin import Admin
from app.models.project import Project
from app.models.api_key import ApiKey
from app.models.knowledge_entry import KnowledgeEntry
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.audit_log import AuditLog

__all__ = [
    "Base", "TimestampMixin",
    "Admin", "Project", "ApiKey", "KnowledgeEntry",
    "Conversation", "Message", "AuditLog",
]
```

**Step 5: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_models.py -v`
Expected: All 6 tests PASS

**Step 6: Generate first Alembic migration**

Run: `cd sql-chatbot && alembic revision --autogenerate -m "create all tables"`
Verify the generated migration has all 7 tables.

**Step 7: Commit**

```bash
git add sql-chatbot/app/models/ sql-chatbot/tests/test_models.py sql-chatbot/alembic/
git commit -m "feat: add all ORM models and initial Alembic migration"
```

---

### Task 5: Core Security Utilities

**Files:**
- Create: `sql-chatbot/app/core/__init__.py`
- Create: `sql-chatbot/app/core/security.py`
- Create: `sql-chatbot/tests/test_security.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_security.py
import pytest
from app.core.security import (
    hash_password,
    verify_password,
    hash_api_key,
    create_jwt_token,
    decode_jwt_token,
    encrypt_connection_string,
    decrypt_connection_string,
)


def test_password_hash_and_verify():
    hashed = hash_password("mysecret")
    assert hashed != "mysecret"
    assert verify_password("mysecret", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_api_key_hash_is_deterministic():
    key = "proj_live_abc123xyz"
    h1 = hash_api_key(key)
    h2 = hash_api_key(key)
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex


def test_jwt_create_and_decode():
    token = create_jwt_token(subject="admin:1")
    payload = decode_jwt_token(token)
    assert payload["sub"] == "admin:1"


def test_jwt_expired_raises():
    token = create_jwt_token(subject="admin:1", expire_minutes=-1)
    with pytest.raises(Exception):
        decode_jwt_token(token)


def test_fernet_encrypt_decrypt():
    original = "postgresql+asyncpg://user:pass@host:5432/db"
    encrypted = encrypt_connection_string(original)
    assert encrypted != original
    decrypted = decrypt_connection_string(encrypted)
    assert decrypted == original
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_security.py -v`
Expected: FAIL (ImportError)

**Step 3: Implement security.py**

```python
# sql-chatbot/app/core/security.py
import hashlib
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def create_jwt_token(subject: str, expire_minutes: int | None = None) -> str:
    if expire_minutes is None:
        expire_minutes = settings.jwt_expire_minutes
    expire = datetime.now(timezone.utc) + timedelta(minutes=expire_minutes)
    return jwt.encode(
        {"sub": subject, "exp": expire},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


def decode_jwt_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as e:
        raise ValueError(f"Invalid token: {e}") from e


def _get_fernet() -> Fernet:
    return Fernet(settings.encryption_key.encode() if isinstance(settings.encryption_key, str) else settings.encryption_key)


def encrypt_connection_string(plain: str) -> str:
    return _get_fernet().encrypt(plain.encode()).decode()


def decrypt_connection_string(encrypted: str) -> str:
    return _get_fernet().decrypt(encrypted.encode()).decode()
```

**Step 4: Generate a valid Fernet key for tests**

Update `tests/conftest.py` to generate a proper Fernet key:

```python
# At top of conftest.py, before other env vars:
from cryptography.fernet import Fernet
os.environ.setdefault("ENCRYPTION_KEY", Fernet.generate_key().decode())
```

**Step 5: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_security.py -v`
Expected: All 5 tests PASS

**Step 6: Commit**

```bash
git add sql-chatbot/app/core/ sql-chatbot/tests/test_security.py sql-chatbot/tests/conftest.py
git commit -m "feat: add security utilities (password, JWT, API key hash, Fernet)"
```

---

### Task 6: Custom Exceptions & Structured Logging

**Files:**
- Create: `sql-chatbot/app/core/exceptions.py`
- Create: `sql-chatbot/app/core/logging.py`
- Create: `sql-chatbot/tests/test_exceptions.py`

**Step 1: Write failing test**

```python
# sql-chatbot/tests/test_exceptions.py
from app.core.exceptions import (
    ChatbotException,
    NotFoundError,
    AuthenticationError,
    ValidationError,
    RateLimitError,
    BudgetExceededError,
)


def test_chatbot_exception_has_status_and_message():
    exc = ChatbotException(message="test error", status_code=500)
    assert exc.message == "test error"
    assert exc.status_code == 500


def test_not_found_error_defaults_to_404():
    exc = NotFoundError("Project not found")
    assert exc.status_code == 404


def test_auth_error_defaults_to_401():
    exc = AuthenticationError("Invalid token")
    assert exc.status_code == 401


def test_validation_error_defaults_to_422():
    exc = ValidationError("Invalid input")
    assert exc.status_code == 422


def test_rate_limit_error_defaults_to_429():
    exc = RateLimitError()
    assert exc.status_code == 429


def test_budget_exceeded_error_defaults_to_429():
    exc = BudgetExceededError()
    assert exc.status_code == 429
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_exceptions.py -v`
Expected: FAIL

**Step 3: Implement exceptions and logging**

```python
# sql-chatbot/app/core/exceptions.py
from fastapi import Request
from fastapi.responses import JSONResponse


class ChatbotException(Exception):
    def __init__(self, message: str = "Internal error", status_code: int = 500):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class NotFoundError(ChatbotException):
    def __init__(self, message: str = "Not found"):
        super().__init__(message=message, status_code=404)


class AuthenticationError(ChatbotException):
    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message=message, status_code=401)


class ValidationError(ChatbotException):
    def __init__(self, message: str = "Validation failed"):
        super().__init__(message=message, status_code=422)


class RateLimitError(ChatbotException):
    def __init__(self, message: str = "Rate limit exceeded. Please wait."):
        super().__init__(message=message, status_code=429)


class BudgetExceededError(ChatbotException):
    def __init__(self, message: str = "Daily query limit reached."):
        super().__init__(message=message, status_code=429)


async def chatbot_exception_handler(request: Request, exc: ChatbotException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.message})
```

```python
# sql-chatbot/app/core/logging.py
import structlog


def setup_logging(debug: bool = False) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer() if debug else structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
```

**Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_exceptions.py -v`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add sql-chatbot/app/core/ sql-chatbot/tests/test_exceptions.py
git commit -m "feat: add custom exceptions and structured logging"
```

---

### Task 7: FastAPI App Skeleton + Health Endpoints

**Files:**
- Create: `sql-chatbot/app/main.py`
- Create: `sql-chatbot/app/api/__init__.py`
- Create: `sql-chatbot/app/api/v1/__init__.py`
- Create: `sql-chatbot/app/api/v1/router.py`
- Create: `sql-chatbot/tests/test_api/__init__.py`
- Create: `sql-chatbot/tests/test_api/test_health.py`

**Step 1: Write failing test**

```python
# sql-chatbot/tests/test_api/test_health.py
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_health_endpoint(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "version" in data


async def test_ready_endpoint(client):
    resp = await client.get("/ready")
    assert resp.status_code == 200
```

**Step 2: Run test to verify it fails**

Run: `cd sql-chatbot && pytest tests/test_api/test_health.py -v`
Expected: FAIL

**Step 3: Implement FastAPI app**

```python
# sql-chatbot/app/main.py
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.core.exceptions import ChatbotException, chatbot_exception_handler
from app.core.logging import setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(debug=settings.debug)
    yield


app = FastAPI(title="SQL Chatbot", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.add_exception_handler(ChatbotException, chatbot_exception_handler)


@app.get("/health")
async def health():
    return {"status": "ok", "version": app.version}


@app.get("/ready")
async def ready():
    return {"status": "ready"}
```

```python
# sql-chatbot/app/api/__init__.py
# empty

# sql-chatbot/app/api/v1/__init__.py
# empty

# sql-chatbot/app/api/v1/router.py
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1")

# Domain routers will be included here as they're built
```

**Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_api/test_health.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add sql-chatbot/app/main.py sql-chatbot/app/api/ sql-chatbot/tests/test_api/
git commit -m "feat: add FastAPI app skeleton with health endpoints"
```

---

## Phase 2: Authentication & Admin API

### Task 8: Auth Dependencies (JWT + API Key Verification)

**Files:**
- Create: `sql-chatbot/app/api/v1/auth/__init__.py`
- Create: `sql-chatbot/app/api/v1/auth/dependencies.py`
- Create: `sql-chatbot/app/api/v1/auth/schemas.py`
- Create: `sql-chatbot/app/api/v1/auth/service.py`
- Create: `sql-chatbot/tests/test_api/test_auth.py`

**Step 1: Write failing tests for auth dependencies**

```python
# sql-chatbot/tests/test_api/test_auth.py
import pytest
from app.api.v1.auth.service import authenticate_admin
from app.core.security import hash_password
from app.models.admin import Admin


async def test_authenticate_admin_valid(db_session):
    admin = Admin(email="auth@test.com", password_hash=hash_password("pass123"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    result = await authenticate_admin(db_session, "auth@test.com", "pass123")
    assert result is not None
    assert result.email == "auth@test.com"


async def test_authenticate_admin_wrong_password(db_session):
    admin = Admin(email="wrong@test.com", password_hash=hash_password("pass123"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    result = await authenticate_admin(db_session, "wrong@test.com", "badpass")
    assert result is None


async def test_authenticate_admin_no_user(db_session):
    result = await authenticate_admin(db_session, "nobody@test.com", "pass")
    assert result is None
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_api/test_auth.py -v`
Expected: FAIL

**Step 3: Implement auth service, schemas, and dependencies**

```python
# sql-chatbot/app/api/v1/auth/schemas.py
from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
```

```python
# sql-chatbot/app/api/v1/auth/service.py
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_password
from app.models.admin import Admin


async def authenticate_admin(session: AsyncSession, email: str, password: str) -> Admin | None:
    result = await session.execute(select(Admin).where(Admin.email == email))
    admin = result.scalar_one_or_none()
    if admin is None or not verify_password(password, admin.password_hash):
        return None
    return admin
```

```python
# sql-chatbot/app/api/v1/auth/dependencies.py
from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError
from app.core.security import decode_jwt_token, hash_api_key
from app.database import get_session
from app.models.admin import Admin
from app.models.api_key import ApiKey


async def get_current_admin(
    authorization: str = Header(..., alias="Authorization"),
    session: AsyncSession = Depends(get_session),
) -> Admin:
    if not authorization.startswith("Bearer "):
        raise AuthenticationError("Invalid authorization header")
    token = authorization[7:]
    try:
        payload = decode_jwt_token(token)
    except ValueError:
        raise AuthenticationError("Invalid or expired token")
    admin_id = int(payload["sub"].split(":")[1])
    result = await session.execute(select(Admin).where(Admin.id == admin_id))
    admin = result.scalar_one_or_none()
    if admin is None:
        raise AuthenticationError("Admin not found")
    return admin


async def verify_api_key(
    x_api_key: str = Header(..., alias="X-API-Key"),
    session: AsyncSession = Depends(get_session),
) -> ApiKey:
    key_hash = hash_api_key(x_api_key)
    result = await session.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.is_active == True)
    )
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise AuthenticationError("Invalid API key")
    return api_key
```

**Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_api/test_auth.py -v`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add sql-chatbot/app/api/v1/auth/ sql-chatbot/tests/test_api/test_auth.py
git commit -m "feat: add auth service, dependencies, and schemas"
```

---

### Task 9: Auth Router (Login + Refresh)

**Files:**
- Create: `sql-chatbot/app/api/v1/auth/router.py`
- Create: `sql-chatbot/tests/test_api/test_auth_router.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_api/test_auth_router.py
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.core.security import hash_password
from app.models.admin import Admin
from app.models.base import Base


@pytest.fixture
async def seeded_client(db_engine, db_session):
    """Client with a seeded admin user."""
    # Seed an admin
    admin = Admin(email="admin@test.com", password_hash=hash_password("secret"), role="owner")
    db_session.add(admin)
    await db_session.commit()

    # Override get_session dependency
    from app.database import get_session
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    session_factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def test_login_success(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "secret"})
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


async def test_login_wrong_password(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "wrong"})
    assert resp.status_code == 401


async def test_login_nonexistent_user(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "nope@test.com", "password": "any"})
    assert resp.status_code == 401
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_api/test_auth_router.py -v`
Expected: FAIL

**Step 3: Implement auth router**

```python
# sql-chatbot/app/api/v1/auth/router.py
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError
from app.core.security import create_jwt_token
from app.database import get_session
from app.api.v1.auth.schemas import LoginRequest, TokenResponse
from app.api.v1.auth.service import authenticate_admin

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, session: AsyncSession = Depends(get_session)):
    admin = await authenticate_admin(session, body.email, body.password)
    if admin is None:
        raise AuthenticationError("Invalid email or password")
    token = create_jwt_token(subject=f"admin:{admin.id}")
    return TokenResponse(access_token=token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    admin=Depends(
        __import__("app.api.v1.auth.dependencies", fromlist=["get_current_admin"]).get_current_admin
    ),
):
    token = create_jwt_token(subject=f"admin:{admin.id}")
    return TokenResponse(access_token=token)
```

Note: Clean up the refresh endpoint import — use a proper import at the top of file. The above is just to show the logic.

**Step 4: Register auth router in the v1 aggregator and main app**

In `app/api/v1/router.py`:
```python
from app.api.v1.auth.router import router as auth_router
router.include_router(auth_router)
```

In `app/main.py`:
```python
from app.api.v1.router import router as v1_router
app.include_router(v1_router)
```

**Step 5: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_api/test_auth_router.py -v`
Expected: All 3 tests PASS

**Step 6: Commit**

```bash
git add sql-chatbot/app/api/v1/auth/router.py sql-chatbot/app/api/v1/router.py sql-chatbot/app/main.py sql-chatbot/tests/
git commit -m "feat: add auth login and refresh endpoints"
```

---

### Task 10: Projects CRUD + API Key Management

**Files:**
- Create: `sql-chatbot/app/api/v1/projects/__init__.py`
- Create: `sql-chatbot/app/api/v1/projects/router.py`
- Create: `sql-chatbot/app/api/v1/projects/schemas.py`
- Create: `sql-chatbot/app/api/v1/projects/service.py`
- Create: `sql-chatbot/tests/test_api/test_projects.py`

**Step 1: Write failing tests for project service**

Tests should cover:
- `create_project(session, admin_id, name, connection_string)` → returns Project with encrypted connection string and generated udid
- `list_projects(session, admin_id, limit, after)` → returns paginated list (admin can only see own projects)
- `get_project(session, admin_id, project_id)` → returns single project or raises NotFoundError
- `update_project(session, admin_id, project_id, name)` → updates name
- `delete_project(session, admin_id, project_id)` → deletes project
- `create_api_key(session, project_id)` → returns (raw_key, ApiKey) — raw key shown once, stored as hash
- `list_api_keys(session, project_id, limit, after)` → returns keys (prefix + status only)
- `revoke_api_key(session, key_id)` → sets is_active=False

**Step 2: Run tests, verify fail**

**Step 3: Implement service.py**

Key implementation details:
- `create_project`: encrypt connection string via `encrypt_connection_string()`, generate udid, set owner_admin_id
- `create_api_key`: generate `secrets.token_urlsafe(32)`, prefix = first 8 chars prepended with `proj_`, hash via `hash_api_key()`, store hash
- All list endpoints return `{"items": [...], "has_more": bool, "next_cursor": str|null}` — cursor is the last item's `id`
- Admin scope: all queries filter by `owner_admin_id == admin.id`

**Step 4: Implement schemas.py**

Pydantic models for request/response. Important: never return `connection_string_encrypted` in responses — return a masked version or omit.

**Step 5: Implement router.py**

All endpoints require `get_current_admin` dependency. Routes:
```
POST   /projects
GET    /projects
GET    /projects/{project_id}
PUT    /projects/{project_id}
DELETE /projects/{project_id}
POST   /projects/{project_id}/test-connection
POST   /projects/{project_id}/refresh-schema
POST   /projects/{project_id}/api-keys
GET    /projects/{project_id}/api-keys
DELETE /projects/{project_id}/api-keys/{key_id}
```

**Step 6: Register router in v1 aggregator**

**Step 7: Run tests, verify pass**

**Step 8: Commit**

```bash
git add sql-chatbot/app/api/v1/projects/ sql-chatbot/tests/test_api/test_projects.py
git commit -m "feat: add projects CRUD and API key management endpoints"
```

---

### Task 11: Knowledge Base CRUD

**Files:**
- Create: `sql-chatbot/app/api/v1/knowledge/__init__.py`
- Create: `sql-chatbot/app/api/v1/knowledge/router.py`
- Create: `sql-chatbot/app/api/v1/knowledge/schemas.py`
- Create: `sql-chatbot/app/api/v1/knowledge/service.py`
- Create: `sql-chatbot/tests/test_api/test_knowledge.py`

**Step 1: Write failing tests**

Tests should cover:
- `create_entry(session, project_id, data)` → creates entry, returns it
- `create_entry` when project already has 100 entries → raises ValidationError (max 100 limit)
- `list_entries(session, project_id, limit, after)` → paginated list
- `get_entry(session, project_id, entry_id)` → single entry or NotFoundError
- `update_entry(session, project_id, entry_id, data)` → updates fields
- `delete_entry(session, project_id, entry_id)` → deletes
- Category validation: only "navigation", "workflow", "concept", "faq" allowed

**Step 2: Run tests, verify fail**

**Step 3: Implement service, schemas, router**

Key details:
- Enforce max 100 entries per project: `SELECT count(*) FROM knowledge_entries WHERE project_id = :id` before insert
- Category validated via Pydantic `Literal["navigation", "workflow", "concept", "faq"]`
- Tags stored as JSON string (for SQLite test compatibility), parsed as list in schema

**Step 4: Register router in v1 aggregator**

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add sql-chatbot/app/api/v1/knowledge/ sql-chatbot/tests/test_api/test_knowledge.py
git commit -m "feat: add knowledge base CRUD with 100-entry limit"
```

---

## Phase 3: SQL Security Pipeline

### Task 12: SQL Validator (Critical Security Component)

**Files:**
- Create: `sql-chatbot/app/services/__init__.py`
- Create: `sql-chatbot/app/services/sql_validator.py`
- Create: `sql-chatbot/tests/test_sql_validator.py`

**Step 1: Write comprehensive failing tests**

This is the most security-critical component. Tests must cover all 5 layers. Write at least 25 test cases:

```python
# sql-chatbot/tests/test_sql_validator.py
import pytest
from app.services.sql_validator import SqlValidator, SqlValidationResult


@pytest.fixture
def validator():
    # Schema with known tables and columns
    schema = {
        "jobs": ["id", "title", "status", "created_at", "created_by"],
        "customers": ["id", "name", "email", "created_at"],
        "contractors": ["id", "name", "phone", "created_at"],
        "properties": ["id", "address", "lat", "lng", "customer_id"],
    }
    return SqlValidator(schema=schema)


# --- Valid queries ---

def test_simple_select(validator):
    result = validator.validate("SELECT id, title FROM jobs")
    assert result.is_valid is True

def test_select_with_where(validator):
    result = validator.validate("SELECT * FROM jobs WHERE status = 1")
    assert result.is_valid is True

def test_select_with_join(validator):
    result = validator.validate("SELECT j.id, c.name FROM jobs j JOIN customers c ON j.created_by = c.id")
    assert result.is_valid is True

def test_select_with_aggregation(validator):
    result = validator.validate("SELECT count(*) FROM jobs WHERE status = 1")
    assert result.is_valid is True

def test_select_with_limit(validator):
    result = validator.validate("SELECT * FROM jobs LIMIT 10")
    assert result.is_valid is True

def test_adds_limit_if_missing(validator):
    result = validator.validate("SELECT * FROM jobs")
    assert result.is_valid is True
    assert "LIMIT" in result.modified_sql.upper()


# --- Multi-statement injection ---

def test_rejects_multiple_statements(validator):
    result = validator.validate("SELECT 1; DROP TABLE jobs;")
    assert result.is_valid is False

def test_rejects_semicolon_injection(validator):
    result = validator.validate("SELECT 1; DELETE FROM jobs")
    assert result.is_valid is False


# --- Non-SELECT statements ---

def test_rejects_insert(validator):
    result = validator.validate("INSERT INTO jobs (title) VALUES ('x')")
    assert result.is_valid is False

def test_rejects_update(validator):
    result = validator.validate("UPDATE jobs SET title = 'x'")
    assert result.is_valid is False

def test_rejects_delete(validator):
    result = validator.validate("DELETE FROM jobs WHERE id = 1")
    assert result.is_valid is False

def test_rejects_drop(validator):
    result = validator.validate("DROP TABLE jobs")
    assert result.is_valid is False

def test_rejects_truncate(validator):
    result = validator.validate("TRUNCATE TABLE jobs")
    assert result.is_valid is False

def test_rejects_create(validator):
    result = validator.validate("CREATE TABLE evil (id int)")
    assert result.is_valid is False

def test_rejects_alter(validator):
    result = validator.validate("ALTER TABLE jobs ADD COLUMN evil text")
    assert result.is_valid is False

def test_rejects_grant(validator):
    result = validator.validate("GRANT ALL ON jobs TO evil_user")
    assert result.is_valid is False


# --- AST analysis ---

def test_rejects_select_into(validator):
    result = validator.validate("SELECT * INTO evil_table FROM jobs")
    assert result.is_valid is False

def test_allows_table_named_into(validator):
    """Table names containing 'into' should not trigger false positive."""
    # This tests AST-based detection vs keyword matching
    schema_with_into = {
        "intro_pages": ["id", "title"],
        **{k: v for k, v in validator.schema.items()},
    }
    v = SqlValidator(schema=schema_with_into)
    result = v.validate("SELECT * FROM intro_pages")
    assert result.is_valid is True


# --- Keyword blocklist ---

def test_rejects_execute(validator):
    result = validator.validate("EXECUTE some_function()")
    assert result.is_valid is False

def test_rejects_copy(validator):
    result = validator.validate("COPY jobs TO '/tmp/evil.csv'")
    assert result.is_valid is False

def test_rejects_set_role(validator):
    result = validator.validate("SET ROLE admin")
    assert result.is_valid is False


# --- PG function blocklist ---

def test_rejects_pg_read_file(validator):
    result = validator.validate("SELECT pg_read_file('/etc/passwd')")
    assert result.is_valid is False

def test_rejects_pg_sleep(validator):
    result = validator.validate("SELECT pg_sleep(999)")
    assert result.is_valid is False

def test_rejects_dblink(validator):
    result = validator.validate("SELECT * FROM dblink('host=evil', 'SELECT 1')")
    assert result.is_valid is False

def test_rejects_current_setting(validator):
    result = validator.validate("SELECT current_setting('superuser')")
    assert result.is_valid is False


# --- PG system catalog blocklist ---

def test_rejects_pg_stat_activity(validator):
    result = validator.validate("SELECT * FROM pg_stat_activity")
    assert result.is_valid is False

def test_rejects_pg_roles(validator):
    result = validator.validate("SELECT * FROM pg_roles")
    assert result.is_valid is False

def test_rejects_pg_shadow(validator):
    result = validator.validate("SELECT * FROM pg_shadow")
    assert result.is_valid is False


# --- Column existence check (Audit 4 fix) ---

def test_rejects_nonexistent_column(validator):
    result = validator.validate("SELECT password_hash FROM customers")
    assert result.is_valid is False
    assert "column" in result.rejection_reason.lower()

def test_rejects_hallucinated_column(validator):
    result = validator.validate("SELECT ssn FROM customers")
    assert result.is_valid is False

def test_allows_star_select(validator):
    result = validator.validate("SELECT * FROM jobs")
    assert result.is_valid is True

def test_allows_function_expressions(validator):
    result = validator.validate("SELECT count(*), max(id) FROM jobs")
    assert result.is_valid is True
```

**Step 2: Run tests to verify they fail**

Run: `cd sql-chatbot && pytest tests/test_sql_validator.py -v`
Expected: FAIL

**Step 3: Implement SqlValidator**

```python
# sql-chatbot/app/services/sql_validator.py
from dataclasses import dataclass

import sqlparse
import sqlglot
from sqlglot import exp


@dataclass
class SqlValidationResult:
    is_valid: bool
    modified_sql: str = ""
    rejection_reason: str = ""


BLOCKED_KEYWORDS = {
    "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE",
    "GRANT", "REVOKE", "EXECUTE", "COPY", "PREPARE", "DO", "SET ROLE", "SET SESSION",
}

BLOCKED_FUNCTIONS = {
    "pg_read_file", "pg_ls_dir", "pg_stat_file", "dblink", "lo_import", "lo_export",
    "pg_terminate_backend", "pg_cancel_backend", "pg_sleep", "current_setting",
}

BLOCKED_CATALOGS = {
    "pg_stat_activity", "pg_roles", "pg_shadow", "pg_authid",
}

MAX_LIMIT = 500


class SqlValidator:
    def __init__(self, schema: dict[str, list[str]]):
        """schema: {"table_name": ["col1", "col2", ...], ...}"""
        self.schema = schema
        self._all_columns: set[str] = set()
        for cols in schema.values():
            self._all_columns.update(c.lower() for c in cols)

    def validate(self, sql: str) -> SqlValidationResult:
        # Layer 2: sqlparse — single statement, SELECT only
        parsed = sqlparse.parse(sql)
        if len(parsed) != 1:
            return SqlValidationResult(False, rejection_reason="Multiple statements detected")
        stmt = parsed[0]
        if stmt.get_type() != "SELECT":
            return SqlValidationResult(False, rejection_reason=f"Statement type '{stmt.get_type()}' not allowed, only SELECT")

        # Layer 4: Keyword blocklist (uppercase check)
        sql_upper = sql.upper()
        for keyword in BLOCKED_KEYWORDS:
            if keyword in sql_upper:
                # Avoid false positives: check word boundaries
                import re
                if re.search(rf'\b{keyword}\b', sql_upper):
                    return SqlValidationResult(False, rejection_reason=f"Blocked keyword: {keyword}")

        # Layer 4: Function blocklist
        sql_lower = sql.lower()
        for func in BLOCKED_FUNCTIONS:
            if func in sql_lower:
                return SqlValidationResult(False, rejection_reason=f"Blocked function: {func}")

        # Layer 4: System catalog blocklist
        for catalog in BLOCKED_CATALOGS:
            if catalog in sql_lower:
                return SqlValidationResult(False, rejection_reason=f"Blocked system catalog: {catalog}")

        # Layer 3: sqlglot AST analysis
        try:
            ast = sqlglot.parse_one(sql, dialect="postgres")
        except sqlglot.errors.ParseError as e:
            return SqlValidationResult(False, rejection_reason=f"SQL parse error: {e}")

        # Check for disallowed AST node types
        blocked_types = (
            exp.Insert, exp.Update, exp.Delete, exp.Drop,
            exp.Create, exp.Alter, exp.Grant, exp.Command,
        )
        for node in ast.walk():
            if isinstance(node, blocked_types):
                return SqlValidationResult(False, rejection_reason=f"Blocked SQL operation: {type(node).__name__}")
            # Detect SELECT...INTO
            if isinstance(node, exp.Into):
                return SqlValidationResult(False, rejection_reason="SELECT INTO not allowed")

        # Column existence check (Audit 4 fix)
        for node in ast.walk():
            if isinstance(node, exp.Column):
                col_name = node.name.lower()
                # Skip * and expressions
                if col_name == "*":
                    continue
                # Only check if it's a plain column reference (not a function alias)
                if col_name not in self._all_columns:
                    return SqlValidationResult(
                        False,
                        rejection_reason=f"Column '{node.name}' does not exist in the schema",
                    )

        # Force LIMIT if missing
        modified = sql
        if not any(isinstance(node, exp.Limit) for node in ast.walk()):
            modified = f"{sql.rstrip().rstrip(';')} LIMIT {MAX_LIMIT}"

        return SqlValidationResult(is_valid=True, modified_sql=modified)
```

**Step 4: Run tests to verify they pass**

Run: `cd sql-chatbot && pytest tests/test_sql_validator.py -v`
Expected: All ~30 tests PASS

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/ sql-chatbot/tests/test_sql_validator.py
git commit -m "feat: add SQL validator with 5-layer security and column existence check"
```

---

### Task 13: Schema Inspector

**Files:**
- Create: `sql-chatbot/app/services/schema_inspector.py`
- Create: `sql-chatbot/tests/test_schema_inspector.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_schema_inspector.py
import pytest
from app.services.schema_inspector import SchemaInspector


SENSITIVE_PATTERNS = ["password", "pwd", "token", "secret", "ssn", "api_key", "salt"]


def test_strips_sensitive_columns():
    """Columns matching sensitive patterns should be removed."""
    raw_schema = {
        "users": ["id", "name", "email", "password_hash", "auth_token", "api_key_hash"],
        "jobs": ["id", "title", "status"],
    }
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)

    assert "password_hash" not in stripped["users"]
    assert "auth_token" not in stripped["users"]
    assert "api_key_hash" not in stripped["users"]
    assert "id" in stripped["users"]
    assert "name" in stripped["users"]
    assert stripped["jobs"] == ["id", "title", "status"]


def test_strips_encr_prefix_columns():
    raw_schema = {"users": ["id", "encr_pwd", "encr_data"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert stripped["users"] == ["id"]


def test_strips_stripe_prefix_columns():
    raw_schema = {"payments": ["id", "amount", "stripe_customer_id", "stripe_token"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert "stripe_customer_id" not in stripped["payments"]
    assert "stripe_token" not in stripped["payments"]
    assert "amount" in stripped["payments"]


def test_strips_bank_prefix_columns():
    raw_schema = {"contractors": ["id", "name", "bank_account", "bank_routing"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert "bank_account" not in stripped["contractors"]


def test_format_schema_for_prompt():
    schema = {
        "jobs": ["id", "title", "status", "created_at"],
        "customers": ["id", "name", "email"],
    }
    inspector = SchemaInspector()
    prompt_text = inspector.format_for_prompt(schema)
    assert "jobs" in prompt_text
    assert "id" in prompt_text
    assert "customers" in prompt_text
```

**Step 2: Run tests, verify fail**

**Step 3: Implement SchemaInspector**

The inspector has two main functions:
1. `inspect_database(engine)` → uses `sqlalchemy.inspect()` to get table names and column names from a live DB connection. Returns `dict[str, list[str]]`.
2. `strip_sensitive_columns(schema)` → removes columns matching blocklist patterns. Returns cleaned schema.
3. `format_for_prompt(schema)` → formats as CREATE TABLE statements (text) for LLM context.

Sensitive column patterns (from design doc):
- Exact match: `password`, `pwd`, `token`, `secret`, `ssn`, `api_key`, `salt`
- Prefix match: `encr_*`, `stripe_*`, `bank_*`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/schema_inspector.py sql-chatbot/tests/test_schema_inspector.py
git commit -m "feat: add schema inspector with sensitive column stripping"
```

---

### Task 14: Tenant DB Manager

**Files:**
- Create: `sql-chatbot/app/services/tenant_db.py`
- Create: `sql-chatbot/tests/test_tenant_db.py`

**Step 1: Write failing tests**

Test the engine pool management:
- `get_engine(project_id, connection_string)` → returns an async engine
- Calling `get_engine` twice with same project_id → returns same cached engine
- Engines evicted after TTL (mock time)
- `dispose_engine(project_id)` → removes from cache

**Step 2: Run tests, verify fail**

**Step 3: Implement TenantDBManager**

```python
# sql-chatbot/app/services/tenant_db.py
import time
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine

from app.core.security import decrypt_connection_string


class TenantDBManager:
    def __init__(self, ttl_seconds: int = 1800):  # 30min default
        self._engines: dict[int, tuple[AsyncEngine, float]] = {}
        self._ttl = ttl_seconds

    async def get_engine(self, project_id: int, encrypted_conn_str: str) -> AsyncEngine:
        now = time.monotonic()
        if project_id in self._engines:
            engine, last_used = self._engines[project_id]
            if now - last_used < self._ttl:
                self._engines[project_id] = (engine, now)
                return engine
            else:
                await engine.dispose()
                del self._engines[project_id]

        conn_str = decrypt_connection_string(encrypted_conn_str)
        engine = create_async_engine(
            conn_str,
            pool_size=2,
            max_overflow=3,
            pool_pre_ping=True,
            connect_args={"server_settings": {"statement_timeout": "30000"}},
        )
        self._engines[project_id] = (engine, now)
        return engine

    async def dispose_engine(self, project_id: int) -> None:
        if project_id in self._engines:
            engine, _ = self._engines[project_id]
            await engine.dispose()
            del self._engines[project_id]

    async def dispose_all(self) -> None:
        for engine, _ in self._engines.values():
            await engine.dispose()
        self._engines.clear()


# Singleton instance
tenant_db_manager = TenantDBManager()
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/tenant_db.py sql-chatbot/tests/test_tenant_db.py
git commit -m "feat: add tenant DB manager with connection pool caching and TTL eviction"
```

---

### Task 15: SQL Executor

**Files:**
- Create: `sql-chatbot/app/services/sql_executor.py`
- Create: `sql-chatbot/tests/test_sql_executor.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_sql_executor.py
import pytest
from app.services.sql_executor import SqlExecutor, SqlExecutionResult


async def test_execute_returns_rows_and_columns(db_engine):
    """Test with chatbot's own DB engine as a stand-in."""
    executor = SqlExecutor()
    # Use a simple query against SQLite
    result = await executor.execute(db_engine, "SELECT 1 as num, 'hello' as greeting")
    assert result.success is True
    assert result.columns == ["num", "greeting"]
    assert len(result.rows) == 1


async def test_execute_respects_max_rows(db_engine):
    executor = SqlExecutor(max_rows=2)
    result = await executor.execute(
        db_engine,
        "SELECT 1 as n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4"
    )
    assert result.success is True
    assert len(result.rows) <= 2
    assert result.total_row_count == 4  # Actual count before truncation


async def test_execute_error_returns_failure(db_engine):
    executor = SqlExecutor()
    result = await executor.execute(db_engine, "SELECT * FROM nonexistent_table_xyz")
    assert result.success is False
    assert result.error is not None
```

**Step 2: Run tests, verify fail**

**Step 3: Implement SqlExecutor**

```python
# sql-chatbot/app/services/sql_executor.py
import time
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass
class SqlExecutionResult:
    success: bool
    columns: list[str] = field(default_factory=list)
    rows: list[dict] = field(default_factory=list)
    total_row_count: int = 0
    execution_time_ms: float = 0.0
    error: str | None = None


class SqlExecutor:
    def __init__(self, max_rows: int = 500, max_rows_for_llm: int = 50):
        self.max_rows = max_rows
        self.max_rows_for_llm = max_rows_for_llm

    async def execute(self, engine: AsyncEngine, sql: str) -> SqlExecutionResult:
        start = time.monotonic()
        try:
            async with engine.connect() as conn:
                # Defense-in-depth: SET TRANSACTION READ ONLY
                # (Skipped for SQLite in tests, applied for PostgreSQL)
                try:
                    await conn.execute(text("SET TRANSACTION READ ONLY"))
                except Exception:
                    pass  # SQLite doesn't support this

                result = await conn.execute(text(sql))
                columns = list(result.keys())
                all_rows = [dict(zip(columns, row)) for row in result.fetchall()]
                elapsed = (time.monotonic() - start) * 1000

                return SqlExecutionResult(
                    success=True,
                    columns=columns,
                    rows=all_rows[:self.max_rows],
                    total_row_count=len(all_rows),
                    execution_time_ms=round(elapsed, 2),
                )
        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            return SqlExecutionResult(
                success=False,
                execution_time_ms=round(elapsed, 2),
                error=str(e),
            )
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/sql_executor.py sql-chatbot/tests/test_sql_executor.py
git commit -m "feat: add SQL executor with read-only enforcement and row limits"
```

---

## Phase 4: LLM Integration & Chat Flow

### Task 16: Knowledge Service

**Files:**
- Create: `sql-chatbot/app/services/knowledge_service.py`
- Create: `sql-chatbot/tests/test_knowledge_service.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_knowledge_service.py
import pytest
from app.services.knowledge_service import KnowledgeService
from app.models.knowledge_entry import KnowledgeEntry


async def test_load_and_format_entries(db_session):
    # Seed a project (need admin + project first)
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entries = [
        KnowledgeEntry(project_id=project.id, category="navigation", title="Find Jobs", content="Go to /admin/jobs"),
        KnowledgeEntry(project_id=project.id, category="workflow", title="Approve Contractor", content="Step 1: Go to contractors. Step 2: Click approve."),
    ]
    db_session.add_all(entries)
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert "Find Jobs" in formatted
    assert "Approve Contractor" in formatted
    assert "/admin/jobs" in formatted


async def test_inactive_entries_excluded(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks2@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    active = KnowledgeEntry(project_id=project.id, category="faq", title="Active", content="Visible")
    inactive = KnowledgeEntry(project_id=project.id, category="faq", title="Inactive", content="Hidden", is_active=False)
    db_session.add_all([active, inactive])
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert "Active" in formatted
    assert "Inactive" not in formatted
```

**Step 2: Run tests, verify fail**

**Step 3: Implement KnowledgeService**

Loads all active entries for a project, formats them as structured text for the LLM prompt context. Format:

```
## Admin Panel Knowledge Base

### [navigation] Find Jobs
Go to /admin/jobs
URL: /admin/jobs

### [workflow] Approve Contractor
Step 1: Go to contractors. Step 2: Click approve.
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/knowledge_service.py sql-chatbot/tests/test_knowledge_service.py
git commit -m "feat: add knowledge service for loading and formatting entries"
```

---

### Task 17: LLM Service (OpenAI Integration)

**Files:**
- Create: `sql-chatbot/app/services/llm_service.py`
- Create: `sql-chatbot/tests/test_llm_service.py`

**Step 1: Write failing tests with mocked OpenAI**

```python
# sql-chatbot/tests/test_llm_service.py
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.llm_service import LLMService, SqlGenerationResult


@pytest.fixture
def llm_service():
    return LLMService()


@patch("app.services.llm_service.openai_client")
async def test_generate_sql_data_question(mock_client, llm_service):
    """For a data question, generate_sql should return SQL."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.parsed = SqlGenerationResult(
        question_type="data",
        sql_query="SELECT count(*) FROM jobs WHERE status = 1",
        explanation="Counts active jobs",
        confidence=0.95,
    )
    mock_response.usage.total_tokens = 150
    mock_client.beta.chat.completions.parse = AsyncMock(return_value=mock_response)

    result = await llm_service.generate_sql(
        question="How many active jobs?",
        schema_text="CREATE TABLE jobs (id int, status int);",
        knowledge_text="",
        conversation_history=[],
    )
    assert result.question_type == "data"
    assert "SELECT" in result.sql_query
    assert result.confidence > 0.5


@patch("app.services.llm_service.openai_client")
async def test_generate_sql_guidance_question(mock_client, llm_service):
    """For a guidance question, sql_query should be None."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.parsed = SqlGenerationResult(
        question_type="guidance",
        sql_query=None,
        explanation="This is a guidance question about approving contractors",
        confidence=0.9,
    )
    mock_response.usage.total_tokens = 100
    mock_client.beta.chat.completions.parse = AsyncMock(return_value=mock_response)

    result = await llm_service.generate_sql(
        question="How do I approve a contractor?",
        schema_text="",
        knowledge_text="To approve a contractor, go to /admin/contractors...",
        conversation_history=[],
    )
    assert result.question_type == "guidance"
    assert result.sql_query is None


async def test_conversation_history_capped(llm_service):
    """History should be capped at last 10 messages."""
    history = [{"role": "user", "content": f"msg {i}"} for i in range(20)]
    capped = llm_service._cap_history(history)
    assert len(capped) == 10
    assert capped[0]["content"] == "msg 10"  # Last 10
```

**Step 2: Run tests, verify fail**

**Step 3: Implement LLMService**

Key implementation:
- Uses `openai.AsyncOpenAI` client
- `generate_sql()` — first call, uses structured output (Pydantic response_format):
  - System prompt includes: schema, knowledge base, classification rules, ambiguity handling
  - Conversation history capped to last 10 messages, max ~2000 tokens
  - Returns `SqlGenerationResult` (question_type, sql_query, explanation, confidence)
- `stream_answer()` — second call, returns async generator of SSE tokens:
  - Input differs by question type (data: SQL results, guidance: knowledge base)
  - Uses `stream=True` on OpenAI call
- `_cap_history(history, max_messages=10)` — caps conversation history

The system prompt for call 1 should include the ambiguity handling rule from the design doc:
> "If the question asks for counts, totals, lists, or specific records, classify as data. If it asks how to do something, where to find something, or what something means, classify as guidance. When genuinely ambiguous, prefer guidance."

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/services/llm_service.py sql-chatbot/tests/test_llm_service.py
git commit -m "feat: add LLM service with structured SQL generation and streaming answers"
```

---

### Task 18: Chat Stream Endpoint (The Main Flow)

**Files:**
- Create: `sql-chatbot/app/api/v1/conversations/__init__.py`
- Create: `sql-chatbot/app/api/v1/conversations/router.py`
- Create: `sql-chatbot/app/api/v1/conversations/schemas.py`
- Create: `sql-chatbot/app/api/v1/conversations/service.py`
- Create: `sql-chatbot/app/api/v1/conversations/models.py` (re-exports from app.models)
- Create: `sql-chatbot/tests/test_api/test_chat.py`

**Step 1: Write failing tests**

Test the full chat flow (with mocked OpenAI and mocked tenant DB):

```python
# sql-chatbot/tests/test_api/test_chat.py
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from httpx import ASGITransport, AsyncClient
from app.main import app


# Test that POST /api/v1/chat/stream with valid API key returns SSE stream
# Test that missing API key returns 401
# Test that invalid API key returns 401
# Test that conversation is created/reused based on session_id
# Test that messages are saved to DB after stream completes
```

The chat stream endpoint orchestrates the full flow from the design doc (steps 3-10):

1. Verify API key → load project
2. Load schema + knowledge in parallel
3. Call LLM generate_sql()
4. If data: validate SQL → execute SQL → stream answer with results
5. If guidance: stream answer with knowledge context
6. Save conversation + message + audit log

**Step 2: Run tests, verify fail**

**Step 3: Implement conversation schemas**

```python
# sql-chatbot/app/api/v1/conversations/schemas.py
from pydantic import BaseModel


class ChatRequest(BaseModel):
    question: str
    conversation_id: str | None = None  # udid of existing conversation
    session_id: str | None = None  # widget session ID


class ChatEvent(BaseModel):
    event: str  # "sql_generated", "message", "done", "error"
    data: dict
```

**Step 4: Implement conversation service**

Manages creation/retrieval of conversations and saving messages:
- `get_or_create_conversation(session, project_id, session_id, conversation_id)` → Conversation
- `save_message(session, conversation_id, role, content, question_type, sql_query, tokens)` → Message
- `get_history(session, conversation_id, limit=10)` → list of messages (for LLM context)

**Step 5: Implement the chat stream router**

```python
# sql-chatbot/app/api/v1/conversations/router.py
import json
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth.dependencies import verify_api_key
from app.api.v1.conversations.schemas import ChatRequest
from app.api.v1.conversations.service import ConversationService
from app.database import get_session
from app.models.api_key import ApiKey
from app.models.project import Project
from app.services.llm_service import LLMService
from app.services.sql_validator import SqlValidator
from app.services.sql_executor import SqlExecutor
from app.services.schema_inspector import SchemaInspector
from app.services.knowledge_service import KnowledgeService
from app.services.tenant_db import tenant_db_manager

router = APIRouter(tags=["chat"])
llm_service = LLMService()
sql_executor = SqlExecutor()
schema_inspector = SchemaInspector()
knowledge_service = KnowledgeService()
conversation_service = ConversationService()


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    request: Request,
    api_key: ApiKey = Depends(verify_api_key),
    session: AsyncSession = Depends(get_session),
):
    # Load project
    project = await session.get(Project, api_key.project_id)

    async def event_generator():
        # Get or create conversation
        conversation = await conversation_service.get_or_create_conversation(
            session, project.id, body.session_id, body.conversation_id
        )

        # Load conversation history (capped)
        history = await conversation_service.get_history(session, conversation.id)

        # Load schema (from cache or refresh)
        schema_text = project.schema_cache or ""
        if not schema_text:
            engine = await tenant_db_manager.get_engine(project.id, project.connection_string_encrypted)
            raw_schema = await schema_inspector.inspect_database(engine)
            stripped = schema_inspector.strip_sensitive_columns(raw_schema)
            schema_text = schema_inspector.format_for_prompt(stripped)
            # Cache it
            project.schema_cache = schema_text
            await session.commit()

        # Load knowledge base
        knowledge_text = await knowledge_service.load_for_prompt(session, project.id)

        # Save user message
        await conversation_service.save_message(session, conversation.id, "user", body.question)

        # FIRST LLM CALL: classify + generate SQL
        sql_result = await llm_service.generate_sql(
            question=body.question,
            schema_text=schema_text,
            knowledge_text=knowledge_text,
            conversation_history=history,
        )

        query_results = None
        if sql_result.question_type == "data" and sql_result.sql_query:
            # Validate SQL
            # Parse schema back to dict for validator
            schema_dict = schema_inspector.parse_schema_text(schema_text)
            validator = SqlValidator(schema=schema_dict)
            validation = validator.validate(sql_result.sql_query)

            if not validation.is_valid:
                yield {"event": "error", "data": json.dumps({
                    "message": "I generated an unsafe query and blocked it. Could you rephrase?"
                })}
                # Log rejection in audit
                return

            # Execute SQL
            yield {"event": "sql_generated", "data": json.dumps({
                "sql": validation.modified_sql,
                "explanation": sql_result.explanation,
            })}

            engine = await tenant_db_manager.get_engine(project.id, project.connection_string_encrypted)
            exec_result = await sql_executor.execute(engine, validation.modified_sql)

            if not exec_result.success:
                yield {"event": "error", "data": json.dumps({
                    "message": "I wrote a query the database couldn't run. Let me try differently."
                })}
                return

            query_results = exec_result

        # SECOND LLM CALL: stream answer
        full_response = ""
        async for token in llm_service.stream_answer(
            question=body.question,
            question_type=sql_result.question_type,
            sql_results=query_results,
            knowledge_text=knowledge_text,
            schema_text=schema_text,
        ):
            full_response += token
            yield {"event": "message", "data": json.dumps({"token": token})}

        yield {"event": "done", "data": json.dumps({"total_tokens": 0})}

        # Save assistant message
        await conversation_service.save_message(
            session, conversation.id, "assistant", full_response,
            question_type=sql_result.question_type,
            sql_query=sql_result.sql_query if sql_result.question_type == "data" else None,
        )

    return EventSourceResponse(event_generator())


@router.get("/conversations/{conversation_udid}")
async def get_conversation(
    conversation_udid: str,
    api_key: ApiKey = Depends(verify_api_key),
    session: AsyncSession = Depends(get_session),
):
    """Get conversation history for the widget."""
    messages = await conversation_service.get_messages_by_udid(session, conversation_udid, api_key.project_id)
    return {"messages": messages}
```

**Step 6: Register router in v1 aggregator**

**Step 7: Run tests, verify pass**

**Step 8: Commit**

```bash
git add sql-chatbot/app/api/v1/conversations/ sql-chatbot/tests/test_api/test_chat.py
git commit -m "feat: add chat stream endpoint with full query flow"
```

---

## Phase 5: Rate Limiting, Background Tasks, and Audit

### Task 19: Redis Rate Limiting Middleware

**Files:**
- Create: `sql-chatbot/app/core/rate_limiter.py`
- Modify: `sql-chatbot/app/core/middleware.py`
- Create: `sql-chatbot/tests/test_rate_limiter.py`

**Step 1: Write failing tests**

```python
# sql-chatbot/tests/test_rate_limiter.py
import pytest
from unittest.mock import AsyncMock

from app.core.rate_limiter import RateLimiter


async def test_allows_under_limit():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    allowed = await limiter.check("key:123:minute", limit=30, window_seconds=60)
    assert allowed is True


async def test_blocks_over_limit():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=31)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    allowed = await limiter.check("key:123:minute", limit=30, window_seconds=60)
    assert allowed is False
```

**Step 2: Run tests, verify fail**

**Step 3: Implement RateLimiter**

```python
# sql-chatbot/app/core/rate_limiter.py
from redis.asyncio import Redis


class RateLimiter:
    def __init__(self, redis: Redis):
        self._redis = redis

    async def check(self, key: str, limit: int, window_seconds: int) -> bool:
        current = await self._redis.incr(key)
        if current == 1:
            await self._redis.expire(key, window_seconds)
        return current <= limit
```

**Step 4: Integrate into middleware or dependency**

Create a FastAPI dependency that checks both per-minute and per-day rate limits for the API key. Used in the chat stream endpoint.

**Step 5: Add Redis connection to app lifespan**

In `app/main.py` lifespan:
```python
from redis.asyncio import from_url as redis_from_url

async with redis_from_url(settings.redis_url) as redis:
    app.state.redis = redis
    yield
```

**Step 6: Run tests, verify pass**

**Step 7: Commit**

```bash
git add sql-chatbot/app/core/rate_limiter.py sql-chatbot/app/core/middleware.py sql-chatbot/tests/test_rate_limiter.py
git commit -m "feat: add Redis-backed rate limiting"
```

---

### Task 20: Audit Logging Service

**Files:**
- Create: `sql-chatbot/app/services/audit_service.py`
- Create: `sql-chatbot/tests/test_audit_service.py`

**Step 1: Write failing tests**

Test that `log_event()` creates an AuditLog record with all required fields.

**Step 2: Run tests, verify fail**

**Step 3: Implement audit service**

Simple service that creates AuditLog records. Called from the chat stream endpoint after each request.

**Step 4: Integrate into chat stream endpoint** — add audit logging calls at each outcome (success, rejection, error, guidance, rate limit).

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add sql-chatbot/app/services/audit_service.py sql-chatbot/tests/test_audit_service.py
git commit -m "feat: add audit logging service"
```

---

### Task 21: Background Cleanup Task

**Files:**
- Create: `sql-chatbot/app/tasks/__init__.py`
- Create: `sql-chatbot/app/tasks/cleanup.py`
- Create: `sql-chatbot/tests/test_cleanup.py`

**Step 1: Write failing tests**

Test that cleanup deletes conversations older than TTL and their messages.

**Step 2: Run tests, verify fail**

**Step 3: Implement cleanup task**

Uses FastAPI `BackgroundTasks` or a scheduled task via `asyncio.create_task` in lifespan. Runs daily:
- Delete conversations where `updated_at < now - ttl_days`
- Delete associated messages (cascade or explicit)
- For production: drop old audit_log partitions

**Step 4: Register in app lifespan**

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add sql-chatbot/app/tasks/ sql-chatbot/tests/test_cleanup.py
git commit -m "feat: add background cleanup task for expired conversations"
```

---

## Phase 6: CLI & Docker

### Task 22: Admin CLI (create-admin command)

**Files:**
- Create: `sql-chatbot/app/cli.py`
- Create: `sql-chatbot/tests/test_cli.py`

**Step 1: Write failing test**

```python
# sql-chatbot/tests/test_cli.py
import pytest
from unittest.mock import patch, AsyncMock
from app.cli import create_admin_in_db


async def test_create_admin_stores_hashed_password(db_session):
    admin = await create_admin_in_db(db_session, "cli@test.com", "mypassword")
    assert admin.email == "cli@test.com"
    assert admin.password_hash != "mypassword"
    assert admin.role == "owner"
```

**Step 2: Run test, verify fail**

**Step 3: Implement CLI**

```python
# sql-chatbot/app/cli.py
import asyncio
import sys

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.admin import Admin


async def create_admin_in_db(session: AsyncSession, email: str, password: str) -> Admin:
    admin = Admin(email=email, password_hash=hash_password(password), role="owner")
    session.add(admin)
    await session.commit()
    await session.refresh(admin)
    return admin


async def main():
    if len(sys.argv) < 2:
        print("Usage: python -m app.cli create-admin --email <email>")
        sys.exit(1)

    command = sys.argv[1]
    if command == "create-admin":
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("command")
        parser.add_argument("--email", required=True)
        args = parser.parse_args()

        import getpass
        password = getpass.getpass("Password: ")

        from app.database import async_session_factory
        async with async_session_factory() as session:
            admin = await create_admin_in_db(session, args.email, password)
            print(f"Admin created: {admin.email} (id={admin.id})")


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add sql-chatbot/app/cli.py sql-chatbot/tests/test_cli.py
git commit -m "feat: add CLI for creating admin users"
```

---

### Task 23: Dockerfile + docker-compose.yml

**Files:**
- Create: `sql-chatbot/Dockerfile`
- Create: `sql-chatbot/docker-compose.yml`
- Create: `sql-chatbot/docker-entrypoint.sh`

**Step 1: Create Dockerfile**

```dockerfile
# sql-chatbot/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Copy app
COPY . .

# Entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/docker-entrypoint.sh"]
```

**Step 2: Create entrypoint script**

```bash
#!/bin/bash
# sql-chatbot/docker-entrypoint.sh
set -e

# Run migrations
alembic upgrade head

# Start server
exec gunicorn app.main:app \
    --worker-class uvicorn.workers.UvicornWorker \
    --workers ${WORKERS:-2} \
    --bind 0.0.0.0:8000 \
    --timeout 120
```

**Step 3: Create docker-compose.yml**

Per the design doc (with Redis added from Audit 4):

```yaml
# sql-chatbot/docker-compose.yml
services:
  api:
    build: .
    ports: ["8000:8000"]
    environment:
      DATABASE_URL: postgresql+asyncpg://chatbot:secret@db:5432/chatbot
      REDIS_URL: redis://redis:6379/0
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      JWT_SECRET_KEY: ${JWT_SECRET_KEY}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: chatbot
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: chatbot
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chatbot"]
      interval: 5s

volumes:
  pgdata:
```

**Step 4: Test Docker build**

Run: `cd sql-chatbot && docker compose build`
Expected: Build succeeds

**Step 5: Test Docker compose up**

Run: `cd sql-chatbot && docker compose up -d && docker compose logs api --tail=20`
Expected: API starts, health check passes

**Step 6: Commit**

```bash
git add sql-chatbot/Dockerfile sql-chatbot/docker-compose.yml sql-chatbot/docker-entrypoint.sh
git commit -m "feat: add Docker and docker-compose with PostgreSQL and Redis"
```

---

## Phase 7: Widget

### Task 24: Widget Build Setup (Vite + React IIFE)

**Files:**
- Create: `sql-chatbot/widget/package.json`
- Create: `sql-chatbot/widget/tsconfig.json`
- Create: `sql-chatbot/widget/vite.config.ts`
- Create: `sql-chatbot/widget/src/index.ts`
- Create: `sql-chatbot/widget/src/ChatWidget.tsx`
- Create: `sql-chatbot/widget/src/styles.css`

**Step 1: Create widget package.json**

```json
{
  "name": "sql-chatbot-widget",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0"
  }
}
```

**Step 2: Create vite.config.ts for IIFE library mode**

```typescript
// sql-chatbot/widget/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'SqlChatbot',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    outDir: 'dist',
    rollupOptions: {
      // Bundle everything into one file (no external deps)
    },
    cssCodeSplit: false, // Inline CSS into JS
  },
})
```

**Step 3: Implement widget entry point (Shadow DOM bootstrap)**

```typescript
// sql-chatbot/widget/src/index.ts
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { ChatWidget } from './ChatWidget'
import styles from './styles.css?inline'

;(function () {
  const script = document.currentScript as HTMLScriptElement
  const apiKey = script?.getAttribute('data-api-key') || ''
  const apiUrl = script?.getAttribute('data-api-url') || ''
  const position = script?.getAttribute('data-position') || 'bottom-right'

  // Create Shadow DOM host
  const host = document.createElement('div')
  host.id = 'sql-chatbot-host'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'closed' })

  // Inject styles into Shadow DOM
  const styleEl = document.createElement('style')
  styleEl.textContent = styles
  shadow.appendChild(styleEl)

  // Mount React into Shadow DOM
  const container = document.createElement('div')
  shadow.appendChild(container)

  const root = createRoot(container)
  root.render(createElement(ChatWidget, { apiKey, apiUrl, position }))
})()
```

**Step 4: Implement ChatWidget component**

```tsx
// sql-chatbot/widget/src/ChatWidget.tsx
import { useState, useRef, useEffect } from 'react'

interface Props {
  apiKey: string
  apiUrl: string
  position: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  sql?: string
}

export function ChatWidget({ apiKey, apiUrl, position }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Session ID from localStorage
  const sessionId = useRef(
    localStorage.getItem('sql-chatbot-session') ||
    (() => {
      const id = crypto.randomUUID()
      localStorage.setItem('sql-chatbot-session', id)
      return id
    })()
  )

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(scrollToBottom, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: question }])
    setLoading(true)

    try {
      const resp = await fetch(`${apiUrl}/api/v1/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ question, session_id: sessionId.current }),
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let currentSql = ''

      setMessages(prev => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.token) {
                assistantMsg += data.token
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: assistantMsg,
                    sql: currentSql || undefined,
                  }
                  return updated
                })
              }
            } catch { /* ignore parse errors for non-JSON lines */ }
          } else if (line.startsWith('event: sql_generated')) {
            // Next data line will have SQL info
          }
        }
      }
    } catch (err) {
      setMessages(prev => [
        ...prev.slice(0, -1), // Remove empty assistant message if exists
        { role: 'assistant', content: 'Something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  // Render floating chat button + panel
  return (
    <div className={`chatbot-container ${position}`}>
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-header">
            <span>AI Assistant</span>
            <button onClick={() => setOpen(false)}>&times;</button>
          </div>
          <div className="chatbot-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chatbot-msg ${msg.role}`}>
                {msg.content || (loading && i === messages.length - 1 ? '...' : '')}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="chatbot-input">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
              placeholder="Ask a question..."
              disabled={loading}
            />
            <button onClick={sendMessage} disabled={loading}>Send</button>
          </div>
        </div>
      )}
      <button className="chatbot-fab" onClick={() => setOpen(!open)}>
        {open ? '✕' : '💬'}
      </button>
    </div>
  )
}
```

**Step 5: Create styles.css**

Minimal, clean chat widget styles. The CSS is injected into Shadow DOM so it won't conflict with the host page.

**Step 6: Install dependencies and build**

Run: `cd sql-chatbot/widget && npm install && npm run build`
Expected: `dist/widget.js` is created as a single IIFE file.

**Step 7: Commit**

```bash
git add sql-chatbot/widget/
git commit -m "feat: add embeddable React chat widget with Shadow DOM isolation"
```

---

### Task 25: Widget Serving Endpoint

**Files:**
- Create: `sql-chatbot/app/api/v1/widget/__init__.py`
- Create: `sql-chatbot/app/api/v1/widget/router.py`
- Create: `sql-chatbot/tests/test_api/test_widget.py`

**Step 1: Write failing test**

```python
# sql-chatbot/tests/test_api/test_widget.py
import pytest
from httpx import ASGITransport, AsyncClient
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_widget_js_endpoint(client):
    resp = await client.get("/widget/widget.js")
    assert resp.status_code == 200
    assert "text/javascript" in resp.headers.get("content-type", "")
```

**Step 2: Run test, verify fail**

**Step 3: Implement widget router**

```python
# sql-chatbot/app/api/v1/widget/router.py
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter(tags=["widget"])

WIDGET_PATH = Path(__file__).resolve().parents[4] / "widget" / "dist" / "widget.js"


@router.get("/widget/widget.js")
async def serve_widget():
    return FileResponse(
        WIDGET_PATH,
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )
```

**Step 4: Register in main app (at root, not under /api/v1)**

**Step 5: Run test, verify pass**

**Step 6: Commit**

```bash
git add sql-chatbot/app/api/v1/widget/ sql-chatbot/tests/test_api/test_widget.py
git commit -m "feat: add widget.js serving endpoint"
```

---

## Phase 8: Integration Testing & Polish

### Task 26: Integration Test — Full Chat Flow

**Files:**
- Create: `sql-chatbot/tests/test_integration/__init__.py`
- Create: `sql-chatbot/tests/test_integration/test_full_flow.py`

**Step 1: Write integration test**

End-to-end test (with mocked OpenAI) that:
1. Creates an admin (via CLI helper)
2. Logs in → gets JWT
3. Creates a project
4. Creates an API key
5. Adds knowledge entries
6. Sends a chat question via API key
7. Verifies SSE response stream
8. Verifies conversation/message saved in DB
9. Verifies audit log created

This uses the ASGI test client and dependency overrides, no Docker needed.

**Step 2: Run test, verify it works end-to-end**

**Step 3: Commit**

```bash
git add sql-chatbot/tests/test_integration/
git commit -m "test: add full-flow integration test for chat pipeline"
```

---

### Task 27: Run Full Test Suite + Lint

**Step 1: Run all tests**

Run: `cd sql-chatbot && pytest -v --tb=short`
Expected: All tests pass

**Step 2: Run linter**

Run: `cd sql-chatbot && ruff check .`
Expected: No errors (or fix any that appear)

**Step 3: Run formatter**

Run: `cd sql-chatbot && ruff format .`

**Step 4: Commit any fixes**

```bash
git add -A sql-chatbot/
git commit -m "chore: fix linting issues and format code"
```

---

### Task 28: Docker Compose Full Stack Test

**Step 1: Build and start all services**

Run: `cd sql-chatbot && docker compose up --build -d`

**Step 2: Wait for healthy**

Run: `docker compose ps` — verify all services show "healthy"

**Step 3: Create first admin**

Run: `docker compose exec api python -m app.cli create-admin --email admin@test.com`

**Step 4: Test login**

Run: `curl -X POST http://localhost:8000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"admin@test.com","password":"<password>"}'`
Expected: JWT token returned

**Step 5: Create project, API key, test chat**

Use curl commands to exercise the full API.

**Step 6: Tear down**

Run: `docker compose down -v`

**Step 7: Commit any fixes**

```bash
git add sql-chatbot/
git commit -m "test: verify Docker compose full stack deployment"
```

---

## Summary

| Phase | Tasks | What's Built |
|-------|-------|-------------|
| 1: Scaffolding | 1-7 | Project structure, DB, models, config, security, exceptions, FastAPI skeleton |
| 2: Auth & Admin API | 8-11 | JWT auth, admin login, projects CRUD, API keys, knowledge base CRUD |
| 3: SQL Security | 12-15 | SQL validator (5 layers), schema inspector, tenant DB manager, SQL executor |
| 4: LLM & Chat | 16-18 | Knowledge service, LLM service (OpenAI), chat stream endpoint |
| 5: Rate Limiting & Audit | 19-21 | Redis rate limiting, audit logging, background cleanup |
| 6: CLI & Docker | 22-23 | Admin CLI, Dockerfile, docker-compose |
| 7: Widget | 24-25 | React IIFE widget, Shadow DOM, SSE streaming, widget serving |
| 8: Integration | 26-28 | Full flow tests, lint, Docker stack test |

**Total: 28 tasks, ~150 bite-sized steps.**

Each task follows TDD: write failing test → run to confirm failure → implement → run to confirm pass → commit.
