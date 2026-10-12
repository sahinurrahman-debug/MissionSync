"""Test builders: a migrated throw-away database, services on top of it, and signed-in clients."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from missionsync.config import Settings
from missionsync.db import make_engine, migrate
from missionsync.main import create_app
from missionsync.persistence import Store
from missionsync.services import Services, build_services

PASSWORD = "correct horse 9"


def settings(**over) -> Settings:
    base = dict(database_url="sqlite://", env="test", session_days=14, max_drills_per_user=10, max_live_drills=6, idle_unload_s=600, allow_signup=True)
    base.update(over)
    return Settings(**base)


def make_services(tmp_path: Path, name: str = "app.db", **over) -> Services:
    engine = make_engine(f"sqlite:///{tmp_path / name}")
    return build_services(settings(database_url=f"sqlite:///{tmp_path / name}", **over), engine)


def make_store(tmp_path: Path, name: str = "store.db") -> tuple[Store, int, Services]:
    """A store plus one drill row owned by a fresh user (what an Orchestrator needs to persist)."""
    svc = make_services(tmp_path, name)
    user = svc.users.create("owner@example.com", "Owner", "x")
    drill = svc.drills.create(user.id, "Test drill")
    return svc.store, drill.id, svc


def signed_in(client: TestClient, email: str = "ann@example.com", name: str = "Ann") -> dict:
    r = client.post("/api/auth/signup", json={"email": email, "password": PASSWORD, "display_name": name})
    assert r.status_code == 201, r.text
    return r.json()["user"]


def app_client(tmp_path: Path, **over) -> tuple[TestClient, Services]:
    svc = make_services(tmp_path, **over)
    return TestClient(create_app(svc)), svc
