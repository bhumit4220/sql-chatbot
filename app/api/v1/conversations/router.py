import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.api.v1.auth.dependencies import verify_api_key
from app.api.v1.conversations.schemas import ChatRequest
from app.api.v1.conversations.service import ConversationService
from app.database import get_session
from app.models.api_key import ApiKey
from app.models.project import Project
from app.services.autodiscovery import run_autodiscovery_with_retry
from app.services.knowledge_service import KnowledgeService
from app.services.llm_service import LLMService
from app.services.rag_service import rag_service
from app.services.schema_inspector import SchemaInspector
from app.services.sql_executor import SqlExecutor
from app.services.sql_validator import SqlValidator
from app.services.tenant_db import tenant_db_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


def format_page_context(ctx) -> str:
    """Format widget page context for LLM prompt injection."""
    if not ctx:
        return "(No page context available — widget may not be sending page info)"

    lines = []
    if ctx.url:
        title = ctx.title or "Unknown page"
        lines.append(f"The admin is currently on: {title} ({ctx.url})")
    if ctx.heading:
        lines.append(f"Page heading: {ctx.heading}")

    if ctx.navigation:
        lines.append("\nAvailable Admin Pages:")
        for nav in ctx.navigation[:80]:  # cap at 80 items
            lines.append(f"- {nav.text} → {nav.href}")
    else:
        lines.append("\n(No navigation links detected on this page)")

    return "\n".join(lines)


llm_service = LLMService()
sql_executor = SqlExecutor()
schema_inspector = SchemaInspector()
knowledge_service = KnowledgeService()
conversation_service = ConversationService()


def _get_exclude_tables(project: Project) -> list[str] | None:
    """Parse exclude_tables JSON from project."""
    if not project.autodiscovery_exclude_tables:
        return None
    try:
        tables = json.loads(project.autodiscovery_exclude_tables)
        return tables if isinstance(tables, list) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _is_autodiscovery_stale(project: Project) -> bool:
    """Check if autodiscovery results are stale and need re-indexing."""
    if project.autodiscovery_status != "completed":
        return False
    if not project.autodiscovery_completed_at:
        return False
    completed = project.autodiscovery_completed_at
    if not completed.tzinfo:
        completed = completed.replace(tzinfo=timezone.utc)
    stale_after = timedelta(hours=project.schema_refresh_interval_hours)
    return datetime.now(timezone.utc) - completed > stale_after


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    api_key: ApiKey = Depends(verify_api_key),
    session: AsyncSession = Depends(get_session),
):
    project = await session.get(Project, api_key.project_id)
    exclude_tables = _get_exclude_tables(project)

    async def event_generator():
        conv = await conversation_service.get_or_create_conversation(
            session, project.id, body.session_id, body.conversation_id
        )

        history = await conversation_service.get_history(session, conv.id)

        # Load schema
        schema_text = project.schema_cache or ""
        if not schema_text:
            engine = await tenant_db_manager.get_engine(project.id, project.connection_string_encrypted)
            raw_schema = await schema_inspector.inspect_database(engine)
            stripped = schema_inspector.strip_sensitive_columns(raw_schema)
            schema_text = schema_inspector.format_for_prompt(stripped, exclude_tables=exclude_tables)
            project.schema_cache = schema_text
            await session.commit()
        else:
            # Apply exclude_tables filter to cached schema
            if exclude_tables:
                schema_text = schema_inspector.format_for_prompt(
                    _parse_schema_text(schema_text), exclude_tables=exclude_tables
                )

        # Format page context from widget
        page_context_text = format_page_context(body.page_context)

        # RAG retrieval (if indexed)
        rag_context = ""
        if project.autodiscovery_status == "completed" and project.autodiscovery_doc_count > 0:
            docs = await rag_service.retrieve(session, project.id, body.question)
            rag_context = rag_service.format_rag_context(docs)
        elif project.autodiscovery_status not in ("indexing",):
            # First-chat fallback: trigger async indexing
            asyncio.create_task(run_autodiscovery_with_retry(project.id))
            yield {
                "event": "info",
                "data": json.dumps({
                    "message": "Auto-discovery is running. Results will be more accurate after indexing completes."
                }),
            }

        # Staleness detection: trigger background re-index if stale
        if _is_autodiscovery_stale(project):
            asyncio.create_task(run_autodiscovery_with_retry(project.id))

        # Load knowledge base
        knowledge_text = await knowledge_service.load_for_prompt(session, project.id)

        # Save user message
        await conversation_service.save_message(session, conv.id, "user", body.question)

        # LLM Call 1: classify + generate SQL
        sql_result = await llm_service.generate_sql(
            question=body.question,
            schema_text=schema_text,
            knowledge_text=knowledge_text,
            conversation_history=history,
            page_context_text=page_context_text,
            rag_context=rag_context,
        )

        context = ""
        final_sql = sql_result.sql_query

        if sql_result.question_type == "data":
            # Multi-step exploration: if LLM needs to explore first
            if sql_result.needs_exploration and sql_result.exploration_query:
                exploration_result = await _try_exploration(
                    project, session, sql_result.exploration_query,
                    exclude_tables, schema_text
                )
                if exploration_result:
                    # Re-generate SQL with exploration context
                    enriched_rag = rag_context
                    if enriched_rag:
                        enriched_rag += f"\n\n--- Exploration Results ---\n{exploration_result}"
                    else:
                        enriched_rag = f"--- Exploration Results ---\n{exploration_result}"

                    sql_result_2 = await llm_service.generate_sql(
                        question=body.question,
                        schema_text=schema_text,
                        knowledge_text=knowledge_text,
                        conversation_history=history,
                        page_context_text=page_context_text,
                        rag_context=enriched_rag,
                    )
                    # Use the second result (no further exploration)
                    if sql_result_2.sql_query:
                        final_sql = sql_result_2.sql_query
                        sql_result = sql_result_2

            if final_sql:
                # Validate SQL
                schema_dict = _parse_schema_text(project.schema_cache or schema_text)
                validator = SqlValidator(schema=schema_dict, exclude_tables=exclude_tables)
                validation = validator.validate(final_sql)

                if not validation.is_valid:
                    yield {
                        "event": "error",
                        "data": json.dumps({
                            "message": "I generated an unsafe query and blocked it. Could you rephrase?"
                        }),
                    }
                    return

                yield {
                    "event": "sql_generated",
                    "data": json.dumps({
                        "sql": validation.modified_sql,
                        "explanation": sql_result.explanation,
                    }),
                }

                # Execute SQL
                engine = await tenant_db_manager.get_engine(
                    project.id, project.connection_string_encrypted
                )
                exec_result = await sql_executor.execute(engine, validation.modified_sql)

                if not exec_result.success:
                    yield {
                        "event": "error",
                        "data": json.dumps({
                            "message": "I wrote a query the database couldn't run. Let me try differently."
                        }),
                    }
                    return

                context = _format_sql_results(validation.modified_sql, exec_result)
            else:
                # data question but no SQL generated
                context = "(No SQL query was generated for this question)"
        else:
            context = knowledge_text

        # LLM Call 2: stream answer
        full_response = ""
        async for token in llm_service.stream_answer(
            question=body.question,
            context=context,
            question_type=sql_result.question_type,
            conversation_history=history,
            page_context_text=page_context_text,
            rag_context=rag_context,
        ):
            full_response += token
            yield {"event": "message", "data": json.dumps({"token": token})}

        yield {"event": "done", "data": json.dumps({"conversation_id": conv.udid})}

        # Save assistant message
        await conversation_service.save_message(
            session,
            conv.id,
            "assistant",
            full_response,
            question_type=sql_result.question_type,
            sql_query=final_sql if sql_result.question_type == "data" else None,
        )

    return EventSourceResponse(event_generator())


async def _try_exploration(
    project: Project,
    session: AsyncSession,
    exploration_query: str,
    exclude_tables: list[str] | None,
    schema_text: str,
) -> str | None:
    """Try to execute an exploration query. Returns formatted results or None."""
    try:
        schema_dict = _parse_schema_text(project.schema_cache or schema_text)
        validator = SqlValidator(schema=schema_dict, exclude_tables=exclude_tables)
        validation = validator.validate(exploration_query)

        if not validation.is_valid:
            return None

        engine = await tenant_db_manager.get_engine(
            project.id, project.connection_string_encrypted
        )
        exec_result = await sql_executor.execute(engine, validation.modified_sql)

        if not exec_result.success or exec_result.total_row_count == 0:
            return None

        return _format_sql_results(validation.modified_sql, exec_result)
    except Exception as e:
        logger.warning("Exploration query failed: %s", str(e)[:200])
        return None


@router.get("/conversations/{conversation_udid}")
async def get_conversation(
    conversation_udid: str,
    api_key: ApiKey = Depends(verify_api_key),
    session: AsyncSession = Depends(get_session),
):
    messages = await conversation_service.get_messages_by_udid(session, conversation_udid, api_key.project_id)
    return {"messages": messages}


def _parse_schema_text(schema_text: str) -> dict[str, list[str]]:
    """Parse 'TABLE name (col1, col2)' format back to dict."""
    schema = {}
    for line in schema_text.strip().split("\n"):
        line = line.strip()
        if line.startswith("TABLE "):
            parts = line[6:]
            paren_start = parts.index("(")
            table_name = parts[:paren_start].strip()
            cols_str = parts[paren_start + 1 : -1]
            columns = [c.strip() for c in cols_str.split(",")]
            schema[table_name] = columns
    return schema


def _format_sql_results(sql: str, exec_result) -> str:
    """Format SQL execution results as context for the LLM."""
    lines = [f"SQL Query: {sql}", f"Rows returned: {exec_result.total_row_count}", ""]
    if exec_result.columns:
        lines.append("| " + " | ".join(exec_result.columns) + " |")
        lines.append("| " + " | ".join("---" for _ in exec_result.columns) + " |")
        for row in exec_result.rows[:50]:  # Cap for LLM context
            lines.append("| " + " | ".join(str(row.get(c, "")) for c in exec_result.columns) + " |")
    return "\n".join(lines)
