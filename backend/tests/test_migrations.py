"""The migrations folder alone must be able to build (and rebuild) the schema."""
import pytest
from alembic import command
from sqlalchemy import inspect, text

from missionsync.db import make_engine, migrate
from missionsync.db.engine import alembic_config
from missionsync.db.schema import metadata

TABLES = {"users", "sessions", "drills", "audit_events", "reports", "kv"}


@pytest.fixture
def engine(tmp_path):
    return make_engine(f"sqlite:///{tmp_path / 'm.db'}")


def test_running_the_migrations_creates_the_whole_schema_from_nothing(engine) -> None:
    migrate(engine)
    insp = inspect(engine)
    assert TABLES <= set(insp.get_table_names())
    for table in ("drills", "users", "sessions"):                                   # the code and the database agree
        assert {c.name for c in metadata.tables[table].columns} == {c["name"] for c in insp.get_columns(table)}


def test_foreign_keys_and_unique_constraints_exist(engine) -> None:
    migrate(engine)
    insp = inspect(engine)
    fks = {(t, tuple(f["constrained_columns"]), f["referred_table"]) for t in ("sessions", "drills", "audit_events", "reports") for f in insp.get_foreign_keys(t)}
    assert ("sessions", ("user_id",), "users") in fks
    assert ("drills", ("owner_id",), "users") in fks
    assert ("audit_events", ("drill_id",), "drills") in fks and ("reports", ("drill_id",), "drills") in fks
    assert any(u["column_names"] == ["email"] for u in insp.get_unique_constraints("users"))
    assert "ix_drills_owner_id" in {i["name"] for i in insp.get_indexes("drills")}


def test_the_database_enforces_the_foreign_keys(engine) -> None:
    migrate(engine)
    with pytest.raises(Exception):
        with engine.begin() as conn:                                                # a drill owned by a user that does not exist
            conn.execute(text("INSERT INTO drills (owner_id, started_at, name, notes, status, dataset) VALUES (999, '2026-01-01', 'x', '', 'new', '')"))
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO users (email, display_name, password_hash, created_at) VALUES ('a@b.co', 'A', 'h', '2026-01-01')"))
        conn.execute(text("INSERT INTO drills (owner_id, started_at, name, notes, status, dataset) VALUES (1, '2026-01-01', 'x', '', 'new', '')"))
        conn.execute(text("DELETE FROM users"))                                     # deleting the owner removes their drills
        assert conn.execute(text("SELECT count(*) FROM drills")).scalar_one() == 0


def test_migrating_twice_is_harmless(engine) -> None:
    migrate(engine)
    migrate(engine)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0002"


def test_a_pre_accounts_database_is_adopted_and_keeps_its_rows(engine) -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE drills (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at DATETIME NOT NULL, dataset VARCHAR(40) NOT NULL)")
        conn.exec_driver_sql("INSERT INTO drills (started_at, dataset) VALUES ('2026-09-01 00:00:00', 'xbd_snapshot')")
    migrate(engine)
    with engine.connect() as conn:
        row = conn.execute(text("SELECT id, owner_id, name, status, dataset FROM drills")).one()
    assert tuple(row) == (1, None, "Untitled drill", "new", "xbd_snapshot")        # the legacy drill survives, owned by nobody


def test_the_latest_migration_can_be_rolled_back_and_reapplied(engine) -> None:
    migrate(engine)
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, "0001")
    assert "users" not in inspect(engine).get_table_names()
    assert "owner_id" not in {c["name"] for c in inspect(engine).get_columns("drills")}
    migrate(engine)
    assert "users" in inspect(engine).get_table_names()


def test_the_alembic_command_line_works_the_way_ci_and_deploy_scripts_run_it(tmp_path) -> None:
    """`alembic upgrade head` is a separate program: it does not get the app's import path. This runs it in isolated
    mode (no current-directory or PYTHONPATH help) — the exact failure CI hit before env.py set up its own path."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{tmp_path / 'cli.db'}"}
    env.pop("PYTHONPATH", None)

    def alembic(*args: str) -> str:
        cmd = [sys.executable, "-I", "-c", "import sys; from alembic.config import main; main(argv=sys.argv[1:])", "-c", str(backend / "alembic.ini"), *args]
        done = subprocess.run(cmd, cwd=backend, env=env, capture_output=True, text=True, timeout=120)
        assert done.returncode == 0, f"alembic {' '.join(args)} failed:\n{done.stderr[-600:]}"
        return done.stdout

    alembic("upgrade", "head")
    alembic("downgrade", "0001")
    alembic("upgrade", "head")
    assert "0002 (head)" in alembic("current")
    engine = make_engine(env["DATABASE_URL"])
    assert TABLES <= set(inspect(engine).get_table_names())
