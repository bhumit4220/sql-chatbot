import pytest

from app.services.sql_executor import SqlExecutor, SqlExecutionResult


async def test_execute_returns_rows_and_columns(db_engine):
    """Test with chatbot's own DB engine as a stand-in."""
    executor = SqlExecutor()
    result = await executor.execute(db_engine, "SELECT 1 as num, 'hello' as greeting")
    assert result.success is True
    assert result.columns == ["num", "greeting"]
    assert len(result.rows) == 1
    assert result.rows[0] == {"num": 1, "greeting": "hello"}


async def test_execute_respects_max_rows(db_engine):
    executor = SqlExecutor(max_rows=2)
    result = await executor.execute(
        db_engine,
        "SELECT 1 as n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4",
    )
    assert result.success is True
    assert len(result.rows) == 2
    assert result.total_row_count == 4


async def test_execute_error_returns_failure(db_engine):
    executor = SqlExecutor()
    result = await executor.execute(db_engine, "SELECT * FROM nonexistent_table_xyz")
    assert result.success is False
    assert result.error is not None


async def test_execution_time_is_recorded(db_engine):
    executor = SqlExecutor()
    result = await executor.execute(db_engine, "SELECT 1")
    assert result.success is True
    assert result.execution_time_ms >= 0


async def test_empty_result_set(db_engine):
    executor = SqlExecutor()
    # Query the existing admins table which should be empty in test DB
    result = await executor.execute(db_engine, "SELECT * FROM admins")
    assert result.success is True
    assert result.columns  # Should have column names
    assert len(result.rows) == 0
    assert result.total_row_count == 0
