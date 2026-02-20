import pytest

from app.api.v1.knowledge.service import create_entry, delete_entry, get_entry, list_entries, update_entry
from app.core.exceptions import NotFoundError, ValidationError
from app.core.security import hash_password
from app.models.admin import Admin
from app.models.project import Project


@pytest.fixture
async def project(db_session):
    admin = Admin(email="kb@test.com", password_hash=hash_password("pass"), role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="KB Project", connection_string_encrypted="enc", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()
    return project


async def test_create_entry(db_session, project):
    entry = await create_entry(db_session, project.id, "navigation", "Dashboard", "Go to /admin/dashboard")
    assert entry.id is not None
    assert entry.category == "navigation"
    assert entry.is_active is True


async def test_create_entry_with_tags(db_session, project):
    entry = await create_entry(
        db_session,
        project.id,
        "faq",
        "Reset Password",
        "Click forgot password",
        tags=["auth", "password"],
    )
    assert entry.tags is not None
    assert "auth" in entry.tags


async def test_list_entries(db_session, project):
    await create_entry(db_session, project.id, "navigation", "E1", "C1")
    await create_entry(db_session, project.id, "faq", "E2", "C2")

    items, has_more, _ = await list_entries(db_session, project.id)
    assert len(items) == 2
    assert has_more is False


async def test_get_entry(db_session, project):
    entry = await create_entry(db_session, project.id, "concept", "Jobs", "A job represents work")
    found = await get_entry(db_session, project.id, entry.id)
    assert found.title == "Jobs"


async def test_get_entry_not_found(db_session, project):
    with pytest.raises(NotFoundError):
        await get_entry(db_session, project.id, 9999)


async def test_update_entry(db_session, project):
    entry = await create_entry(db_session, project.id, "workflow", "Old", "Old content")
    updated = await update_entry(db_session, project.id, entry.id, title="New", content="New content")
    assert updated.title == "New"
    assert updated.content == "New content"


async def test_delete_entry(db_session, project):
    entry = await create_entry(db_session, project.id, "faq", "Del", "Content")
    await delete_entry(db_session, project.id, entry.id)
    with pytest.raises(NotFoundError):
        await get_entry(db_session, project.id, entry.id)


async def test_max_entries_limit(db_session, project):
    for i in range(100):
        await create_entry(db_session, project.id, "faq", f"Entry {i}", f"Content {i}")

    with pytest.raises(ValidationError, match="Maximum 100"):
        await create_entry(db_session, project.id, "faq", "Too Many", "Should fail")
