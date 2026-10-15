"""Environment-driven settings. One place to read them, so dev and production differ only by env vars."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    #: Postgres in production (Neon/Supabase/Render), a local SQLite file in development.
    database_url: str
    #: `production` turns on Secure cookies and refuses to run on a throwaway database.
    env: str
    #: Session cookie lifetime.
    session_days: int
    #: Maximum drills one account may keep (a free-tier guard against runaway LLM/CPU use).
    max_drills_per_user: int
    #: Maximum drills simulated at the same time on one server.
    max_live_drills: int
    #: Seconds a drill with no viewers stays in memory before it is saved and unloaded.
    idle_unload_s: int
    allow_signup: bool
    #: One-click demo: a temporary guest account with its own drill (real xBD scenario, real AI agents).
    allow_demo: bool
    #: Hours a guest account lives before it and its drills are deleted.
    guest_hours: int
    #: Guest accounts that may exist at once (a free-tier guard against someone scripting the button).
    max_guests: int
    #: Drills a guest may keep.
    guest_max_drills: int

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def secure_cookies(self) -> bool:
        return self.production or _flag("COOKIE_SECURE")


def load_settings() -> Settings:
    return Settings(
        database_url=os.getenv("DATABASE_URL", "").strip() or "sqlite:///missionsync.db",
        env=os.getenv("APP_ENV", "development").strip().lower(),
        session_days=int(os.getenv("SESSION_DAYS", "14")),
        max_drills_per_user=int(os.getenv("MAX_DRILLS_PER_USER", "10")),
        max_live_drills=int(os.getenv("MAX_LIVE_DRILLS", "6")),
        idle_unload_s=int(os.getenv("IDLE_UNLOAD_S", "600")),
        allow_signup=_flag("ALLOW_SIGNUP", True),
        allow_demo=_flag("ALLOW_DEMO", True),
        guest_hours=int(os.getenv("GUEST_HOURS", "24")),
        max_guests=int(os.getenv("MAX_GUESTS", "150")),
        guest_max_drills=int(os.getenv("GUEST_MAX_DRILLS", "2")),
    )
