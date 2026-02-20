import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session


async def test_get_session_yields_async_session():
    """get_session should yield an AsyncSession."""
    async for session in get_session():
        assert isinstance(session, AsyncSession)
        break
