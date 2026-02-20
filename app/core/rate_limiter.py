from redis.asyncio import Redis


class RateLimiter:
    def __init__(self, redis: Redis):
        self._redis = redis

    async def check(self, key: str, limit: int, window_seconds: int) -> bool:
        current = await self._redis.incr(key)
        if current == 1:
            await self._redis.expire(key, window_seconds)
        return current <= limit
