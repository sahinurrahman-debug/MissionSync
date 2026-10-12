"""Baseline: the drill history tables that shipped before accounts existed.

Creates drills, audit_events, reports and kv — but only if they are missing, so a database that already
holds the pre-accounts schema (e.g. the first Render Postgres) is adopted instead of failing.

Revision ID: 0001
Revises:
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def _missing(name: str) -> bool:
    return not sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if _missing("drills"):
        op.create_table(
            "drills",
            sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("dataset", sa.String(40), nullable=False, server_default=""),
        )
    if _missing("audit_events"):
        op.create_table(
            "audit_events",
            sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
            sa.Column("drill_id", sa.Integer, sa.ForeignKey("drills.id", ondelete="CASCADE"), nullable=False),
            sa.Column("seq", sa.Integer, nullable=False),
            sa.Column("t", sa.String(12), nullable=False),
            sa.Column("msg", sa.Text, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_audit_events_drill_id", "audit_events", ["drill_id"])
    if _missing("reports"):
        op.create_table(
            "reports",
            sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
            sa.Column("drill_id", sa.Integer, sa.ForeignKey("drills.id", ondelete="CASCADE"), nullable=False),
            sa.Column("text", sa.Text, nullable=False),
            sa.Column("source", sa.String(20), nullable=False),
            sa.Column("kind", sa.String(10), nullable=False),
            sa.Column("incident_title", sa.Text, nullable=False, server_default=""),
            sa.Column("tier", sa.String(2)),
            sa.Column("urgency", sa.Float),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_reports_drill_id", "reports", ["drill_id"])
    if _missing("kv"):
        op.create_table(
            "kv",
            sa.Column("key", sa.String(40), primary_key=True),
            sa.Column("value", sa.Text, nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    for name in ("kv", "reports", "audit_events", "drills"):
        op.drop_table(name)
