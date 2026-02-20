import pytest
from app.api.v1.auth.service import authenticate_admin
from app.core.security import hash_password
from app.models.admin import Admin


async def test_authenticate_admin_valid(db_session):
    admin = Admin(email="auth@test.com", password_hash=hash_password("pass123"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    result = await authenticate_admin(db_session, "auth@test.com", "pass123")
    assert result is not None
    assert result.email == "auth@test.com"


async def test_authenticate_admin_wrong_password(db_session):
    admin = Admin(email="wrong@test.com", password_hash=hash_password("pass123"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    result = await authenticate_admin(db_session, "wrong@test.com", "badpass")
    assert result is None


async def test_authenticate_admin_no_user(db_session):
    result = await authenticate_admin(db_session, "nobody@test.com", "pass")
    assert result is None
