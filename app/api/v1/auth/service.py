from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_password
from app.models.admin import Admin


async def authenticate_admin(session: AsyncSession, email: str, password: str) -> Admin | None:
    result = await session.execute(select(Admin).where(Admin.email == email))
    admin = result.scalar_one_or_none()
    if admin is None or not verify_password(password, admin.password_hash):
        return None
    return admin
