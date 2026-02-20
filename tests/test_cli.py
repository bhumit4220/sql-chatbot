import pytest

from app.cli import create_admin_in_db
from app.core.security import verify_password


async def test_create_admin_stores_hashed_password(db_session):
    admin = await create_admin_in_db(db_session, "cli@test.com", "mypassword")
    assert admin.email == "cli@test.com"
    assert admin.password_hash != "mypassword"
    assert admin.role == "owner"
    assert verify_password("mypassword", admin.password_hash)


async def test_create_admin_has_id(db_session):
    admin = await create_admin_in_db(db_session, "cli2@test.com", "pass123")
    assert admin.id is not None
