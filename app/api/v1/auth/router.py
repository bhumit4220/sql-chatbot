from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError
from app.core.security import create_jwt_token
from app.database import get_session
from app.api.v1.auth.schemas import LoginRequest, TokenResponse
from app.api.v1.auth.service import authenticate_admin
from app.api.v1.auth.dependencies import get_current_admin

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, session: AsyncSession = Depends(get_session)):
    admin = await authenticate_admin(session, body.email, body.password)
    if admin is None:
        raise AuthenticationError("Invalid email or password")
    token = create_jwt_token(subject=f"admin:{admin.id}")
    return TokenResponse(access_token=token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(admin=Depends(get_current_admin)):
    token = create_jwt_token(subject=f"admin:{admin.id}")
    return TokenResponse(access_token=token)
