from app.models.admin import Admin
from app.models.api_key import ApiKey
from app.models.audit_log import AuditLog
from app.models.conversation import Conversation
from app.models.knowledge_entry import KnowledgeEntry
from app.models.message import Message
from app.models.project import Project


async def test_create_admin(db_session):
    admin = Admin(email="test@example.com", password_hash="hashed", role="owner")
    db_session.add(admin)
    await db_session.flush()
    assert admin.id is not None
    assert admin.email == "test@example.com"


async def test_create_project(db_session):
    admin = Admin(email="owner@example.com", password_hash="hashed", role="owner")
    db_session.add(admin)
    await db_session.flush()

    project = Project(
        name="Test Project",
        connection_string_encrypted="encrypted-string",
        owner_admin_id=admin.id,
    )
    db_session.add(project)
    await db_session.flush()
    assert project.id is not None
    assert project.udid is not None


async def test_create_api_key(db_session):
    admin = Admin(email="key@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    key = ApiKey(key_prefix="proj_abc1", key_hash="sha256hash", project_id=project.id)
    db_session.add(key)
    await db_session.flush()
    assert key.id is not None
    assert key.is_active is True


async def test_create_knowledge_entry(db_session):
    admin = Admin(email="know@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entry = KnowledgeEntry(
        project_id=project.id,
        category="navigation",
        title="Test Page",
        content="Go to /admin/test",
    )
    db_session.add(entry)
    await db_session.flush()
    assert entry.id is not None
    assert entry.is_active is True


async def test_create_conversation_and_message(db_session):
    admin = Admin(email="conv@example.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="P", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    conv = Conversation(project_id=project.id, session_id="sess-abc-123")
    db_session.add(conv)
    await db_session.flush()

    msg = Message(conversation_id=conv.id, role="user", content="How many jobs today?")
    db_session.add(msg)
    await db_session.flush()
    assert msg.id is not None


async def test_create_audit_log(db_session):
    log = AuditLog(
        event_type="sql_executed",
        question="How many jobs?",
        sql_query="SELECT count(*) FROM jobs",
        validation_result=0,
        execution_time_ms=150.5,
        ip_address="192.168.1.1",
    )
    db_session.add(log)
    await db_session.flush()
    assert log.id is not None


async def test_knowledge_entry_with_metadata_json(db_session):
    admin = Admin(email="meta@test.com", password_hash="h", role="owner")
    db_session.add(admin)
    await db_session.flush()
    project = Project(name="Meta", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    entry = KnowledgeEntry(
        project_id=project.id,
        category="enum_mapping",
        title="Status Enum",
        content="1=Active, 3=Deleted",
        metadata_json={"table": "contractors", "column": "status", "mappings": {"1": "Active", "3": "Deleted"}},
    )
    db_session.add(entry)
    await db_session.flush()

    assert entry.id is not None
    assert entry.metadata_json["table"] == "contractors"
    assert entry.metadata_json["mappings"]["1"] == "Active"
