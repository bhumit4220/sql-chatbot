from pydantic import BaseModel


class NavItem(BaseModel):
    text: str
    href: str


class PageContext(BaseModel):
    url: str | None = None
    title: str | None = None
    heading: str | None = None
    breadcrumbs: list[NavItem] | None = None
    navigation: list[NavItem] | None = None


class ChatRequest(BaseModel):
    question: str
    conversation_id: str | None = None  # udid of existing conversation
    session_id: str | None = None  # widget session ID
    page_context: PageContext | None = None
