"""Alembic environment.

Two ways to run it:
  * from the app (`missionsync.db.migrate`), which hands in an open connection, and
  * from the CLI (`alembic upgrade head`), which reads DATABASE_URL.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import pool

# Works however alembic is started (CLI, python -m alembic, or from the app): make `missionsync` importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from missionsync.db.engine import make_engine  # noqa: E402
from missionsync.db.schema import metadata

config = context.config
target_metadata = metadata


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,          # SQLite cannot ALTER constraints in place
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        _run(connection)
        return
    engine = make_engine(os.getenv("DATABASE_URL", "").strip() or "sqlite:///missionsync.db")
    with engine.connect() as conn:
        _run(conn)
        conn.commit()
    engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Offline (SQL script) mode is not supported; run `alembic upgrade head` against a database.")
run_migrations_online()
