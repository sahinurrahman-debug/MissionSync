from __future__ import annotations

import time


class RateLimiter:
    """Token bucket per key: `burst` requests at once, then one every 1/refill_per_s seconds."""

    def __init__(self, burst: int = 5, refill_per_s: float = 0.5) -> None:
        self.burst, self.refill = burst, refill_per_s
        self._buckets: dict[str, tuple[float, float]] = {}

    def check(self, key: str) -> float:
        """0.0 when allowed, otherwise seconds until the next token."""
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (float(self.burst), now))
        tokens = min(float(self.burst), tokens + (now - last) * self.refill)
        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            self._trim(now)
            return 0.0
        self._buckets[key] = (tokens, now)
        return (1.0 - tokens) / self.refill

    def _trim(self, now: float) -> None:
        if len(self._buckets) > 5000:                      # forget idle keys so the table cannot grow without bound
            for k, (_, last) in list(self._buckets.items()):
                if now - last > 3600:
                    del self._buckets[k]
