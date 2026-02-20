import time

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.core.security import decrypt_connection_string


class TenantDBManager:
    def __init__(self, ttl_seconds: int = 1800):
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
        kwargs: dict = {"pool_pre_ping": True}
        if not conn_str.startswith("sqlite"):
            kwargs.update(pool_size=2, max_overflow=3)
        engine = create_async_engine(conn_str, **kwargs)
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


tenant_db_manager = TenantDBManager()
