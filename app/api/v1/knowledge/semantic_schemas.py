from pydantic import BaseModel


class EnumMappingItem(BaseModel):
    table: str
    column: str
    mappings: dict[str, str]  # {"1": "Active", "2": "Inactive"}
    description: str | None = None


class ColumnDescriptionItem(BaseModel):
    table: str
    column: str
    description: str
    synonyms: list[str] | None = None


class BusinessRuleItem(BaseModel):
    title: str
    rule: str
    tables: list[str] | None = None
    sql_filter: str | None = None


class MetricDefinitionItem(BaseModel):
    name: str
    sql_expression: str
    description: str
    tables: list[str] | None = None


class VerifiedQueryItem(BaseModel):
    question: str
    sql: str
    explanation: str | None = None


class SemanticContextImport(BaseModel):
    enum_mappings: list[EnumMappingItem] | None = None
    column_descriptions: list[ColumnDescriptionItem] | None = None
    business_rules: list[BusinessRuleItem] | None = None
    metric_definitions: list[MetricDefinitionItem] | None = None
    verified_queries: list[VerifiedQueryItem] | None = None


class SemanticContextImportResponse(BaseModel):
    created_count: int
    deleted_count: int
    categories: dict[str, int]
