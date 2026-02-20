import time
from unittest.mock import patch

import pytest

from app.services.tenant_db import TenantDBManager
from app.core.security import encrypt_connection_string


@pytest.fixture
def encrypted_sqlite_url():
    """Encrypt a SQLite connection string for testing."""
    return encrypt_connection_string("sqlite+aiosqlite:///:memory:")


@pytest.fixture
def manager():
    return TenantDBManager(ttl_seconds=5)


async def test_get_engine_returns_async_engine(manager, encrypted_sqlite_url):
    engine = await manager.get_engine(1, encrypted_sqlite_url)
    assert engine is not None
    # Should have a url attribute (AsyncEngine)
    assert "sqlite" in str(engine.url)
    await manager.dispose_all()


async def test_get_engine_caches_same_project(manager, encrypted_sqlite_url):
    engine1 = await manager.get_engine(1, encrypted_sqlite_url)
    engine2 = await manager.get_engine(1, encrypted_sqlite_url)
    assert engine1 is engine2
    await manager.dispose_all()


async def test_different_projects_get_different_engines(manager, encrypted_sqlite_url):
    engine1 = await manager.get_engine(1, encrypted_sqlite_url)
    engine2 = await manager.get_engine(2, encrypted_sqlite_url)
    assert engine1 is not engine2
    await manager.dispose_all()


async def test_engine_evicted_after_ttl(encrypted_sqlite_url):
    manager = TenantDBManager(ttl_seconds=1)
    engine1 = await manager.get_engine(1, encrypted_sqlite_url)

    # Simulate time passing beyond TTL
    with patch("app.services.tenant_db.time") as mock_time:
        # First call sets the baseline time
        mock_time.monotonic.return_value = time.monotonic() + 100
        engine2 = await manager.get_engine(1, encrypted_sqlite_url)

    assert engine1 is not engine2
    await manager.dispose_all()


async def test_dispose_engine_removes_from_cache(manager, encrypted_sqlite_url):
    engine1 = await manager.get_engine(1, encrypted_sqlite_url)
    await manager.dispose_engine(1)
    engine2 = await manager.get_engine(1, encrypted_sqlite_url)
    assert engine1 is not engine2
    await manager.dispose_all()


async def test_dispose_engine_nonexistent_is_noop(manager):
    # Should not raise
    await manager.dispose_engine(999)


async def test_dispose_all_clears_cache(manager, encrypted_sqlite_url):
    await manager.get_engine(1, encrypted_sqlite_url)
    await manager.get_engine(2, encrypted_sqlite_url)
    await manager.dispose_all()
    # After dispose_all, getting engine should create new ones
    # Verify internal cache is empty
    assert len(manager._engines) == 0
