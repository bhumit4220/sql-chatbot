from app.services.schema_inspector import SchemaInspector


def test_strips_sensitive_columns():
    """Columns matching sensitive patterns should be removed."""
    raw_schema = {
        "users": ["id", "name", "email", "password_hash", "auth_token", "api_key_hash"],
        "jobs": ["id", "title", "status"],
    }
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)

    assert "password_hash" not in stripped["users"]
    assert "auth_token" not in stripped["users"]
    assert "api_key_hash" not in stripped["users"]
    assert "id" in stripped["users"]
    assert "name" in stripped["users"]
    assert stripped["jobs"] == ["id", "title", "status"]


def test_strips_encr_prefix_columns():
    raw_schema = {"users": ["id", "encr_pwd", "encr_data"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert stripped["users"] == ["id"]


def test_strips_stripe_prefix_columns():
    raw_schema = {"payments": ["id", "amount", "stripe_customer_id", "stripe_token"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert "stripe_customer_id" not in stripped["payments"]
    assert "stripe_token" not in stripped["payments"]
    assert "amount" in stripped["payments"]


def test_strips_bank_prefix_columns():
    raw_schema = {"contractors": ["id", "name", "bank_account", "bank_routing"]}
    inspector = SchemaInspector()
    stripped = inspector.strip_sensitive_columns(raw_schema)
    assert "bank_account" not in stripped["contractors"]


def test_format_schema_for_prompt():
    schema = {
        "jobs": ["id", "title", "status", "created_at"],
        "customers": ["id", "name", "email"],
    }
    inspector = SchemaInspector()
    prompt_text = inspector.format_for_prompt(schema)
    assert "jobs" in prompt_text
    assert "id" in prompt_text
    assert "customers" in prompt_text
