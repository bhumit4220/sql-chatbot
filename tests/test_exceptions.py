from app.core.exceptions import (
    AuthenticationError,
    BudgetExceededError,
    ChatbotException,
    NotFoundError,
    RateLimitError,
    ValidationError,
)


def test_chatbot_exception_has_status_and_message():
    exc = ChatbotException(message="test error", status_code=500)
    assert exc.message == "test error"
    assert exc.status_code == 500


def test_not_found_error_defaults_to_404():
    exc = NotFoundError("Project not found")
    assert exc.status_code == 404


def test_auth_error_defaults_to_401():
    exc = AuthenticationError("Invalid token")
    assert exc.status_code == 401


def test_validation_error_defaults_to_422():
    exc = ValidationError("Invalid input")
    assert exc.status_code == 422


def test_rate_limit_error_defaults_to_429():
    exc = RateLimitError()
    assert exc.status_code == 429


def test_budget_exceeded_error_defaults_to_429():
    exc = BudgetExceededError()
    assert exc.status_code == 429
