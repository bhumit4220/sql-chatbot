import pytest
from httpx import ASGITransport, AsyncClient

from app.core.security import hash_password
from app.main import app
from app.models.admin import Admin


@pytest.fixture
async def seeded_client(db_engine, db_session):
    """Client with a seeded admin user."""
    admin = Admin(email="admin@test.com", password_hash=hash_password("secret"), role="owner")
    db_session.add(admin)
    await db_session.commit()

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.database import get_session

    session_factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def test_login_success(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "secret"})
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


async def test_login_wrong_password(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "admin@test.com", "password": "wrong"})
    assert resp.status_code == 401


async def test_login_nonexistent_user(seeded_client):
    resp = await seeded_client.post("/api/v1/auth/login", json={"email": "nope@test.com", "password": "any"})
    assert resp.status_code == 401
