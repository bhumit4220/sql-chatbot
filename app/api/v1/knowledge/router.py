from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth.dependencies import get_current_admin
from app.api.v1.knowledge import schemas, service
from app.api.v1.projects.service import get_project
from app.database import get_session
from app.models.admin import Admin

router = APIRouter(prefix="/projects/{project_id}/knowledge", tags=["knowledge"])


async def _verify_project_access(project_id: int, admin: Admin, session: AsyncSession):
    """Verify the admin owns the project."""
    await get_project(session, admin.id, project_id)


@router.post("", response_model=schemas.KnowledgeEntryResponse, status_code=201)
async def create_entry(
    project_id: int,
    body: schemas.KnowledgeEntryCreate,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await _verify_project_access(project_id, admin, session)
    entry = await service.create_entry(
        session,
        project_id,
        body.category,
        body.title,
        body.content,
        body.url,
        body.tags,
        body.sort_order,
        body.metadata_json,
    )
    await session.commit()
    return entry


@router.get("", response_model=schemas.KnowledgeEntryListResponse)
async def list_entries(
    project_id: int,
    limit: int = Query(20, ge=1, le=100),
    after: int | None = Query(None),
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await _verify_project_access(project_id, admin, session)
    items, has_more, next_cursor = await service.list_entries(session, project_id, limit, after)
    return schemas.KnowledgeEntryListResponse(
        items=[schemas.KnowledgeEntryResponse.model_validate(e) for e in items],
        has_more=has_more,
        next_cursor=next_cursor,
    )


@router.get("/{entry_id}", response_model=schemas.KnowledgeEntryResponse)
async def get_entry(
    project_id: int,
    entry_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await _verify_project_access(project_id, admin, session)
    return await service.get_entry(session, project_id, entry_id)


@router.put("/{entry_id}", response_model=schemas.KnowledgeEntryResponse)
async def update_entry(
    project_id: int,
    entry_id: int,
    body: schemas.KnowledgeEntryUpdate,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await _verify_project_access(project_id, admin, session)
    entry = await service.update_entry(
        session,
        project_id,
        entry_id,
        category=body.category,
        title=body.title,
        content=body.content,
        url=body.url,
        tags=body.tags,
        sort_order=body.sort_order,
        is_active=body.is_active,
        metadata_json=body.metadata_json,
    )
    await session.commit()
    return entry


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(
    project_id: int,
    entry_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await _verify_project_access(project_id, admin, session)
    await service.delete_entry(session, project_id, entry_id)
    await session.commit()
