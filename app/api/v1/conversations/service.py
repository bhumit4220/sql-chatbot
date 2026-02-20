import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation
from app.models.message import Message


class ConversationService:
    async def get_or_create_conversation(
        self,
        session: AsyncSession,
        project_id: int,
        session_id: str | None = None,
        conversation_udid: str | None = None,
    ) -> Conversation:
        if conversation_udid:
            result = await session.execute(
                select(Conversation).where(
                    Conversation.udid == conversation_udid,
                    Conversation.project_id == project_id,
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                return existing

        conv = Conversation(
            udid=str(uuid.uuid4()),
            project_id=project_id,
            session_id=session_id or str(uuid.uuid4()),
        )
        session.add(conv)
        await session.flush()
        return conv

    async def save_message(
        self,
        session: AsyncSession,
        conversation_id: int,
        role: str,
        content: str,
        question_type: str | None = None,
        sql_query: str | None = None,
        tokens_used: int | None = None,
    ) -> Message:
        msg = Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            question_type=question_type,
            sql_query=sql_query,
            tokens_used=tokens_used,
        )
        session.add(msg)
        await session.flush()
        return msg

    async def get_history(self, session: AsyncSession, conversation_id: int, limit: int = 10) -> list[dict]:
        result = await session.execute(
            select(Message).where(Message.conversation_id == conversation_id).order_by(Message.id.desc()).limit(limit)
        )
        messages = list(reversed(result.scalars().all()))
        return [{"role": m.role, "content": m.content} for m in messages]

    async def get_messages_by_udid(self, session: AsyncSession, conversation_udid: str, project_id: int) -> list[dict]:
        result = await session.execute(
            select(Conversation).where(
                Conversation.udid == conversation_udid,
                Conversation.project_id == project_id,
            )
        )
        conv = result.scalar_one_or_none()
        if not conv:
            return []

        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == conv.id).order_by(Message.id)
        )
        messages = msg_result.scalars().all()
        return [
            {
                "role": m.role,
                "content": m.content,
                "question_type": m.question_type,
                "sql_query": m.sql_query,
            }
            for m in messages
        ]
