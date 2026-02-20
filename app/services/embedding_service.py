"""OpenAI embedding service wrapper for text-embedding-3-small."""

import logging

from openai import AsyncOpenAI

from app.config import settings

logger = logging.getLogger(__name__)

# OpenAI batch limit for embeddings API
MAX_BATCH_SIZE = 2048


class EmbeddingService:
    """Generates embeddings using OpenAI's text-embedding-3-small model."""

    def __init__(self):
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        self._model = settings.embedding_model
        self._dimensions = settings.embedding_dimensions

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed multiple texts in batches.

        Args:
            texts: List of text strings to embed.

        Returns:
            List of embedding vectors (each is a list of floats).
        """
        all_embeddings: list[list[float]] = []

        for i in range(0, len(texts), MAX_BATCH_SIZE):
            batch = texts[i : i + MAX_BATCH_SIZE]
            response = await self._client.embeddings.create(
                model=self._model,
                input=batch,
                dimensions=self._dimensions,
            )
            # Response embeddings are in same order as input
            batch_embeddings = [item.embedding for item in response.data]
            all_embeddings.extend(batch_embeddings)

            logger.debug(
                "Embedded batch %d-%d (%d texts, %d tokens)",
                i,
                i + len(batch),
                len(batch),
                response.usage.total_tokens,
            )

        logger.info(
            "Embedded %d texts using %s (%d dimensions)",
            len(texts),
            self._model,
            self._dimensions,
        )
        return all_embeddings

    async def embed_query(self, text: str) -> list[float]:
        """Embed a single query text.

        Args:
            text: Query string to embed.

        Returns:
            Embedding vector (list of floats).
        """
        response = await self._client.embeddings.create(
            model=self._model,
            input=[text],
            dimensions=self._dimensions,
        )
        return response.data[0].embedding
