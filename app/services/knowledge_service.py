from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge_entry import KnowledgeEntry

CATEGORY_ORDER = [
    "enum_mapping", "business_rule", "column_description",
    "metric_definition", "verified_query",
    "navigation", "workflow", "concept", "faq",
]

CATEGORY_HEADERS = {
    "enum_mapping": "Enum / Status Value Mappings",
    "business_rule": "Business Rules & Default Filters",
    "column_description": "Column Descriptions & Synonyms",
    "metric_definition": "Metric Definitions",
    "verified_query": "Verified Question-SQL Examples",
    "navigation": "Navigation Help",
    "workflow": "Workflows",
    "concept": "Business Concepts",
    "faq": "FAQ",
}


class KnowledgeService:
    async def load_for_prompt(self, session: AsyncSession, project_id: int) -> str:
        stmt = (
            select(KnowledgeEntry)
            .where(
                KnowledgeEntry.project_id == project_id,
                KnowledgeEntry.is_active == True,  # noqa: E712
            )
            .order_by(KnowledgeEntry.category, KnowledgeEntry.sort_order)
        )
        result = await session.execute(stmt)
        entries = result.scalars().all()

        if not entries:
            return ""

        grouped: dict[str, list[KnowledgeEntry]] = {}
        for entry in entries:
            grouped.setdefault(entry.category, []).append(entry)

        lines = ["## Admin Panel Knowledge Base", ""]

        ordered = [c for c in CATEGORY_ORDER if c in grouped]
        unknown = [c for c in grouped if c not in CATEGORY_ORDER]
        for cat in ordered + unknown:
            header = CATEGORY_HEADERS.get(cat, cat.replace("_", " ").title())
            lines.append(f"### {header}")
            lines.append("")
            for entry in grouped[cat]:
                lines.append(f"**{entry.title}**")
                lines.append(entry.content)
                if entry.url:
                    lines.append(f"URL: {entry.url}")
                lines.append("")

        return "\n".join(lines)
