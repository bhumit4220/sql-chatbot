from datetime import datetime

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    name: str
    connection_string: str


class ProjectUpdate(BaseModel):
    name: str | None = None


class ProjectResponse(BaseModel):
    id: int
    udid: str
    name: str
    schema_refresh_interval_hours: int
    daily_token_limit: int
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class ProjectListResponse(BaseModel):
    items: list[ProjectResponse]
    has_more: bool
    next_cursor: int | None = None


class ApiKeyCreated(BaseModel):
    raw_key: str
    key_prefix: str
    id: int


class ApiKeyResponse(BaseModel):
    id: int
    key_prefix: str
    is_active: bool
    rate_limit_per_minute: int
    rate_limit_per_day: int
    last_used_at: datetime | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class ApiKeyListResponse(BaseModel):
    items: list[ApiKeyResponse]
    has_more: bool
    next_cursor: int | None = None
