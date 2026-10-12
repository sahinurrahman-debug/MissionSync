"""Accounts: users and sessions, and drills that belong to a user.

* users      — email (unique, lower-case), display name, argon2id password hash
* sessions   — server-side sessions; the table stores only a hash of the cookie token
* drills     — owner_id (FK → users, cascade), name, notes, status, timestamps and the saved world state

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE", name="fk_sessions_user_id_users"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_agent", sa.String(200), nullable=False, server_default=""),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])

    with op.batch_alter_table("drills") as batch:
        batch.add_column(sa.Column("owner_id", sa.Integer, nullable=True))
        batch.add_column(sa.Column("name", sa.String(80), nullable=False, server_default="Untitled drill"))
        batch.add_column(sa.Column("notes", sa.Text, nullable=False, server_default=""))
        batch.add_column(sa.Column("status", sa.String(10), nullable=False, server_default="new"))
        batch.add_column(sa.Column("created_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("state", sa.Text, nullable=True))
        batch.add_column(sa.Column("state_updated_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_foreign_key("fk_drills_owner_id_users", "users", ["owner_id"], ["id"], ondelete="CASCADE")
        batch.create_index("ix_drills_owner_id", ["owner_id"])


def downgrade() -> None:
    with op.batch_alter_table("drills") as batch:
        batch.drop_index("ix_drills_owner_id")
        batch.drop_constraint("fk_drills_owner_id_users", type_="foreignkey")
        for col in ("state_updated_at", "state", "updated_at", "created_at", "status", "notes", "name", "owner_id"):
            batch.drop_column(col)
    op.drop_index("ix_sessions_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("users")
