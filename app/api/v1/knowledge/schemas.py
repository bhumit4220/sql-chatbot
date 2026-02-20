from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class KnowledgeEntryCreate(BaseModel):
    category: Literal["navigation", "workflow", "concept", "faq"]
    title: str
    content: str
    url: str | None = None
    tags: list[str] | None = None
    sort_order: int = 0


class KnowledgeEntryUpdate(BaseModel):
    category: Literal["navigation", "workflow", "concept", "faq"] | None = None
    title: str | None = None
    content: str | None = None
    url: str | None = None
    tags: list[str] | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class KnowledgeEntryResponse(BaseModel):
    id: int
    project_id: int
    category: str
    title: str
    content: str
    url: str | None = None
    tags: str | None = None
    sort_order: int
    is_active: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class KnowledgeEntryListResponse(BaseModel):
    items: list[KnowledgeEntryResponse]
    has_more: bool
    next_cursor: int | None = None
