import os

from cryptography.fernet import Fernet

# Use SQLite for tests (override before any import of settings)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/1")
os.environ.setdefault("OPENAI_API_KEY", "sk-test-fake-key")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENCRYPTION_KEY", Fernet.generate_key().decode())

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.base import Base


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def db_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    # Exclude tables with PostgreSQL-specific types (JSONB, Vector) that SQLite can't handle
    sqlite_tables = [
        t for t in Base.metadata.sorted_tables if t.name != "schema_documents"
    ]
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=sqlite_tables)
    yield engine
    await engine.dispose()


@pytest.fixture
async def db_session(db_engine):
    session_factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
        await session.rollback()
