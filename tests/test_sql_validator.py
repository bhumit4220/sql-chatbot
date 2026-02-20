import pytest
from app.services.sql_validator import SqlValidator, SqlValidationResult


@pytest.fixture
def validator():
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
