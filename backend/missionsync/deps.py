"""FastAPI dependencies: who is calling, which drill they own, and which drill is running for them."""
from __future__ import annotations

import asyncio

from fastapi import Depends, Request

from .auth import SESSION_COOKIE
from .errors import ApiError
from .manager import DrillRuntime
from .ratelimit import RateLimiter
from .repos import DrillRecord, User
from .services import Services


def get_services(request: Request) -> Services:
    return request.app.state.services


async def current_user(request: Request, svc: Services = Depends(get_services)) -> User:
    """The signed-in user, from the session cookie — verified against the database on every request."""
    token = request.cookies.get(SESSION_COOKIE, "")
    user = await asyncio.to_thread(svc.sessions.resolve, token) if token else None
    if user is None:
        raise ApiError(401, "unauthorized", "Please sign in to continue.")
    request.state.user_id = user.id
    return user


MAX_ID = 2**31 - 1                       # the database's integer column; anything larger cannot exist


async def owned_drill(drill_id: int, user: User = Depends(current_user), svc: Services = Depends(get_services)) -> DrillRecord:
    """The drill — only if the caller owns it. Someone else's drill answers 404, exactly like a missing one."""
    drill = None if not 1 <= drill_id <= MAX_ID else await asyncio.to_thread(svc.drills.get, user.id, drill_id, False)
    if drill is None:
        raise ApiError(404, "not_found", "That drill does not exist.")
    return drill


async def running_drill(drill: DrillRecord = Depends(owned_drill), svc: Services = Depends(get_services)) -> DrillRuntime:
    return await svc.manager.get(drill.id)


def client_ip(request: Request) -> str:
    """The caller's address. Behind `trusted_proxy_hops` reverse proxies the real client is that many entries from the
    RIGHT of X-Forwarded-For (each proxy appends the address it saw); entries further left were typed by the client
    and are never trusted, so a forged header cannot dodge the rate limits."""
    direct = request.client.host if request.client else "unknown"
    services = getattr(request.app.state, "services", None)
    hops = services.settings.trusted_proxy_hops if services is not None else 0
    if hops > 0:
        parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if len(parts) >= hops:
            return parts[-hops]
    return direct


def enforce(limiter: RateLimiter, key: str, message: str = "Too many requests — slow down.") -> None:
    wait = limiter.check(key)
    if wait > 0:
        retry = max(1, int(wait + 0.999))
        raise ApiError(429, "rate_limited", message, [{"field": "retry_after_seconds", "issue": str(retry)}], headers={"Retry-After": str(retry)})
