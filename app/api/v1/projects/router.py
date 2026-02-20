from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth.dependencies import get_current_admin
from app.api.v1.projects import schemas, service
from app.database import get_session
from app.models.admin import Admin

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=schemas.ProjectResponse, status_code=201)
async def create_project(
    body: schemas.ProjectCreate,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    project = await service.create_project(session, admin.id, body.name, body.connection_string)
    await session.commit()
    return project


@router.get("", response_model=schemas.ProjectListResponse)
async def list_projects(
    limit: int = Query(20, ge=1, le=100),
    after: int | None = Query(None),
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    items, has_more, next_cursor = await service.list_projects(session, admin.id, limit, after)
    return schemas.ProjectListResponse(
        items=[schemas.ProjectResponse.model_validate(p) for p in items],
        has_more=has_more,
        next_cursor=next_cursor,
    )


@router.get("/{project_id}", response_model=schemas.ProjectResponse)
async def get_project(
    project_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    return await service.get_project(session, admin.id, project_id)


@router.put("/{project_id}", response_model=schemas.ProjectResponse)
async def update_project(
    project_id: int,
    body: schemas.ProjectUpdate,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    project = await service.update_project(session, admin.id, project_id, body.name)
    await session.commit()
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await service.delete_project(session, admin.id, project_id)
    await session.commit()


@router.post("/{project_id}/api-keys", response_model=schemas.ApiKeyCreated, status_code=201)
async def create_api_key(
    project_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    # Verify admin owns the project
    await service.get_project(session, admin.id, project_id)
    raw_key, api_key = await service.create_api_key(session, project_id)
    await session.commit()
    return schemas.ApiKeyCreated(raw_key=raw_key, key_prefix=api_key.key_prefix, id=api_key.id)


@router.get("/{project_id}/api-keys", response_model=schemas.ApiKeyListResponse)
async def list_api_keys(
    project_id: int,
    limit: int = Query(20, ge=1, le=100),
    after: int | None = Query(None),
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await service.get_project(session, admin.id, project_id)
    items, has_more, next_cursor = await service.list_api_keys(session, project_id, limit, after)
    return schemas.ApiKeyListResponse(
        items=[schemas.ApiKeyResponse.model_validate(k) for k in items],
        has_more=has_more,
        next_cursor=next_cursor,
    )


@router.delete("/{project_id}/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    project_id: int,
    key_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    await service.get_project(session, admin.id, project_id)
    await service.revoke_api_key(session, key_id)
    await session.commit()
