import pytest

from app.api.v1.projects.service import (
    create_api_key,
    create_project,
    delete_project,
    get_project,
    list_api_keys,
    list_projects,
    revoke_api_key,
    update_project,
)
from app.core.exceptions import NotFoundError
from app.core.security import hash_password
from app.models.admin import Admin


@pytest.fixture
async def admin(db_session):
    admin = Admin(email="proj@test.com", password_hash=hash_password("pass"), role="owner")
    db_session.add(admin)
    await db_session.flush()
    return admin


async def test_create_project(db_session, admin):
    project = await create_project(db_session, admin.id, "Test Project", "postgresql://host/db")
    assert project.id is not None
    assert project.udid is not None
    assert project.name == "Test Project"
    assert project.connection_string_encrypted != "postgresql://host/db"


async def test_list_projects(db_session, admin):
    await create_project(db_session, admin.id, "P1", "conn1")
    await create_project(db_session, admin.id, "P2", "conn2")

    items, has_more, _ = await list_projects(db_session, admin.id)
    assert len(items) == 2
    assert has_more is False


async def test_list_projects_scoped_to_admin(db_session, admin):
    await create_project(db_session, admin.id, "Mine", "conn")

    other = Admin(email="other@test.com", password_hash="h", role="member")
    db_session.add(other)
    await db_session.flush()
    await create_project(db_session, other.id, "Theirs", "conn")

    items, _, _ = await list_projects(db_session, admin.id)
    assert len(items) == 1
    assert items[0].name == "Mine"


async def test_get_project(db_session, admin):
    project = await create_project(db_session, admin.id, "Get Me", "conn")
    found = await get_project(db_session, admin.id, project.id)
    assert found.name == "Get Me"


async def test_get_project_not_found(db_session, admin):
    with pytest.raises(NotFoundError):
        await get_project(db_session, admin.id, 9999)


async def test_update_project(db_session, admin):
    project = await create_project(db_session, admin.id, "Old", "conn")
    updated = await update_project(db_session, admin.id, project.id, name="New")
    assert updated.name == "New"


async def test_delete_project(db_session, admin):
    project = await create_project(db_session, admin.id, "Del", "conn")
    await delete_project(db_session, admin.id, project.id)
    with pytest.raises(NotFoundError):
        await get_project(db_session, admin.id, project.id)


async def test_create_api_key(db_session, admin):
    project = await create_project(db_session, admin.id, "P", "conn")
    raw_key, api_key = await create_api_key(db_session, project.id)
    assert raw_key is not None
    assert len(raw_key) > 20
    assert api_key.key_prefix.startswith("proj_")
    assert api_key.is_active is True


async def test_list_api_keys(db_session, admin):
    project = await create_project(db_session, admin.id, "P", "conn")
    await create_api_key(db_session, project.id)
    await create_api_key(db_session, project.id)

    items, has_more, _ = await list_api_keys(db_session, project.id)
    assert len(items) == 2
    assert has_more is False


async def test_revoke_api_key(db_session, admin):
    project = await create_project(db_session, admin.id, "P", "conn")
    _, api_key = await create_api_key(db_session, project.id)
    assert api_key.is_active is True

    revoked = await revoke_api_key(db_session, api_key.id)
    assert revoked.is_active is False
