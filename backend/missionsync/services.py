"""Wires the application together: engine → migrations → repositories → drill manager. Built once per app."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import Engine

from .config import Settings, load_settings
from .db import make_engine, migrate
from .manager import DrillManager
from .persistence import Store
from .ratelimit import RateLimiter
from .repos import DrillRepo, SessionRepo, UserRepo

logger = logging.getLogger("missionsync")


@dataclass
class Services:
    settings: Settings
    engine: Engine
    store: Store
    users: UserRepo
    sessions: SessionRepo
    drills: DrillRepo
    manager: DrillManager
    login_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=8, refill_per_s=1 / 6))      # brute-force guard
    signup_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=4, refill_per_s=1 / 30))
    demo_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=3, refill_per_s=1 / 60))      # a guest is an account: a few per minute per address
    report_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=5, refill_per_s=0.5))       # burst 5, then 1 per 2 s
    user_report_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=12, refill_per_s=1.0))   # per account, across all its drills: the shared AI quota is not one person's to drain
    ops_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=30, refill_per_s=3))


def build_services(settings: Optional[Settings] = None, engine: Optional[Engine] = None) -> Services:
    settings = settings or load_settings()
    if settings.production and settings.database_url.startswith("sqlite"):
        raise RuntimeError("APP_ENV=production needs a real database: set DATABASE_URL (Postgres).")
    if settings.database_url.startswith("sqlite") and engine is None:
        logger.warning("Using a local SQLite file. Fine for development; set DATABASE_URL to Postgres for anything shared.")
    engine = engine or make_engine(settings.database_url)
    migrate(engine)
    store = Store(engine)
    sessions = SessionRepo(engine, settings.session_days, settings.max_sessions_per_user)
    svc = Services(
        settings=settings, engine=engine, store=store,
        users=UserRepo(engine), sessions=sessions,
        drills=DrillRepo(engine, settings.max_drills_per_user),
        manager=DrillManager(store, settings, sessions=sessions),
    )
    svc.manager.housekeeping = lambda: housekeeping(svc)
    return svc


async def housekeeping(svc: Services) -> dict:
    """Delete expired sessions and expired guest accounts (with their drills, stopping any that are still running)."""
    purged = await asyncio.to_thread(svc.sessions.purge_expired)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=svc.settings.guest_hours)
    guests = await asyncio.to_thread(svc.users.expired_guests, cutoff)
    for user_id, drill_ids in guests:
        for did in drill_ids:
            await svc.manager.unload(did, save=False)
        await asyncio.to_thread(svc.users.delete_with_data, user_id)
    if guests:
        logger.info("removed %s expired guest account(s)", len(guests))
    return {"sessions": purged, "guests": len(guests)}
