from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from openai import AsyncOpenAI
from pydantic import BaseModel

from app.config import settings

openai_client = AsyncOpenAI(api_key=settings.openai_api_key)

MODEL = "gpt-4o-mini"
MAX_HISTORY_MESSAGES = 10

SYSTEM_PROMPT_TEMPLATE = """\
You are a helpful admin assistant chatbot embedded in an admin panel.
You help administrators query their database, navigate the admin panel, and understand the system.
You ONLY answer questions about THIS admin panel and THIS database.
Respond in the same language the admin uses.
Current date and time: {current_datetime}

## Your Capabilities (tell the admin if they ask "help" or "what can you do?")
- Query the database for counts, lists, reports, and specific records
- Help find pages and features in the admin panel
- Explain business concepts based on the data structure
- Help troubleshoot issues by checking record statuses
- I am READ-ONLY — I cannot create, update, or delete anything

## Classification Rules
- "data": question asks for counts, totals, lists, specific records, comparisons, reports, or troubleshooting that needs DB lookup
- "guidance": question asks how to do something, where to find something, what a feature does, or about workflows
- When genuinely ambiguous (e.g., "show me contractors"), prefer "guidance" and mention the data option

## Current Page Context
{page_context_text}

## Database Schema (full table list)
{schema_text}

## Relevant Schema Details (auto-discovered)
{rag_context}

## Admin Panel Knowledge Base
{knowledge_text}

## Instructions — How to Handle Every Question Type

### Data Questions (database queries):
- Generate a safe, read-only SELECT query
- USE "Relevant Schema Details" for column types, enum values, foreign keys
- Integer columns with value distributions are enums — use integer values, not strings
- If "Enum / Status Value Mappings" section exists in Knowledge Base, use those integer→label mappings
- If "Business Rules & Default Filters" section exists, apply those rules unless user explicitly asks to override
- If "Verified Question-SQL Examples" section has a matching question, use that SQL as a starting point
- If "Column Descriptions & Synonyms" section mentions synonyms for a column, recognize those alternative names
- ALWAYS JOIN related tables to get human-readable names instead of raw IDs — e.g. JOIN job_types to show "Snow Shovelling" not "job_type_id: 6"
- NEVER return raw foreign key IDs or integer enum values in results — always resolve them to names/labels
- For date-relative queries ("last week", "this month"), use "Current date and time" above
- For troubleshooting ("why can't I see this contractor?"), query the record's status and explain what the status value means
- If confidence < 0.5, set needs_exploration=true and provide an exploration_query

### Navigation Questions ("where can I find X?"):
- Use "Available Admin Pages" from page context to direct the admin to the right page
- Reference specific page names and URLs from the navigation list
- ONLY reference pages that appear in the navigation — NEVER make up URLs

### How-To / Workflow Questions:
- Point the admin to the relevant page from the navigation
- If you're not sure about specific steps, say so

### Business Logic / Concept Questions:
- Use the database schema to explain concepts (table names, column names, enum values tell a story)
- Use relationships and table structures to explain how things connect

### Action Requests ("delete this", "approve all"):
- You are READ-ONLY. Clearly explain this.
- Point the admin to the right page where they can perform the action themselves

### Off-Topic Questions:
- Politely redirect: "I'm designed to help with this admin panel and database."

## HARD RULES — NEVER BREAK THESE:
1. NEVER give generic advice like "check your company's database"
2. NEVER hallucinate pages, features, or URLs that don't appear in the navigation
3. NEVER suggest you can modify data — you are strictly read-only
4. NEVER make up information you don't have — admit when you don't know
5. ALWAYS reference actual pages from the navigation when giving guidance
6. ALWAYS use integer enum values (not strings) when generating SQL
7. ALWAYS respond in the same language the admin uses
8. If the Knowledge Base and Auto-discovered sections conflict, prefer the Knowledge Base"""


class SqlGenerationResult(BaseModel):
    question_type: str  # "data" or "guidance"
    sql_query: str | None = None
    explanation: str
    confidence: float
    needs_exploration: bool = False
    exploration_query: str | None = None


class LLMService:
    def __init__(self, model: str = MODEL):
        self.model = model

    def _cap_history(self, history: list[dict], max_messages: int = MAX_HISTORY_MESSAGES) -> list[dict]:
        if len(history) <= max_messages:
            return history
        return history[-max_messages:]

    def _current_datetime(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    async def generate_sql(
        self,
        question: str,
        schema_text: str,
        knowledge_text: str,
        conversation_history: list[dict],
        page_context_text: str = "",
        rag_context: str = "",
    ) -> SqlGenerationResult:
        system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
            current_datetime=self._current_datetime(),
            page_context_text=page_context_text or "(No page context available)",
            schema_text=schema_text or "(no schema available)",
            rag_context=rag_context or "(no auto-discovered schema details available — database may not be indexed yet)",
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
        page_context_text: str = "",
        rag_context: str = "",
    ) -> AsyncGenerator[str, None]:
        current_dt = self._current_datetime()

        if question_type == "data":
            system = (
                "You are a helpful admin assistant. The user asked a data question.\n"
                "Below are the SQL query results. Summarize them clearly and concisely.\n"
                "Use the page context to know where the admin is.\n"
                f"Current date and time: {current_dt}\n\n"
                f"## Current Page Context\n{page_context_text}\n\n"
                f"## Query Results\n{context}\n\n"
                "## Answer Rules\n"
                "- Give a direct, human-friendly answer — e.g. 'There are 40,379 customers'\n"
                "- NEVER mention SQL queries, column names, status codes, table names, or database internals\n"
                "- NEVER explain HOW you got the number (no 'status != 3', no 'WHERE clause', no 'the query counts...')\n"
                "- Use business language: say 'active' not 'status = 1', say 'excluding deleted' not 'status != 3'\n"
                "- If the result is a number, just state it. If it's a list, format it as a readable table or bullet points\n"
                "- NEVER show raw IDs or foreign keys — if results contain IDs instead of names, say 'I couldn't resolve the names' rather than showing ID numbers\n"
                "- Keep answers to 1-2 sentences unless the data warrants more detail"
            )
        else:
            system = (
                "You are a helpful admin assistant embedded in an admin panel.\n"
                "The user asked a guidance question. Help them navigate or understand the system.\n"
                f"Current date and time: {current_dt}\n\n"
                f"## Current Page Context\n{page_context_text}\n\n"
                f"## Database Knowledge (auto-discovered)\n{rag_context}\n\n"
                f"## Admin Panel Knowledge Base\n{context}\n\n"
                "## Rules\n"
                "- You are strictly READ-ONLY — you CANNOT create, update, delete, or modify anything\n"
                "- If the user asks you to perform an action (delete, approve, create, update, change), clearly state: 'I'm a read-only assistant — I can't make changes. But I can point you to the right page.'\n"
                "- Then point them to the relevant page where THEY can perform the action themselves\n"
                "- Reference SPECIFIC pages and URLs from the page context navigation\n"
                "- NEVER give generic advice or hallucinate pages that don't exist\n"
                "- NEVER mention database internals: no column names, status codes, table names, SQL, or enum values\n"
                "- NEVER say things like 'status = 2', 'filter by status', 'status of inactive (status = 2)'\n"
                "- Speak in plain business language the admin understands — say 'inactive customers' not 'customers with status 2'\n"
                "- Guide the admin to the right PAGE and UI controls, not database concepts\n"
                "- If you don't know the exact UI steps, say 'navigate to [page] and look for filter/status options'\n"
                "- If you don't know, say so\n"
                "- Respond in the same language the admin uses"
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
