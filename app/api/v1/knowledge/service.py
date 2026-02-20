import json

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.models.knowledge_entry import KnowledgeEntry

MAX_ENTRIES_PER_PROJECT = 100


async def create_entry(
    session: AsyncSession,
    project_id: int,
    category: str,
    title: str,
    content: str,
    url: str | None = None,
    tags: list[str] | None = None,
    sort_order: int = 0,
) -> KnowledgeEntry:
    count_result = await session.execute(
        select(func.count()).select_from(KnowledgeEntry).where(KnowledgeEntry.project_id == project_id)
    )
    count = count_result.scalar()
    if count >= MAX_ENTRIES_PER_PROJECT:
        raise ValidationError(f"Maximum {MAX_ENTRIES_PER_PROJECT} knowledge entries per project")

    entry = KnowledgeEntry(
        project_id=project_id,
        category=category,
        title=title,
        content=content,
        url=url,
        tags=json.dumps(tags) if tags else None,
        sort_order=sort_order,
    )
    session.add(entry)
    await session.flush()
    return entry


async def list_entries(
    session: AsyncSession, project_id: int, limit: int = 20, after: int | None = None
) -> tuple[list[KnowledgeEntry], bool, int | None]:
    query = (
        select(KnowledgeEntry)
        .where(KnowledgeEntry.project_id == project_id)
        .order_by(KnowledgeEntry.sort_order, KnowledgeEntry.id)
    )
    if after is not None:
        query = query.where(KnowledgeEntry.id > after)
    query = query.limit(limit + 1)

    result = await session.execute(query)
    items = list(result.scalars().all())

    has_more = len(items) > limit
    if has_more:
        items = items[:limit]

    next_cursor = items[-1].id if has_more and items else None
    return items, has_more, next_cursor


async def get_entry(session: AsyncSession, project_id: int, entry_id: int) -> KnowledgeEntry:
    result = await session.execute(
        select(KnowledgeEntry).where(KnowledgeEntry.id == entry_id, KnowledgeEntry.project_id == project_id)
    )
    entry = result.scalar_one_or_none()
    if entry is None:
        raise NotFoundError("Knowledge entry not found")
    return entry


async def update_entry(
    session: AsyncSession,
    project_id: int,
    entry_id: int,
    category: str | None = None,
    title: str | None = None,
    content: str | None = None,
    url: str | None = None,
    tags: list[str] | None = None,
    sort_order: int | None = None,
    is_active: bool | None = None,
) -> KnowledgeEntry:
    entry = await get_entry(session, project_id, entry_id)
    if category is not None:
        entry.category = category
    if title is not None:
        entry.title = title
    if content is not None:
        entry.content = content
    if url is not None:
        entry.url = url
    if tags is not None:
        entry.tags = json.dumps(tags)
    if sort_order is not None:
        entry.sort_order = sort_order
    if is_active is not None:
        entry.is_active = is_active
    await session.flush()
    return entry


async def delete_entry(session: AsyncSession, project_id: int, entry_id: int) -> None:
    entry = await get_entry(session, project_id, entry_id)
    await session.delete(entry)
    await session.flush()
