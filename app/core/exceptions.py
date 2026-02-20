from fastapi import Request
from fastapi.responses import JSONResponse


class ChatbotException(Exception):
    def __init__(self, message: str = "Internal error", status_code: int = 500):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class NotFoundError(ChatbotException):
    def __init__(self, message: str = "Not found"):
        super().__init__(message=message, status_code=404)


class AuthenticationError(ChatbotException):
    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message=message, status_code=401)


class ValidationError(ChatbotException):
    def __init__(self, message: str = "Validation failed"):
        super().__init__(message=message, status_code=422)


class RateLimitError(ChatbotException):
    def __init__(self, message: str = "Rate limit exceeded. Please wait."):
        super().__init__(message=message, status_code=429)


class BudgetExceededError(ChatbotException):
    def __init__(self, message: str = "Daily query limit reached."):
        super().__init__(message=message, status_code=429)


async def chatbot_exception_handler(request: Request, exc: ChatbotException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.message})
