from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation
from app.models.message import Message


async def cleanup_expired_conversations(session: AsyncSession, ttl_days: int = 90) -> int:
    cutoff = datetime.now(UTC) - timedelta(days=ttl_days)

    # Find expired conversations
    result = await session.execute(select(Conversation.id).where(Conversation.updated_at < cutoff))
    expired_ids = [row[0] for row in result.all()]

    if not expired_ids:
        return 0

    # Delete messages first, then conversations
    await session.execute(delete(Message).where(Message.conversation_id.in_(expired_ids)))
    await session.execute(delete(Conversation).where(Conversation.id.in_(expired_ids)))
    await session.flush()

    return len(expired_ids)
