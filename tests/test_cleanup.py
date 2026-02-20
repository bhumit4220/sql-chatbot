import pytest
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, update

from app.tasks.cleanup import cleanup_expired_conversations
from app.models.admin import Admin
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.message import Message
from app.core.security import hash_password


@pytest.fixture
async def cleanup_setup(db_session):
    admin = Admin(email="cleanup@test.com", password_hash=hash_password("pass"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    project = Project(name="CleanupProj", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()
    return project


async def test_deletes_old_conversations(db_session, cleanup_setup):
    project = cleanup_setup

    # Create an old conversation
    old_conv = Conversation(project_id=project.id, session_id="old-sess")
    db_session.add(old_conv)
    await db_session.flush()

    # Manually set updated_at to 100 days ago
    old_time = datetime.now(timezone.utc) - timedelta(days=100)
    await db_session.execute(
        update(Conversation).where(Conversation.id == old_conv.id).values(updated_at=old_time)
    )

    # Add a message to the old conversation
    msg = Message(conversation_id=old_conv.id, role="user", content="old message")
    db_session.add(msg)
    await db_session.flush()

    # Create a recent conversation
    new_conv = Conversation(project_id=project.id, session_id="new-sess")
    db_session.add(new_conv)
    await db_session.flush()

    deleted_count = await cleanup_expired_conversations(db_session, ttl_days=90)
    assert deleted_count == 1

    # Verify old conversation is gone
    result = await db_session.execute(select(Conversation).where(Conversation.id == old_conv.id))
    assert result.scalar_one_or_none() is None

    # Verify old messages are gone
    result = await db_session.execute(select(Message).where(Message.conversation_id == old_conv.id))
    assert result.scalar_one_or_none() is None

    # Verify new conversation still exists
    result = await db_session.execute(select(Conversation).where(Conversation.id == new_conv.id))
    assert result.scalar_one_or_none() is not None


async def test_no_deletions_when_all_recent(db_session, cleanup_setup):
    project = cleanup_setup
    conv = Conversation(project_id=project.id, session_id="recent")
    db_session.add(conv)
    await db_session.flush()

    deleted_count = await cleanup_expired_conversations(db_session, ttl_days=90)
    assert deleted_count == 0


async def test_no_deletions_when_no_conversations(db_session, cleanup_setup):
    deleted_count = await cleanup_expired_conversations(db_session, ttl_days=90)
    assert deleted_count == 0
