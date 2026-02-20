import pytest
from unittest.mock import AsyncMock

from app.core.rate_limiter import RateLimiter


async def test_allows_under_limit():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    allowed = await limiter.check("key:123:minute", limit=30, window_seconds=60)
    assert allowed is True


async def test_blocks_over_limit():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=31)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    allowed = await limiter.check("key:123:minute", limit=30, window_seconds=60)
    assert allowed is False


async def test_expire_set_only_on_first_incr():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=1)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    await limiter.check("key:1", limit=10, window_seconds=60)
    mock_redis.expire.assert_called_once_with("key:1", 60)


async def test_expire_not_set_on_subsequent_incr():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=5)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    await limiter.check("key:1", limit=10, window_seconds=60)
    mock_redis.expire.assert_not_called()


async def test_at_exact_limit_still_allowed():
    mock_redis = AsyncMock()
    mock_redis.incr = AsyncMock(return_value=30)
    mock_redis.expire = AsyncMock()

    limiter = RateLimiter(redis=mock_redis)
    allowed = await limiter.check("key:1", limit=30, window_seconds=60)
    assert allowed is True
