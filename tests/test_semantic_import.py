import pytest

from app.models.admin import Admin
from app.models.project import Project
from app.models.knowledge_entry import KnowledgeEntry
from app.api.v1.knowledge.semantic_schemas import (
    SemanticContextImport, EnumMappingItem, ColumnDescriptionItem,
    BusinessRuleItem, MetricDefinitionItem, VerifiedQueryItem,
)
from app.api.v1.knowledge.service import import_semantic_context, list_entries, create_entry


@pytest.fixture
async def project(db_session):
    admin = Admin(email="sem@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    p = Project(name="SemTest", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(p)
    await db_session.flush()
    return p


async def test_import_enum_mappings(db_session, project):
    payload = SemanticContextImport(
        enum_mappings=[
            EnumMappingItem(table="contractors", column="status",
                           mappings={"1": "Active", "3": "Deleted"}),
        ]
    )
    result = await import_semantic_context(db_session, project.id, payload)
    assert result["created_count"] == 1
    assert result["categories"]["enum_mapping"] == 1

    items, _, _ = await list_entries(db_session, project.id)
    assert items[0].category == "enum_mapping"
    assert items[0].metadata_json["mappings"]["1"] == "Active"
    assert "contractors.status" in items[0].content


async def test_import_full_payload(db_session, project):
    payload = SemanticContextImport(
        enum_mappings=[EnumMappingItem(table="t", column="c", mappings={"1": "A"})],
        column_descriptions=[ColumnDescriptionItem(table="t", column="c", description="desc")],
        business_rules=[BusinessRuleItem(title="Rule", rule="Do this")],
        metric_definitions=[MetricDefinitionItem(name="Rev", sql_expression="SUM(x)", description="Revenue")],
        verified_queries=[VerifiedQueryItem(question="How many?", sql="SELECT COUNT(*) FROM t")],
    )
    result = await import_semantic_context(db_session, project.id, payload)
    assert result["created_count"] == 5
    assert len(result["categories"]) == 5


async def test_import_replaces_semantic_preserves_other(db_session, project):
    # Create a non-semantic entry
    await create_entry(db_session, project.id, "navigation", "Dashboard", "/admin")
    await db_session.flush()

    # First semantic import
    payload1 = SemanticContextImport(
        business_rules=[BusinessRuleItem(title="Old Rule", rule="old")]
    )
    await import_semantic_context(db_session, project.id, payload1)
    await db_session.flush()

    # Second import replaces semantic, preserves navigation
    payload2 = SemanticContextImport(
        business_rules=[BusinessRuleItem(title="New Rule", rule="new")]
    )
    result = await import_semantic_context(db_session, project.id, payload2)
    assert result["deleted_count"] == 1
    assert result["created_count"] == 1

    items, _, _ = await list_entries(db_session, project.id)
    cats = [i.category for i in items]
    assert "navigation" in cats  # preserved
    assert "business_rule" in cats


async def test_import_empty_payload(db_session, project):
    payload = SemanticContextImport()
    result = await import_semantic_context(db_session, project.id, payload)
    assert result["created_count"] == 0
    assert result["deleted_count"] == 0
