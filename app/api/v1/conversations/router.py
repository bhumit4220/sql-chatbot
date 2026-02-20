import json

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.api.v1.auth.dependencies import verify_api_key
from app.api.v1.conversations.schemas import ChatRequest
from app.api.v1.conversations.service import ConversationService
from app.database import get_session
from app.models.api_key import ApiKey
from app.models.project import Project
from app.services.knowledge_service import KnowledgeService
from app.services.llm_service import LLMService
from app.services.schema_inspector import SchemaInspector
from app.services.sql_executor import SqlExecutor
from app.services.sql_validator import SqlValidator
from app.services.tenant_db import tenant_db_manager

router = APIRouter(tags=["chat"])
llm_service = LLMService()
sql_executor = SqlExecutor()
schema_inspector = SchemaInspector()
knowledge_service = KnowledgeService()
conversation_service = ConversationService()


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    api_key: ApiKey = Depends(verify_api_key),
    session: AsyncSession = Depends(get_session),
):
    project = await session.get(Project, api_key.project_id)

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
            schema_text = schema_inspector.format_for_prompt(stripped)
            project.schema_cache = schema_text
            await session.commit()

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
        )

        context = ""
        if sql_result.question_type == "data" and sql_result.sql_query:
            # Validate SQL
            schema_dict = _parse_schema_text(schema_text)
            validator = SqlValidator(schema=schema_dict)
            validation = validator.validate(sql_result.sql_query)

            if not validation.is_valid:
                yield {
                    "event": "error",
                    "data": json.dumps({"message": "I generated an unsafe query and blocked it. Could you rephrase?"}),
                }
                return

            yield {
                "event": "sql_generated",
                "data": json.dumps({"sql": validation.modified_sql, "explanation": sql_result.explanation}),
            }

            # Execute SQL
            engine = await tenant_db_manager.get_engine(project.id, project.connection_string_encrypted)
            exec_result = await sql_executor.execute(engine, validation.modified_sql)

            if not exec_result.success:
                yield {
                    "event": "error",
                    "data": json.dumps(
                        {"message": "I wrote a query the database couldn't run. Let me try differently."}
                    ),
                }
                return

            context = _format_sql_results(validation.modified_sql, exec_result)
        else:
            context = knowledge_text

        # LLM Call 2: stream answer
        full_response = ""
        async for token in llm_service.stream_answer(
            question=body.question,
            context=context,
            question_type=sql_result.question_type,
            conversation_history=history,
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
            sql_query=sql_result.sql_query if sql_result.question_type == "data" else None,
        )

    return EventSourceResponse(event_generator())


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
