from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


class AuditService:
    async def log_event(
        self,
        session: AsyncSession,
        project_id: int,
        api_key_id: int | None = None,
        event_type: str = "",
        question: str = "",
        sql_query: str | None = None,
        validation_result: int | None = None,
        rejection_reason: str | None = None,
        execution_time_ms: float | None = None,
        result_row_count: int | None = None,
        token_usage: int | None = None,
        error_message: str | None = None,
        ip_address: str = "0.0.0.0",
    ) -> AuditLog:
        log = AuditLog(
            project_id=project_id,
            api_key_id=api_key_id,
            event_type=event_type,
            question=question,
            sql_query=sql_query,
            validation_result=validation_result,
            rejection_reason=rejection_reason,
            execution_time_ms=execution_time_ms,
            result_row_count=result_row_count,
            token_usage=token_usage,
            error_message=error_message,
            ip_address=ip_address,
        )
        session.add(log)
        await session.flush()
        return log
