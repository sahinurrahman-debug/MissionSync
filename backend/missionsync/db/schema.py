"""The relational schema (SQLAlchemy Core). Alembic migrations in `migrations/` are the source of truth for
creating it; these definitions are what the application queries against.

    users 1──* sessions
    users 1──* drills 1──* audit_events
                      1──* reports
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, MetaData, String, Table, Text,
)

from sqlalchemy.sql import expression

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}
metadata = MetaData(naming_convention=NAMING)

users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("email", String(254), nullable=False, unique=True),          # stored lower-cased
    Column("display_name", String(80), nullable=False),
    Column("password_hash", String(255), nullable=False),               # argon2id — never the password
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("is_guest", Boolean, nullable=False, server_default=expression.false()),                  # temporary demo account
)

sessions = Table(
    "sessions", metadata,
    Column("id", String(64), primary_key=True),                         # sha256 of the cookie token, not the token
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False),
    Column("user_agent", String(200), nullable=False, server_default=""),
    Index("ix_sessions_user_id", "user_id"),
    Index("ix_sessions_expires_at", "expires_at"),
)

drills = Table(
    "drills", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("owner_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True),   # NULL = pre-accounts legacy drill
    Column("name", String(80), nullable=False, server_default="Untitled drill"),
    Column("notes", Text, nullable=False, server_default=""),
    Column("status", String(10), nullable=False, server_default="new"),                       # new | live | ended
    Column("dataset", String(40), nullable=False, server_default=""),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=True),
    Column("updated_at", DateTime(timezone=True), nullable=True),
    Column("state", Text, nullable=True),                                                     # JSON world state for restore
    Column("state_updated_at", DateTime(timezone=True), nullable=True),
    Index("ix_drills_owner_id", "owner_id"),
)

audit_events = Table(
    "audit_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("drill_id", Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False),
    Column("seq", Integer, nullable=False),
    Column("t", String(12), nullable=False),
    Column("msg", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_audit_events_drill_id", "drill_id"),
)

reports = Table(
    "reports", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("drill_id", Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False),
    Column("text", Text, nullable=False),
    Column("source", String(20), nullable=False),
    Column("kind", String(10), nullable=False),
    Column("incident_title", Text, nullable=False, server_default=""),
    Column("tier", String(2)),
    Column("urgency", Float),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_reports_drill_id", "drill_id"),
)

# Shared, non-personal cache of LLM scores keyed by report content (see agents.py). Not user data.
kv = Table(
    "kv", metadata,
    Column("key", String(40), primary_key=True),
    Column("value", Text, nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)
