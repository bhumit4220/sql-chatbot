import logging
from dataclasses import dataclass, field

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

SENSITIVE_PATTERNS = [
    "password",
    "pwd",
    "token",
    "secret",
    "ssn",
    "api_key",
    "salt",
]

SENSITIVE_PREFIXES = ["encr_", "stripe_", "bank_"]


@dataclass
class ColumnInfo:
    name: str
    type: str
    nullable: bool
    default: str | None = None
    comment: str | None = None
    is_pk: bool = False


@dataclass
class ForeignKey:
    constrained_columns: list[str]
    referred_table: str
    referred_columns: list[str]


@dataclass
class IndexInfo:
    name: str
    columns: list[str]
    unique: bool


@dataclass
class TableInfo:
    name: str
    columns: list[ColumnInfo]
    primary_key: list[str]
    foreign_keys: list[ForeignKey]
    indexes: list[IndexInfo]
    comment: str | None = None


@dataclass
class RichSchema:
    tables: dict[str, TableInfo] = field(default_factory=dict)


class SchemaInspector:
    def _is_sensitive(self, column_name: str) -> bool:
        col_lower = column_name.lower()
        for pattern in SENSITIVE_PATTERNS:
            if pattern in col_lower:
                return True
        for prefix in SENSITIVE_PREFIXES:
            if col_lower.startswith(prefix):
                return True
        return False

    async def inspect_database(self, engine: AsyncEngine) -> dict[str, list[str]]:
        """Inspect a live database and return {table_name: [column_names]}."""
        schema: dict[str, list[str]] = {}

        def _sync_inspect(connection):
            insp = inspect(connection)
            for table_name in insp.get_table_names():
                columns = insp.get_columns(table_name)
                schema[table_name] = [col["name"] for col in columns]

        async with engine.connect() as conn:
            await conn.run_sync(_sync_inspect)

        return schema

    async def inspect_database_rich(
        self, engine: AsyncEngine, exclude_tables: list[str] | None = None
    ) -> RichSchema:
        """Inspect a live database and return full metadata per table.

        Returns RichSchema with column types, FKs, PKs, indexes, and comments.
        Sensitive columns are excluded. Tables in exclude_tables are skipped.
        """
        rich = RichSchema()
        exclude_set = set(exclude_tables) if exclude_tables else set()

        def _sync_inspect(connection):
            insp = inspect(connection)
            for table_name in insp.get_table_names():
                if table_name in exclude_set:
                    continue

                # Columns
                raw_columns = insp.get_columns(table_name)
                columns = []
                for col in raw_columns:
                    if self._is_sensitive(col["name"]):
                        continue
                    type_str = str(col["type"])
                    # Clean up common verbose type representations
                    if hasattr(col["type"], "__class__"):
                        type_str = col["type"].__class__.__name__
                        # Add length/precision for common types
                        try:
                            if hasattr(col["type"], "length") and col["type"].length:
                                type_str = f"{type_str}({col['type'].length})"
                            elif hasattr(col["type"], "precision") and col["type"].precision:
                                scale = getattr(col["type"], "scale", None)
                                if scale is not None:
                                    type_str = f"{type_str}({col['type'].precision},{scale})"
                                else:
                                    type_str = f"{type_str}({col['type'].precision})"
                        except Exception:
                            pass

                    default_val = None
                    if col.get("default") is not None:
                        default_val = str(col["default"])

                    columns.append(
                        ColumnInfo(
                            name=col["name"],
                            type=type_str,
                            nullable=col.get("nullable", True),
                            default=default_val,
                            comment=col.get("comment"),
                        )
                    )

                # Primary key
                try:
                    pk = insp.get_pk_constraint(table_name)
                    pk_columns = pk.get("constrained_columns", []) if pk else []
                except Exception:
                    pk_columns = []

                # Mark PK columns
                pk_set = set(pk_columns)
                for c in columns:
                    if c.name in pk_set:
                        c.is_pk = True

                # Foreign keys
                foreign_keys = []
                try:
                    for fk in insp.get_foreign_keys(table_name):
                        foreign_keys.append(
                            ForeignKey(
                                constrained_columns=fk["constrained_columns"],
                                referred_table=fk["referred_table"],
                                referred_columns=fk["referred_columns"],
                            )
                        )
                except Exception:
                    pass

                # Indexes
                indexes = []
                try:
                    for idx in insp.get_indexes(table_name):
                        indexes.append(
                            IndexInfo(
                                name=idx.get("name", ""),
                                columns=idx.get("column_names", []),
                                unique=idx.get("unique", False),
                            )
                        )
                except Exception:
                    pass

                # Table comment
                try:
                    table_comment = insp.get_table_comment(table_name)
                    comment_text = table_comment.get("text") if table_comment else None
                except Exception:
                    comment_text = None

                rich.tables[table_name] = TableInfo(
                    name=table_name,
                    columns=columns,
                    primary_key=pk_columns,
                    foreign_keys=foreign_keys,
                    indexes=indexes,
                    comment=comment_text,
                )

        async with engine.connect() as conn:
            await conn.run_sync(_sync_inspect)

        logger.info(
            "Rich inspection complete: %d tables (%d excluded)",
            len(rich.tables),
            len(exclude_set),
        )
        return rich

    def strip_sensitive_columns(self, schema: dict[str, list[str]]) -> dict[str, list[str]]:
        """Remove columns matching sensitive patterns."""
        return {
            table: [col for col in columns if not self._is_sensitive(col)]
            for table, columns in schema.items()
        }

    def format_for_prompt(
        self,
        schema: dict[str, list[str]],
        exclude_tables: list[str] | None = None,
    ) -> str:
        """Format schema as CREATE TABLE statements for LLM context.

        Args:
            schema: {table_name: [column_names]} dict
            exclude_tables: Tables to omit from the prompt output
        """
        exclude_set = set(exclude_tables) if exclude_tables else set()
        lines = []
        for table, columns in sorted(schema.items()):
            if table in exclude_set:
                continue
            cols = ", ".join(columns)
            lines.append(f"TABLE {table} ({cols})")
        return "\n".join(lines)
