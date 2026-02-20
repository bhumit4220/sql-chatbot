from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine

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

    def strip_sensitive_columns(self, schema: dict[str, list[str]]) -> dict[str, list[str]]:
        """Remove columns matching sensitive patterns."""
        return {table: [col for col in columns if not self._is_sensitive(col)] for table, columns in schema.items()}

    def format_for_prompt(self, schema: dict[str, list[str]]) -> str:
        """Format schema as CREATE TABLE statements for LLM context."""
        lines = []
        for table, columns in sorted(schema.items()):
            cols = ", ".join(columns)
            lines.append(f"TABLE {table} ({cols})")
        return "\n".join(lines)
