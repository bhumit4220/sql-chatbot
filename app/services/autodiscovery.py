"""Auto-discovery orchestrator: indexes a project's database into pgvector documents."""

import asyncio
import json
import logging
import time
from uuid import uuid4

from sqlalchemy import delete, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models.project import Project
from app.models.schema_document import SchemaDocument
from app.services.data_sampler import DataSampler
from app.services.doc_chunker import DocChunker
from app.services.embedding_service import EmbeddingService
from app.services.schema_inspector import SchemaInspector
from app.services.tenant_db import tenant_db_manager

logger = logging.getLogger(__name__)

# Advisory lock namespace (fixed, avoids collision with other locks)
AUTODISCOVERY_LOCK_NAMESPACE = 42


async def _acquire_lock(session: AsyncSession, project_id: int) -> bool:
    """Try to acquire a two-key advisory lock. Returns False if already locked."""
    result = await session.execute(
        text("SELECT pg_try_advisory_lock(:namespace, :key)"),
        {"namespace": AUTODISCOVERY_LOCK_NAMESPACE, "key": project_id},
    )
    return result.scalar()


async def _release_lock(session: AsyncSession, project_id: int) -> None:
    """Release the advisory lock for a project."""
    await session.execute(
        text("SELECT pg_advisory_unlock(:namespace, :key)"),
        {"namespace": AUTODISCOVERY_LOCK_NAMESPACE, "key": project_id},
    )


class AutodiscoveryService:
    """Orchestrates the full auto-discovery pipeline for a project."""

    def __init__(self):
        self._inspector = SchemaInspector()
        self._sampler = DataSampler()
        self._chunker = DocChunker()
        self._embedder = EmbeddingService()

    async def index_project(self, session: AsyncSession, project: Project) -> int:
        """Run the full auto-discovery pipeline for a project.

        Pipeline:
        1. Acquire advisory lock
        2. Inspect database (rich metadata)
        3. Sample enum-like columns
        4. Chunk into text documents
        5. Embed all documents
        6. Atomic batch swap (insert new → update project → delete old)
        7. Release lock

        Args:
            session: Database session for the chatbot DB.
            project: Project to index.

        Returns:
            Number of documents indexed.

        Raises:
            RuntimeError: If lock cannot be acquired (another run in progress).
        """
        start = time.monotonic()
        project_id = project.id

        # Parse exclude tables
        exclude_tables = None
        if project.autodiscovery_exclude_tables:
            try:
                exclude_tables = json.loads(project.autodiscovery_exclude_tables)
            except (json.JSONDecodeError, TypeError):
                exclude_tables = None

        # 1. Acquire lock
        locked = await _acquire_lock(session, project_id)
        if not locked:
            logger.warning(
                "autodiscovery_lock_failed",
                extra={"project_id": project_id},
            )
            raise RuntimeError(f"Auto-discovery already running for project {project_id}")

        try:
            # Mark as indexing
            project.autodiscovery_status = "indexing"
            project.autodiscovery_error = None
            await session.commit()

            logger.info(
                "autodiscovery_started",
                extra={"project_id": project_id},
            )

            # 2. Get tenant engine and inspect
            engine = await tenant_db_manager.get_engine(
                project_id, project.connection_string_encrypted
            )
            rich_schema = await self._inspector.inspect_database_rich(
                engine, exclude_tables=exclude_tables
            )
            logger.info(
                "autodiscovery_inspected",
                extra={"project_id": project_id, "table_count": len(rich_schema.tables)},
            )

            # Also get simple schema for cache (used by existing code path)
            simple_schema = await self._inspector.inspect_database(engine)
            stripped = self._inspector.strip_sensitive_columns(simple_schema)
            schema_text = self._inspector.format_for_prompt(
                stripped, exclude_tables=exclude_tables
            )

            # 3. Sample enum-like columns
            sampler_result = await self._sampler.sample_database(engine, rich_schema)
            logger.info(
                "autodiscovery_sampled",
                extra={
                    "project_id": project_id,
                    "sample_count": len(sampler_result.samples),
                },
            )

            # 4. Chunk into documents
            documents = self._chunker.generate_documents(rich_schema, sampler_result)
            if not documents:
                logger.warning(
                    "autodiscovery_no_documents",
                    extra={"project_id": project_id},
                )
                project.autodiscovery_status = "completed"
                project.autodiscovery_doc_count = 0
                project.autodiscovery_completed_at = func.now()
                await session.commit()
                return 0

            # 5. Embed all documents
            texts = [doc.content for doc in documents]
            embeddings = await self._embedder.embed_texts(texts)
            logger.info(
                "autodiscovery_embedded",
                extra={"project_id": project_id, "doc_count": len(documents)},
            )

            # 6. Atomic batch swap
            new_batch_id = str(uuid4())

            # Insert new docs
            for doc, embedding in zip(documents, embeddings):
                session.add(
                    SchemaDocument(
                        project_id=project_id,
                        batch_id=new_batch_id,
                        doc_type=doc.doc_type,
                        source_table=doc.source_table,
                        source_column=doc.source_column,
                        content=doc.content,
                        embedding=embedding,
                        metadata_json=doc.metadata if doc.metadata else None,
                    )
                )
            await session.flush()

            # Update project to point to new batch
            project.autodiscovery_batch_id = new_batch_id
            project.autodiscovery_status = "completed"
            project.autodiscovery_completed_at = func.now()
            project.autodiscovery_doc_count = len(documents)
            project.autodiscovery_error = None
            # Update schema cache for existing code path
            project.schema_cache = schema_text
            project.schema_cached_at = str(func.now())
            await session.commit()

            # Clean up old batch docs (non-critical)
            try:
                await session.execute(
                    delete(SchemaDocument).where(
                        SchemaDocument.project_id == project_id,
                        SchemaDocument.batch_id != new_batch_id,
                    )
                )
                await session.commit()
            except Exception as e:
                logger.warning(
                    "autodiscovery_cleanup_failed",
                    extra={"project_id": project_id, "error": str(e)[:200]},
                )

            elapsed = time.monotonic() - start
            logger.info(
                "autodiscovery_completed",
                extra={
                    "project_id": project_id,
                    "doc_count": len(documents),
                    "duration_s": round(elapsed, 1),
                },
            )
            return len(documents)

        except Exception:
            # Mark as failed
            try:
                project.autodiscovery_status = "failed"
                await session.commit()
            except Exception:
                pass
            raise

        finally:
            # Always release lock
            try:
                await _release_lock(session, project_id)
            except Exception:
                pass


# Singleton service instance
autodiscovery_service = AutodiscoveryService()


async def run_autodiscovery_with_retry(
    project_id: int, max_retries: int = 1
) -> None:
    """Fire-and-forget wrapper with retry logic.

    Uses its own session (not request-scoped) since this runs as a background task.
    """
    for attempt in range(max_retries + 1):
        try:
            async with async_session_factory() as session:
                project = await session.get(Project, project_id)
                if not project:
                    logger.error(
                        "autodiscovery_project_not_found",
                        extra={"project_id": project_id},
                    )
                    return
                doc_count = await autodiscovery_service.index_project(session, project)
                logger.info(
                    "autodiscovery_retry_success",
                    extra={
                        "project_id": project_id,
                        "doc_count": doc_count,
                        "attempt": attempt + 1,
                    },
                )
                return
        except Exception as e:
            logger.error(
                "autodiscovery_failed",
                extra={
                    "project_id": project_id,
                    "error": str(e)[:500],
                    "attempt": attempt + 1,
                },
            )
            if attempt < max_retries:
                delay = 30 * (2**attempt)  # 30s, then 60s
                logger.info(
                    "autodiscovery_retrying",
                    extra={"project_id": project_id, "delay_s": delay},
                )
                await asyncio.sleep(delay)
            else:
                # Final failure — mark project as failed
                try:
                    async with async_session_factory() as session:
                        project = await session.get(Project, project_id)
                        if project:
                            project.autodiscovery_status = "failed"
                            project.autodiscovery_error = str(e)[:500]
                            await session.commit()
                except Exception:
                    logger.error(
                        "autodiscovery_status_update_failed",
                        extra={"project_id": project_id},
                    )
