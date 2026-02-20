from pydantic import BaseModel


class ChatRequest(BaseModel):
    question: str
    conversation_id: str | None = None  # udid of existing conversation
    session_id: str | None = None  # widget session ID
