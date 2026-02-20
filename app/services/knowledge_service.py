from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge_entry import KnowledgeEntry


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

        lines = ["## Admin Panel Knowledge Base", ""]
        for entry in entries:
            lines.append(f"### [{entry.category}] {entry.title}")
            lines.append(entry.content)
            if entry.url:
                lines.append(f"URL: {entry.url}")
            lines.append("")

        return "\n".join(lines)
