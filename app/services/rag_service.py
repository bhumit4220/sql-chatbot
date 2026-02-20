"""RAG retrieval service: embed question → cosine search → return relevant docs."""

import logging

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schema_document import SchemaDocument
from app.services.embedding_service import EmbeddingService

logger = logging.getLogger(__name__)

# How many documents to retrieve per query
DEFAULT_TOP_K = 15

# HNSW search tuning — higher = more accurate but slower
HNSW_EF_SEARCH = 100


class RAGService:
    """Retrieves relevant schema documents via pgvector cosine similarity."""

    def __init__(self):
        self._embedder = EmbeddingService()

    async def retrieve(
        self,
        session: AsyncSession,
        project_id: int,
        question: str,
        top_k: int = DEFAULT_TOP_K,
    ) -> list[SchemaDocument]:
        """Embed a question and retrieve the most relevant schema documents.

        Args:
            session: Database session.
            project_id: Project to search within.
            question: User's natural language question.
            top_k: Number of documents to return.

        Returns:
            List of SchemaDocument ordered by relevance (most relevant first).
        """
        # Set HNSW search parameter for this session
        await session.execute(
            text(f"SET LOCAL hnsw.ef_search = {HNSW_EF_SEARCH}")
        )

        # Embed the question
        query_embedding = await self._embedder.embed_query(question)

        # Cosine distance search using pgvector operator
        # Lower distance = more similar
        stmt = (
            select(SchemaDocument)
            .where(SchemaDocument.project_id == project_id)
            .order_by(SchemaDocument.embedding.cosine_distance(query_embedding))
            .limit(top_k)
        )

        result = await session.execute(stmt)
        docs = list(result.scalars().all())

        logger.info(
            "rag_retrieved",
            extra={
                "project_id": project_id,
                "question_preview": question[:80],
                "doc_count": len(docs),
            },
        )
        return docs

    def format_rag_context(self, documents: list[SchemaDocument]) -> str:
        """Format retrieved documents into a text block for the LLM prompt.

        Args:
            documents: Retrieved SchemaDocument list (from retrieve()).

        Returns:
            Formatted text string with document headers and content.
        """
        if not documents:
            return "(No schema documents available — database may not be indexed yet)"

        sections = []
        for i, doc in enumerate(documents, 1):
            header = f"[{doc.doc_type.upper()}]"
            if doc.source_table:
                header += f" {doc.source_table}"
                if doc.source_column:
                    header += f".{doc.source_column}"
            sections.append(f"--- Document {i} {header} ---\n{doc.content}")

        return "\n\n".join(sections)


# Singleton
rag_service = RAGService()
