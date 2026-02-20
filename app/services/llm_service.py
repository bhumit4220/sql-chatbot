from __future__ import annotations

from typing import AsyncGenerator

from openai import AsyncOpenAI
from pydantic import BaseModel

from app.config import settings

openai_client = AsyncOpenAI(api_key=settings.openai_api_key)

MODEL = "gpt-4o-mini"
MAX_HISTORY_MESSAGES = 10

SYSTEM_PROMPT_TEMPLATE = """You are a helpful admin assistant chatbot. You help administrators query their database and navigate their admin panel.

## Classification Rules
- If the question asks for counts, totals, lists, or specific records, classify as "data".
- If it asks how to do something, where to find something, or what something means, classify as "guidance".
- When genuinely ambiguous, prefer "guidance".

## Database Schema
{schema_text}

## Admin Panel Knowledge Base
{knowledge_text}

## Instructions
- For "data" questions: generate a safe, read-only SQL SELECT query. Never use INSERT, UPDATE, DELETE, DROP, or any DDL.
- For "guidance" questions: provide helpful explanation based on the knowledge base. Set sql_query to null.
- Always explain your reasoning in the explanation field.
- Set confidence between 0.0 and 1.0 based on how certain you are about the answer."""


class SqlGenerationResult(BaseModel):
    question_type: str  # "data" or "guidance"
    sql_query: str | None = None
    explanation: str
    confidence: float


class LLMService:
    def __init__(self, model: str = MODEL):
        self.model = model

    def _cap_history(
        self, history: list[dict], max_messages: int = MAX_HISTORY_MESSAGES
    ) -> list[dict]:
        if len(history) <= max_messages:
            return history
        return history[-max_messages:]

    async def generate_sql(
        self,
        question: str,
        schema_text: str,
        knowledge_text: str,
        conversation_history: list[dict],
    ) -> SqlGenerationResult:
        system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
            schema_text=schema_text or "(no schema available)",
            knowledge_text=knowledge_text or "(no knowledge base entries)",
        )

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self._cap_history(conversation_history))
        messages.append({"role": "user", "content": question})

        response = await openai_client.beta.chat.completions.parse(
            model=self.model,
            messages=messages,
            response_format=SqlGenerationResult,
        )

        return response.choices[0].message.parsed

    async def stream_answer(
        self,
        question: str,
        context: str,
        question_type: str,
        conversation_history: list[dict],
    ) -> AsyncGenerator[str, None]:
        if question_type == "data":
            system = (
                "You are a helpful admin assistant. The user asked a data question. "
                "Below are the SQL query results. Summarize them clearly and concisely.\n\n"
                f"{context}"
            )
        else:
            system = (
                "You are a helpful admin assistant. The user asked a guidance question. "
                "Use the knowledge base to provide a helpful answer.\n\n"
                f"{context}"
            )

        messages = [{"role": "system", "content": system}]
        messages.extend(self._cap_history(conversation_history))
        messages.append({"role": "user", "content": question})

        stream = await openai_client.chat.completions.create(
            model=self.model,
            messages=messages,
            stream=True,
        )

        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
