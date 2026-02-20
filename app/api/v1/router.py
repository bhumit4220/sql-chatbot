from fastapi import APIRouter

from app.api.v1.auth.router import router as auth_router
from app.api.v1.projects.router import router as projects_router

router = APIRouter(prefix="/api/v1")
router.include_router(auth_router)
router.include_router(projects_router)
