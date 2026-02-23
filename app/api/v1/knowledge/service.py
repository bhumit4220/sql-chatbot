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
    metadata_json: dict | None = None,
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
        metadata_json=metadata_json,
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
    metadata_json: dict | None = None,
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
    if metadata_json is not None:
        entry.metadata_json = metadata_json
    await session.flush()
    return entry


async def delete_entry(session: AsyncSession, project_id: int, entry_id: int) -> None:
    entry = await get_entry(session, project_id, entry_id)
    await session.delete(entry)
    await session.flush()


SEMANTIC_CATEGORIES = {"enum_mapping", "business_rule", "column_description",
                       "metric_definition", "verified_query"}


async def import_semantic_context(
    session: AsyncSession,
    project_id: int,
    payload,
) -> dict:
    # Delete existing semantic entries (replace strategy)
    result = await session.execute(
        select(KnowledgeEntry).where(
            KnowledgeEntry.project_id == project_id,
            KnowledgeEntry.category.in_(SEMANTIC_CATEGORIES),
        )
    )
    existing = result.scalars().all()
    deleted_count = len(existing)
    for entry in existing:
        await session.delete(entry)
    await session.flush()

    entries = []
    sort = 0

    for item in (payload.enum_mappings or []):
        mapping_text = ", ".join(f"{k}={v}" for k, v in item.mappings.items())
        content = f"{item.table}.{item.column}: {mapping_text}"
        if item.description:
            content += f"\n{item.description}"
        entries.append(KnowledgeEntry(
            project_id=project_id, category="enum_mapping",
            title=f"{item.table}.{item.column} enum values",
            content=content, sort_order=sort,
            metadata_json={"table": item.table, "column": item.column, "mappings": item.mappings},
        ))
        sort += 1

    for item in (payload.column_descriptions or []):
        content = f"{item.table}.{item.column}: {item.description}"
        if item.synonyms:
            content += f"\nSynonyms: {', '.join(item.synonyms)}"
        entries.append(KnowledgeEntry(
            project_id=project_id, category="column_description",
            title=f"{item.table}.{item.column}",
            content=content, sort_order=sort,
            metadata_json={"table": item.table, "column": item.column, "synonyms": item.synonyms},
        ))
        sort += 1

    for item in (payload.business_rules or []):
        content = item.rule
        if item.sql_filter:
            content += f"\nSQL filter: {item.sql_filter}"
        if item.tables:
            content += f"\nApplies to: {', '.join(item.tables)}"
        entries.append(KnowledgeEntry(
            project_id=project_id, category="business_rule",
            title=item.title, content=content, sort_order=sort,
            metadata_json={"tables": item.tables, "sql_filter": item.sql_filter},
        ))
        sort += 1

    for item in (payload.metric_definitions or []):
        content = f"{item.name}: {item.description}\nSQL: {item.sql_expression}"
        entries.append(KnowledgeEntry(
            project_id=project_id, category="metric_definition",
            title=item.name, content=content, sort_order=sort,
            metadata_json={"sql_expression": item.sql_expression, "tables": item.tables},
        ))
        sort += 1

    for item in (payload.verified_queries or []):
        content = f"Q: {item.question}\nSQL: {item.sql}"
        if item.explanation:
            content += f"\n{item.explanation}"
        entries.append(KnowledgeEntry(
            project_id=project_id, category="verified_query",
            title=item.question[:255], content=content, sort_order=sort,
            metadata_json={"sql": item.sql, "question": item.question},
        ))
        sort += 1

    session.add_all(entries)
    await session.flush()

    categories = {}
    for e in entries:
        categories[e.category] = categories.get(e.category, 0) + 1

    return {"created_count": len(entries), "deleted_count": deleted_count, "categories": categories}
