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
    def __init__(self, max_rows: int = 500):
        self.max_rows = max_rows

    async def execute(self, engine: AsyncEngine, sql: str) -> SqlExecutionResult:
        start = time.monotonic()
        try:
            async with engine.connect() as conn:
                # Defense-in-depth: SET TRANSACTION READ ONLY (PostgreSQL only)
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
                    rows=all_rows[: self.max_rows],
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
