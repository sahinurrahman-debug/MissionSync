"""Wires the application together: engine → migrations → repositories → drill manager. Built once per app."""
from __future__ import annotations

import logging
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
    report_limiter: RateLimiter = field(default_factory=lambda: RateLimiter(burst=5, refill_per_s=0.5))       # burst 5, then 1 per 2 s
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
    sessions = SessionRepo(engine, settings.session_days)
    return Services(
        settings=settings, engine=engine, store=store,
        users=UserRepo(engine), sessions=sessions,
        drills=DrillRepo(engine, settings.max_drills_per_user),
        manager=DrillManager(store, settings, sessions=sessions),
    )
