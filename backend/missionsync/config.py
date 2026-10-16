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
    #: Reverse proxies in front of the app that append to X-Forwarded-For (Render: 1; direct or local: 0). Only that
    #: many entries from the right are trusted — anything further left is written by the client and ignored.
    trusted_proxy_hops: int = 0
    #: Largest request body the API reads (bytes).
    max_body_bytes: int = 65536
    #: Sessions one account may hold at once; the oldest is signed out when it signs in on one more device.
    max_sessions_per_user: int = 10
    #: LLM tokens one drill may spend while it is loaded (the free Groq tier is ~200k a day per model for EVERYONE);
    #: afterwards that drill continues on the rule-based agents. 0 = unlimited.
    ai_tokens_per_drill: int = 80000
    ai_tokens_per_guest_drill: int = 30000
    #: Minimum seconds between two background AI refinement passes of one drill (changes in between are batched).
    refine_min_interval_s: float = 45.0

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
        trusted_proxy_hops=max(0, int(os.getenv("TRUSTED_PROXY_HOPS", "0"))),
        max_body_bytes=int(os.getenv("MAX_BODY_BYTES", "65536")),
        max_sessions_per_user=max(1, int(os.getenv("MAX_SESSIONS_PER_USER", "10"))),
        ai_tokens_per_drill=int(os.getenv("AI_TOKENS_PER_DRILL", "80000")),
        ai_tokens_per_guest_drill=int(os.getenv("AI_TOKENS_PER_GUEST_DRILL", "30000")),
        refine_min_interval_s=float(os.getenv("REFINE_MIN_INTERVAL_S", "45")),
    )
