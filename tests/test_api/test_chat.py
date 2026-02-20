import pytest

from app.api.v1.conversations.service import ConversationService
from app.core.security import hash_api_key, hash_password
from app.models.admin import Admin
from app.models.api_key import ApiKey
from app.models.project import Project


@pytest.fixture
async def project_setup(db_session):
    """Create admin + project + api_key for chat tests."""
    admin = Admin(email="chat@test.com", password_hash=hash_password("pass"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    project = Project(
        name="ChatTest",
        connection_string_encrypted="encrypted_conn",
        owner_admin_id=admin.id,
    )
    db_session.add(project)
    await db_session.flush()

    api_key = ApiKey(
        key_prefix="proj_test",
        key_hash=hash_api_key("test-key-123"),
        project_id=project.id,
    )
    db_session.add(api_key)
    await db_session.flush()

    return project, api_key


@pytest.fixture
def conv_service():
    return ConversationService()


async def test_create_conversation(db_session, project_setup, conv_service):
    project, _ = project_setup
    conv = await conv_service.get_or_create_conversation(db_session, project.id, session_id="sess-1")
    assert conv.id is not None
    assert conv.udid is not None
    assert conv.project_id == project.id
    assert conv.session_id == "sess-1"


async def test_get_existing_conversation_by_udid(db_session, project_setup, conv_service):
    project, _ = project_setup
    conv1 = await conv_service.get_or_create_conversation(db_session, project.id, session_id="sess-2")
    conv2 = await conv_service.get_or_create_conversation(
        db_session, project.id, session_id="sess-2", conversation_udid=conv1.udid
    )
    assert conv1.id == conv2.id


async def test_save_and_get_messages(db_session, project_setup, conv_service):
    project, _ = project_setup
    conv = await conv_service.get_or_create_conversation(db_session, project.id, session_id="sess-3")

    await conv_service.save_message(db_session, conv.id, "user", "How many jobs?")
    await conv_service.save_message(
        db_session,
        conv.id,
        "assistant",
        "There are 42 jobs.",
        question_type="data",
        sql_query="SELECT count(*) FROM jobs",
    )

    history = await conv_service.get_history(db_session, conv.id)
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[0]["content"] == "How many jobs?"
    assert history[1]["role"] == "assistant"


async def test_get_history_capped_at_limit(db_session, project_setup, conv_service):
    project, _ = project_setup
    conv = await conv_service.get_or_create_conversation(db_session, project.id, session_id="sess-4")

    for i in range(15):
        await conv_service.save_message(db_session, conv.id, "user", f"msg {i}")

    history = await conv_service.get_history(db_session, conv.id, limit=10)
    assert len(history) == 10
    # Should be the most recent 10
    assert history[-1]["content"] == "msg 14"


async def test_get_messages_by_udid(db_session, project_setup, conv_service):
    project, _ = project_setup
    conv = await conv_service.get_or_create_conversation(db_session, project.id, session_id="sess-5")
    await conv_service.save_message(db_session, conv.id, "user", "Hello")
    await conv_service.save_message(db_session, conv.id, "assistant", "Hi!")

    messages = await conv_service.get_messages_by_udid(db_session, conv.udid, project.id)
    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"
