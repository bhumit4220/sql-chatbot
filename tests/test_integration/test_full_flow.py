"""Integration test: full chat flow with mocked OpenAI."""

import pytest

from app.api.v1.conversations.service import ConversationService
from app.api.v1.projects.service import create_api_key, create_project
from app.cli import create_admin_in_db
from app.models.knowledge_entry import KnowledgeEntry


@pytest.fixture
async def full_setup(db_session):
    """Set up admin, project, API key, and knowledge entries."""
    # Create admin
    admin = await create_admin_in_db(db_session, "integ@test.com", "testpass123")

    # Create project
    project = await create_project(db_session, admin.id, "IntegTest", "sqlite+aiosqlite:///:memory:")

    # Create API key
    raw_key, api_key = await create_api_key(db_session, project.id)

    # Add knowledge entries
    entry = KnowledgeEntry(
        project_id=project.id,
        category="navigation",
        title="View Jobs",
        content="Go to /admin/jobs to view all jobs",
        url="/admin/jobs",
    )
    db_session.add(entry)
    await db_session.flush()

    return admin, project, raw_key, api_key


async def test_conversation_service_full_flow(db_session, full_setup):
    """Test the conversation service layer directly."""
    admin, project, raw_key, api_key = full_setup
    service = ConversationService()

    # Create conversation
    conv = await service.get_or_create_conversation(db_session, project.id, session_id="test-sess")
    assert conv.id is not None

    # Save user message
    await service.save_message(db_session, conv.id, "user", "How many jobs are there?")

    # Save assistant response
    await service.save_message(
        db_session,
        conv.id,
        "assistant",
        "There are 42 jobs.",
        question_type="data",
        sql_query="SELECT count(*) FROM jobs",
    )

    # Get history
    history = await service.get_history(db_session, conv.id)
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"

    # Get messages by udid
    messages = await service.get_messages_by_udid(db_session, conv.udid, project.id)
    assert len(messages) == 2
    assert messages[1]["sql_query"] == "SELECT count(*) FROM jobs"


async def test_knowledge_loaded_for_project(db_session, full_setup):
    """Verify knowledge entries are loaded and formatted for the project."""
    from app.services.knowledge_service import KnowledgeService

    _, project, _, _ = full_setup
    service = KnowledgeService()
    formatted = await service.load_for_prompt(db_session, project.id)
    assert "View Jobs" in formatted
    assert "/admin/jobs" in formatted


async def test_conversation_persists_across_requests(db_session, full_setup):
    """Verify that reusing a conversation_udid retrieves the same conversation."""
    _, project, _, _ = full_setup
    service = ConversationService()

    conv1 = await service.get_or_create_conversation(db_session, project.id, session_id="persist-sess")
    await service.save_message(db_session, conv1.id, "user", "First question")

    # Retrieve same conversation by udid
    conv2 = await service.get_or_create_conversation(
        db_session, project.id, session_id="persist-sess", conversation_udid=conv1.udid
    )
    assert conv1.id == conv2.id

    # Add another message
    await service.save_message(db_session, conv2.id, "user", "Follow-up question")

    history = await service.get_history(db_session, conv1.id)
    assert len(history) == 2
