import re
from dataclasses import dataclass

import sqlglot
import sqlparse
from sqlglot import exp


@dataclass
class SqlValidationResult:
    is_valid: bool
    modified_sql: str = ""
    rejection_reason: str = ""


BLOCKED_KEYWORDS = {
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "TRUNCATE",
    "ALTER",
    "CREATE",
    "GRANT",
    "REVOKE",
    "EXECUTE",
    "COPY",
    "PREPARE",
    "DO",
    "SET ROLE",
    "SET SESSION",
}

BLOCKED_FUNCTIONS = {
    "pg_read_file",
    "pg_ls_dir",
    "pg_stat_file",
    "dblink",
    "lo_import",
    "lo_export",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_sleep",
    "current_setting",
}

BLOCKED_CATALOGS = {
    "pg_stat_activity",
    "pg_roles",
    "pg_shadow",
    "pg_authid",
}

MAX_LIMIT = 500


class SqlValidator:
    def __init__(self, schema: dict[str, list[str]], exclude_tables: list[str] | None = None):
        """schema: {"table_name": ["col1", "col2", ...], ...}"""
        self.schema = schema
        self._all_columns: set[str] = set()
        for cols in schema.values():
            self._all_columns.update(c.lower() for c in cols)
        self._exclude_tables: set[str] = {t.lower() for t in (exclude_tables or [])}

    def validate(self, sql: str) -> SqlValidationResult:
        # Layer 2: sqlparse — single statement, SELECT only
        parsed = sqlparse.parse(sql)
        if len(parsed) != 1:
            return SqlValidationResult(False, rejection_reason="Multiple statements detected")
        stmt = parsed[0]
        if stmt.get_type() != "SELECT":
            return SqlValidationResult(
                False, rejection_reason=f"Statement type '{stmt.get_type()}' not allowed, only SELECT"
            )

        # Layer 4: Keyword blocklist (uppercase check with word boundaries)
        sql_upper = sql.upper()
        for keyword in BLOCKED_KEYWORDS:
            if keyword in sql_upper:
                if re.search(rf"\b{keyword}\b", sql_upper):
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
            exp.Insert,
            exp.Update,
            exp.Delete,
            exp.Drop,
            exp.Create,
            exp.Alter,
            exp.Grant,
            exp.Command,
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
                if col_name == "*":
                    continue
                if col_name not in self._all_columns:
                    return SqlValidationResult(
                        False,
                        rejection_reason=f"Column '{node.name}' does not exist in the schema",
                    )

        # Excluded table check (I8 — reject queries referencing excluded tables)
        if self._exclude_tables:
            for node in ast.walk():
                if isinstance(node, exp.Table):
                    table_name = node.name.lower()
                    if table_name in self._exclude_tables:
                        return SqlValidationResult(
                            False,
                            rejection_reason=f"Table '{node.name}' is excluded from queries",
                        )

        # Force LIMIT if missing
        modified = sql
        if not any(isinstance(node, exp.Limit) for node in ast.walk()):
            modified = f"{sql.rstrip().rstrip(';')} LIMIT {MAX_LIMIT}"

        return SqlValidationResult(is_valid=True, modified_sql=modified)
