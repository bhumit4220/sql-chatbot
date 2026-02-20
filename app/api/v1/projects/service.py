import secrets

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import encrypt_connection_string, hash_api_key
from app.models.api_key import ApiKey
from app.models.project import Project


async def create_project(session: AsyncSession, admin_id: int, name: str, connection_string: str) -> Project:
    project = Project(
        name=name,
        connection_string_encrypted=encrypt_connection_string(connection_string),
        owner_admin_id=admin_id,
    )
    session.add(project)
    await session.flush()
    return project


async def list_projects(
    session: AsyncSession, admin_id: int, limit: int = 20, after: int | None = None
) -> tuple[list[Project], bool, int | None]:
    query = select(Project).where(Project.owner_admin_id == admin_id).order_by(Project.id)
    if after is not None:
        query = query.where(Project.id > after)
    query = query.limit(limit + 1)

    result = await session.execute(query)
    items = list(result.scalars().all())

    has_more = len(items) > limit
    if has_more:
        items = items[:limit]

    next_cursor = items[-1].id if has_more and items else None
    return items, has_more, next_cursor


async def get_project(session: AsyncSession, admin_id: int, project_id: int) -> Project:
    result = await session.execute(
        select(Project).where(Project.id == project_id, Project.owner_admin_id == admin_id)
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise NotFoundError("Project not found")
    return project


async def update_project(session: AsyncSession, admin_id: int, project_id: int, name: str | None = None) -> Project:
    project = await get_project(session, admin_id, project_id)
    if name is not None:
        project.name = name
    await session.flush()
    return project


async def delete_project(session: AsyncSession, admin_id: int, project_id: int) -> None:
    project = await get_project(session, admin_id, project_id)
    await session.delete(project)
    await session.flush()


async def create_api_key(session: AsyncSession, project_id: int) -> tuple[str, ApiKey]:
    raw_key = secrets.token_urlsafe(32)
    key_prefix = f"proj_{raw_key[:8]}"
    key_hash = hash_api_key(raw_key)

    api_key = ApiKey(
        key_prefix=key_prefix,
        key_hash=key_hash,
        project_id=project_id,
    )
    session.add(api_key)
    await session.flush()
    return raw_key, api_key


async def list_api_keys(
    session: AsyncSession, project_id: int, limit: int = 20, after: int | None = None
) -> tuple[list[ApiKey], bool, int | None]:
    query = select(ApiKey).where(ApiKey.project_id == project_id).order_by(ApiKey.id)
    if after is not None:
        query = query.where(ApiKey.id > after)
    query = query.limit(limit + 1)

    result = await session.execute(query)
    items = list(result.scalars().all())

    has_more = len(items) > limit
    if has_more:
        items = items[:limit]

    next_cursor = items[-1].id if has_more and items else None
    return items, has_more, next_cursor


async def revoke_api_key(session: AsyncSession, key_id: int) -> ApiKey:
    result = await session.execute(select(ApiKey).where(ApiKey.id == key_id))
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise NotFoundError("API key not found")
    api_key.is_active = False
    await session.flush()
    return api_key
