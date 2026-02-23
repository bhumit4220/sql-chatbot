from app.models.knowledge_entry import KnowledgeEntry
from app.services.knowledge_service import KnowledgeService


async def test_load_and_format_entries(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entries = [
        KnowledgeEntry(
            project_id=project.id,
            category="navigation",
            title="Find Jobs",
            content="Go to /admin/jobs",
            url="/admin/jobs",
        ),
        KnowledgeEntry(
            project_id=project.id,
            category="workflow",
            title="Approve Contractor",
            content="Step 1: Go to contractors. Step 2: Click approve.",
        ),
    ]
    db_session.add_all(entries)
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert "Find Jobs" in formatted
    assert "Approve Contractor" in formatted
    assert "/admin/jobs" in formatted


async def test_inactive_entries_excluded(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks2@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P2", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    active = KnowledgeEntry(project_id=project.id, category="faq", title="Active", content="Visible")
    inactive = KnowledgeEntry(
        project_id=project.id, category="faq", title="Inactive", content="Hidden", is_active=False
    )
    db_session.add_all([active, inactive])
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert "Active" in formatted
    assert "Inactive" not in formatted


async def test_empty_knowledge_base(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks3@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P3", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert formatted == ""


async def test_entries_sorted_by_category_and_order(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="ks4@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P4", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entries = [
        KnowledgeEntry(project_id=project.id, category="workflow", title="Second", content="B", sort_order=2),
        KnowledgeEntry(project_id=project.id, category="navigation", title="First Nav", content="A", sort_order=1),
        KnowledgeEntry(project_id=project.id, category="workflow", title="First", content="A", sort_order=1),
    ]
    db_session.add_all(entries)
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    # Navigation comes before workflow in CATEGORY_ORDER, and within workflow, sort_order respected
    nav_pos = formatted.index("First Nav")
    wf_first_pos = formatted.index("**First**")
    wf_second_pos = formatted.index("**Second**")
    assert nav_pos < wf_first_pos < wf_second_pos


async def test_semantic_entries_grouped_and_ordered(db_session):
    from app.models.admin import Admin
    from app.models.project import Project

    admin = Admin(email="fmt@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="Fmt", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entries = [
        KnowledgeEntry(project_id=project.id, category="navigation", title="Dashboard", content="/admin"),
        KnowledgeEntry(project_id=project.id, category="enum_mapping", title="Status", content="1=Active, 3=Deleted"),
        KnowledgeEntry(project_id=project.id, category="business_rule", title="Soft Delete", content="Exclude status=3"),
        KnowledgeEntry(project_id=project.id, category="verified_query", title="Active count", content="Q: How many active?\nSQL: SELECT COUNT(*) FROM contractors WHERE status = 1"),
    ]
    db_session.add_all(entries)
    await db_session.flush()

    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)

    # Semantic categories appear before navigation
    enum_pos = formatted.index("Enum / Status Value Mappings")
    rule_pos = formatted.index("Business Rules & Default Filters")
    query_pos = formatted.index("Verified Question-SQL Examples")
    nav_pos = formatted.index("Navigation Help")
    assert enum_pos < rule_pos < query_pos < nav_pos

    # Content is present with bold titles
    assert "**Status**" in formatted
    assert "1=Active" in formatted
