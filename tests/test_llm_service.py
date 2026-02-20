import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.llm_service import LLMService, SqlGenerationResult


@pytest.fixture
def llm_service():
    return LLMService()


@patch("app.services.llm_service.openai_client")
async def test_generate_sql_data_question(mock_client, llm_service):
    """For a data question, generate_sql should return SQL."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.parsed = SqlGenerationResult(
        question_type="data",
        sql_query="SELECT count(*) FROM jobs WHERE status = 1",
        explanation="Counts active jobs",
        confidence=0.95,
    )
    mock_response.usage.total_tokens = 150
    mock_client.beta.chat.completions.parse = AsyncMock(return_value=mock_response)

    result = await llm_service.generate_sql(
        question="How many active jobs?",
        schema_text="CREATE TABLE jobs (id int, status int);",
        knowledge_text="",
        conversation_history=[],
    )
    assert result.question_type == "data"
    assert "SELECT" in result.sql_query
    assert result.confidence > 0.5


@patch("app.services.llm_service.openai_client")
async def test_generate_sql_guidance_question(mock_client, llm_service):
    """For a guidance question, sql_query should be None."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.parsed = SqlGenerationResult(
        question_type="guidance",
        sql_query=None,
        explanation="This is a guidance question about approving contractors",
        confidence=0.9,
    )
    mock_response.usage.total_tokens = 100
    mock_client.beta.chat.completions.parse = AsyncMock(return_value=mock_response)

    result = await llm_service.generate_sql(
        question="How do I approve a contractor?",
        schema_text="",
        knowledge_text="To approve a contractor, go to /admin/contractors...",
        conversation_history=[],
    )
    assert result.question_type == "guidance"
    assert result.sql_query is None


async def test_conversation_history_capped(llm_service):
    """History should be capped at last 10 messages."""
    history = [{"role": "user", "content": f"msg {i}"} for i in range(20)]
    capped = llm_service._cap_history(history)
    assert len(capped) == 10
    assert capped[0]["content"] == "msg 10"


async def test_conversation_history_short_unchanged(llm_service):
    """Short history should pass through unchanged."""
    history = [{"role": "user", "content": f"msg {i}"} for i in range(3)]
    capped = llm_service._cap_history(history)
    assert len(capped) == 3


@patch("app.services.llm_service.openai_client")
async def test_generate_sql_includes_conversation_history(mock_client, llm_service):
    """Conversation history should be included in the messages sent to OpenAI."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.parsed = SqlGenerationResult(
        question_type="data",
        sql_query="SELECT count(*) FROM jobs",
        explanation="Total jobs",
        confidence=0.9,
    )
    mock_response.usage.total_tokens = 100
    mock_client.beta.chat.completions.parse = AsyncMock(return_value=mock_response)

    history = [
        {"role": "user", "content": "How many contractors?"},
        {"role": "assistant", "content": "There are 42 contractors."},
    ]
    await llm_service.generate_sql(
        question="And how many jobs?",
        schema_text="CREATE TABLE jobs (id int);",
        knowledge_text="",
        conversation_history=history,
    )

    # Verify the call was made with history included
    call_args = mock_client.beta.chat.completions.parse.call_args
    messages = call_args.kwargs["messages"]
    # Should have: system + history messages + user question
    assert len(messages) >= 4  # system + 2 history + 1 user
    assert messages[-1]["content"] == "And how many jobs?"
