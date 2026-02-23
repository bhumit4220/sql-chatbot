from datetime import datetime
from typing import Literal

from pydantic import BaseModel, model_validator

KNOWLEDGE_CATEGORIES = Literal[
    "navigation", "workflow", "concept", "faq",
    "enum_mapping", "business_rule", "column_description",
    "metric_definition", "verified_query",
]


class KnowledgeEntryCreate(BaseModel):
    category: KNOWLEDGE_CATEGORIES
    title: str
    content: str
    url: str | None = None
    tags: list[str] | None = None
    sort_order: int = 0
    metadata_json: dict | None = None

    @model_validator(mode="after")
    def validate_metadata_for_category(self):
        meta = self.metadata_json
        cat = self.category
        if cat == "enum_mapping" and meta:
            if not meta.get("table") or not meta.get("column") or not meta.get("mappings"):
                raise ValueError("enum_mapping requires metadata_json with table, column, and mappings")
        if cat == "verified_query" and meta:
            if not meta.get("sql"):
                raise ValueError("verified_query requires metadata_json with sql")
        if cat == "column_description" and meta:
            if not meta.get("table") or not meta.get("column"):
                raise ValueError("column_description requires metadata_json with table and column")
        if cat == "metric_definition" and meta:
            if not meta.get("sql_expression"):
                raise ValueError("metric_definition requires metadata_json with sql_expression")
        return self


class KnowledgeEntryUpdate(BaseModel):
    category: KNOWLEDGE_CATEGORIES | None = None
    title: str | None = None
    content: str | None = None
    url: str | None = None
    tags: list[str] | None = None
    sort_order: int | None = None
    is_active: bool | None = None
    metadata_json: dict | None = None


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
    metadata_json: dict | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class KnowledgeEntryListResponse(BaseModel):
    items: list[KnowledgeEntryResponse]
    has_more: bool
    next_cursor: int | None = None
