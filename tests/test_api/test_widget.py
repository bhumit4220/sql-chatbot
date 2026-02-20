import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_widget_js_endpoint(client):
    resp = await client.get("/widget/widget.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers.get("content-type", "")
