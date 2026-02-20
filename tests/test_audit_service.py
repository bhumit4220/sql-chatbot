import pytest

from app.services.audit_service import AuditService
from app.models.audit_log import AuditLog
from app.models.admin import Admin
from app.models.project import Project
from app.models.api_key import ApiKey
from app.core.security import hash_password, hash_api_key
from sqlalchemy import select


@pytest.fixture
async def audit_setup(db_session):
    admin = Admin(email="audit@test.com", password_hash=hash_password("pass"), role="owner")
    db_session.add(admin)
    await db_session.flush()

    project = Project(name="AuditProj", connection_string_encrypted="e", owner_admin_id=admin.id)
    db_session.add(project)
    await db_session.flush()

    api_key = ApiKey(key_prefix="proj_aud", key_hash=hash_api_key("aud-key"), project_id=project.id)
    db_session.add(api_key)
    await db_session.flush()

    return project, api_key


@pytest.fixture
def audit_service():
    return AuditService()


async def test_log_chat_event(db_session, audit_setup, audit_service):
    project, api_key = audit_setup
    await audit_service.log_event(
        session=db_session,
        project_id=project.id,
        api_key_id=api_key.id,
        event_type="chat_success",
        question="How many jobs?",
        sql_query="SELECT count(*) FROM jobs",
        execution_time_ms=42.5,
        result_row_count=1,
        token_usage=150,
        ip_address="127.0.0.1",
    )

    result = await db_session.execute(select(AuditLog))
    log = result.scalar_one()
    assert log.event_type == "chat_success"
    assert log.question == "How many jobs?"
    assert log.sql_query == "SELECT count(*) FROM jobs"
    assert log.ip_address == "127.0.0.1"
    assert log.token_usage == 150


async def test_log_rejection_event(db_session, audit_setup, audit_service):
    project, api_key = audit_setup
    await audit_service.log_event(
        session=db_session,
        project_id=project.id,
        api_key_id=api_key.id,
        event_type="sql_rejected",
        question="DROP TABLE users",
        sql_query="DROP TABLE users",
        rejection_reason="Blocked keyword: DROP",
        ip_address="10.0.0.1",
    )

    result = await db_session.execute(select(AuditLog))
    log = result.scalar_one()
    assert log.event_type == "sql_rejected"
    assert log.rejection_reason == "Blocked keyword: DROP"


async def test_log_error_event(db_session, audit_setup, audit_service):
    project, api_key = audit_setup
    await audit_service.log_event(
        session=db_session,
        project_id=project.id,
        api_key_id=api_key.id,
        event_type="execution_error",
        question="Select from nonexistent",
        error_message="relation does not exist",
        ip_address="192.168.1.1",
    )

    result = await db_session.execute(select(AuditLog))
    log = result.scalar_one()
    assert log.event_type == "execution_error"
    assert log.error_message == "relation does not exist"


async def test_log_guidance_event(db_session, audit_setup, audit_service):
    project, api_key = audit_setup
    await audit_service.log_event(
        session=db_session,
        project_id=project.id,
        api_key_id=api_key.id,
        event_type="guidance",
        question="How do I approve a contractor?",
        token_usage=80,
        ip_address="127.0.0.1",
    )

    result = await db_session.execute(select(AuditLog))
    log = result.scalar_one()
    assert log.event_type == "guidance"
    assert log.sql_query is None
