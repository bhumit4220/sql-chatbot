import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth.dependencies import get_current_admin
from app.api.v1.projects import schemas, service
from app.database import get_session
from app.models.admin import Admin
from app.models.schema_document import SchemaDocument
from app.services.autodiscovery import run_autodiscovery_with_retry

router = APIRouter(prefix="/projects", tags=["projects"])

# Rate limit: minimum 5 minutes between reindex requests
REINDEX_COOLDOWN_MINUTES = 5


@router.post("", response_model=schemas.ProjectResponse, status_code=201)
async def create_project(
    body: schemas.ProjectCreate,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    project = await service.create_project(session, admin.id, body.name, body.connection_string)
    await session.commit()

    # Fire-and-forget autodiscovery
    asyncio.create_task(run_autodiscovery_with_retry(project.id))

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

    # Update exclude tables if provided
    if body.autodiscovery_exclude_tables is not None:
        project.autodiscovery_exclude_tables = json.dumps(body.autodiscovery_exclude_tables)

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


@router.post(
    "/{project_id}/reindex",
    response_model=schemas.ReindexResponse,
    status_code=202,
)
async def reindex_project(
    project_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    """Trigger auto-discovery reindex for a project."""
    project = await service.get_project(session, admin.id, project_id)

    # 409 if already indexing
    if project.autodiscovery_status == "indexing":
        raise HTTPException(
            status_code=409,
            detail="Auto-discovery is already running for this project",
        )

    # 429 if last completed < cooldown
    if project.autodiscovery_completed_at:
        completed = project.autodiscovery_completed_at
        if not completed.tzinfo:
            completed = completed.replace(tzinfo=timezone.utc)
        cooldown = datetime.now(timezone.utc) - timedelta(minutes=REINDEX_COOLDOWN_MINUTES)
        if completed > cooldown:
            raise HTTPException(
                status_code=429,
                detail=f"Please wait at least {REINDEX_COOLDOWN_MINUTES} minutes between reindex requests",
            )

    # Fire-and-forget
    asyncio.create_task(run_autodiscovery_with_retry(project.id))

    return schemas.ReindexResponse(
        status="accepted",
        message="Auto-discovery reindex has been queued",
    )


@router.get(
    "/{project_id}/schema-documents",
    response_model=schemas.SchemaDocumentsResponse,
)
async def get_schema_documents(
    project_id: int,
    admin: Admin = Depends(get_current_admin),
    session: AsyncSession = Depends(get_session),
):
    """Get schema document counts by type for a project."""
    await service.get_project(session, admin.id, project_id)

    result = await session.execute(
        select(
            SchemaDocument.doc_type,
            func.count(SchemaDocument.id).label("count"),
        )
        .where(SchemaDocument.project_id == project_id)
        .group_by(SchemaDocument.doc_type)
    )
    rows = result.all()

    total = sum(row.count for row in rows)
    by_type = [
        schemas.SchemaDocumentSummary(doc_type=row.doc_type, count=row.count)
        for row in rows
    ]

    return schemas.SchemaDocumentsResponse(
        project_id=project_id,
        total=total,
        by_type=by_type,
    )


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
