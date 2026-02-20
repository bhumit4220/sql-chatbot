import logging
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.services.schema_inspector import RichSchema, SENSITIVE_PATTERNS, SENSITIVE_PREFIXES

logger = logging.getLogger(__name__)

# PII columns — never sample actual string values
PII_PATTERNS = [
    "email", "phone", "mobile", "address", "street", "zip", "postal",
    "first_name", "last_name", "full_name", "name", "dob", "birth",
    "social", "tax_id", "license", "passport", "ip_address",
]

# Max distinct values for a column to be considered enum-like
MAX_ENUM_CARDINALITY = 50

# Timeouts
QUERY_TIMEOUT_MS = 2000  # per-query
TOTAL_TIMEOUT_SECONDS = 60  # per-project

# Integer-like type names (case-insensitive prefix match)
INTEGER_TYPES = {"integer", "bigint", "smallint", "int", "int2", "int4", "int8"}

# Boolean-like type names
BOOLEAN_TYPES = {"boolean", "bool"}

# Short string types worth checking cardinality (but never sampling values for PII)
SHORT_STRING_MAX_LENGTH = 100


@dataclass
class ColumnSample:
    table: str
    column: str
    column_type: str
    distinct_count: int
    values: list[dict] | None = None  # [{"val": "1", "cnt": 1234}, ...]
    skipped_reason: str | None = None  # "pii", "high_cardinality", "sensitive", "timeout"


@dataclass
class SamplerResult:
    samples: list[ColumnSample] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    tables_sampled: int = 0


def _is_pii(column_name: str) -> bool:
    col_lower = column_name.lower()
    for pattern in PII_PATTERNS:
        if pattern in col_lower:
            return True
    return False


def _is_sensitive(column_name: str) -> bool:
    col_lower = column_name.lower()
    for pattern in SENSITIVE_PATTERNS:
        if pattern in col_lower:
            return True
    for prefix in SENSITIVE_PREFIXES:
        if col_lower.startswith(prefix):
            return True
    return False


def _is_integer_type(type_str: str) -> bool:
    type_lower = type_str.lower().split("(")[0].strip()
    return type_lower in INTEGER_TYPES


def _is_boolean_type(type_str: str) -> bool:
    type_lower = type_str.lower().split("(")[0].strip()
    return type_lower in BOOLEAN_TYPES


def _is_short_string_type(type_str: str) -> bool:
    type_lower = type_str.lower()
    if not type_lower.startswith("varchar"):
        return False
    # Check length if specified
    if "(" in type_lower:
        try:
            length = int(type_lower.split("(")[1].rstrip(")"))
            return length <= SHORT_STRING_MAX_LENGTH
        except (ValueError, IndexError):
            return False
    return True


def _quote_ident(name: str) -> str:
    """Quote a SQL identifier to prevent injection. Double any internal double-quotes."""
    return '"' + name.replace('"', '""') + '"'


class DataSampler:
    """Samples enum-like columns from a target database with PII protection."""

    async def sample_database(
        self, engine: AsyncEngine, rich_schema: RichSchema
    ) -> SamplerResult:
        """Sample enum-like columns from all tables in the schema.

        Uses a fresh connection per table to isolate failures (e.g., corrupted
        tables don't cascade-abort sampling of subsequent tables).

        Args:
            engine: Async engine connected to the target database.
            rich_schema: Rich schema from SchemaInspector.inspect_database_rich().

        Returns:
            SamplerResult with column samples and any errors.
        """
        result = SamplerResult()
        import time
        start = time.monotonic()

        for table_name, table_info in sorted(rich_schema.tables.items()):
            if time.monotonic() - start > TOTAL_TIMEOUT_SECONDS:
                result.errors.append(
                    f"Total timeout ({TOTAL_TIMEOUT_SECONDS}s) reached after "
                    f"{result.tables_sampled} tables"
                )
                break

            result.tables_sampled += 1
            await self._sample_table(engine, table_name, table_info, result, start)

        logger.info(
            "Sampling complete: %d tables, %d samples, %d errors",
            result.tables_sampled,
            len(result.samples),
            len(result.errors),
        )
        return result

    async def _sample_table(
        self,
        engine: AsyncEngine,
        table_name: str,
        table_info,
        result: SamplerResult,
        start: float,
    ) -> None:
        """Sample all eligible columns from a single table using its own connection."""
        import time

        try:
            async with engine.connect() as conn:
                # Read-only + per-query timeout
                await conn.execute(text("SET TRANSACTION READ ONLY"))
                await conn.execute(
                    text(f"SET LOCAL statement_timeout = '{QUERY_TIMEOUT_MS}'")
                )

                for col in table_info.columns:
                    if time.monotonic() - start > TOTAL_TIMEOUT_SECONDS:
                        break

                    if _is_sensitive(col.name):
                        continue

                    is_int = _is_integer_type(col.type)
                    is_bool = _is_boolean_type(col.type)
                    is_short_str = _is_short_string_type(col.type)

                    if not (is_int or is_bool or is_short_str):
                        continue

                    is_pii = _is_pii(col.name)
                    quoted_table = _quote_ident(table_name)
                    quoted_col = _quote_ident(col.name)

                    try:
                        # Check cardinality
                        count_sql = text(
                            f"SELECT COUNT(DISTINCT {quoted_col}) FROM {quoted_table}"
                        )
                        count_result = await conn.execute(count_sql)
                        distinct_count = count_result.scalar() or 0

                        if distinct_count > MAX_ENUM_CARDINALITY:
                            result.samples.append(
                                ColumnSample(
                                    table=table_name,
                                    column=col.name,
                                    column_type=col.type,
                                    distinct_count=distinct_count,
                                    skipped_reason="high_cardinality",
                                )
                            )
                            continue

                        if distinct_count == 0:
                            continue

                        # PII string columns: only report cardinality
                        if is_pii and is_short_str:
                            result.samples.append(
                                ColumnSample(
                                    table=table_name,
                                    column=col.name,
                                    column_type=col.type,
                                    distinct_count=distinct_count,
                                    skipped_reason="pii",
                                )
                            )
                            continue

                        # Sample actual values
                        sample_sql = text(
                            f"SELECT {quoted_col}::text AS val, COUNT(*) AS cnt "
                            f"FROM {quoted_table} "
                            f"GROUP BY {quoted_col} "
                            f"ORDER BY cnt DESC LIMIT 50"
                        )
                        sample_result = await conn.execute(sample_sql)
                        rows = sample_result.fetchall()

                        values = [{"val": row[0], "cnt": row[1]} for row in rows]
                        result.samples.append(
                            ColumnSample(
                                table=table_name,
                                column=col.name,
                                column_type=col.type,
                                distinct_count=distinct_count,
                                values=values,
                            )
                        )

                    except Exception as e:
                        error_msg = str(e)
                        if "statement timeout" in error_msg.lower():
                            result.samples.append(
                                ColumnSample(
                                    table=table_name,
                                    column=col.name,
                                    column_type=col.type,
                                    distinct_count=0,
                                    skipped_reason="timeout",
                                )
                            )
                        else:
                            result.errors.append(
                                f"{table_name}.{col.name}: {error_msg[:200]}"
                            )
                        # Transaction is aborted, skip remaining columns in this table
                        return

        except Exception as e:
            result.errors.append(f"{table_name}: connection error: {str(e)[:200]}")
