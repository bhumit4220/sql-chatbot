from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError
from app.core.security import decode_jwt_token, hash_api_key
from app.database import get_session
from app.models.admin import Admin
from app.models.api_key import ApiKey


async def get_current_admin(
    authorization: str = Header(..., alias="Authorization"),
    session: AsyncSession = Depends(get_session),
) -> Admin:
    if not authorization.startswith("Bearer "):
        raise AuthenticationError("Invalid authorization header")
    token = authorization[7:]
    try:
        payload = decode_jwt_token(token)
    except ValueError:
        raise AuthenticationError("Invalid or expired token")
    admin_id = int(payload["sub"].split(":")[1])
    result = await session.execute(select(Admin).where(Admin.id == admin_id))
    admin = result.scalar_one_or_none()
    if admin is None:
        raise AuthenticationError("Admin not found")
    return admin


async def verify_api_key(
    x_api_key: str = Header(..., alias="X-API-Key"),
    session: AsyncSession = Depends(get_session),
) -> ApiKey:
    key_hash = hash_api_key(x_api_key)
    result = await session.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.is_active == True)  # noqa: E712
    )
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise AuthenticationError("Invalid API key")
    return api_key
