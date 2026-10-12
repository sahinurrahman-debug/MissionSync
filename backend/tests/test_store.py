"""What a running drill persists, and the rule that a database hiccup never takes it down."""
from sqlalchemy import create_engine

from missionsync.persistence import Store, csv_safe
from .helpers import make_store


def test_a_store_without_an_engine_is_a_harmless_no_op() -> None:
    s = Store(None)
    assert not s.enabled and s.status() == "disabled"
    assert s.add_events(1, [(1, "00:00:00Z", "x")]) is False and s.add_report(1, "t", "radio", "created") is False
    assert s.save_state(1, {}, "live", "x") is False and s.load_state(1) is None
    assert s.set_kv("k", {}) is False and s.get_kv("k") is None and s.clear_drill_data(1) is False


def test_events_reports_state_and_cache_roundtrip(tmp_path) -> None:
    store, drill_id, svc = make_store(tmp_path)
    assert store.add_events(drill_id, [(1, "10:00:00Z", "first"), (2, "10:00:01Z", "second")])
    assert store.add_report(drill_id, "fire at the lab", "radio", "created", "Lab fire", "P2", 61.0)
    assert [e["msg"] for e in svc.drills.events(drill_id)] == ["first", "second"]
    assert svc.drills.reports(drill_id)[0]["incident_title"] == "Lab fire"

    assert store.save_state(drill_id, {"tick": 7}, "live", "xbd_snapshot")
    state, at = store.load_state(drill_id)
    assert state == {"tick": 7} and at.tzinfo is not None
    owner = svc.users.by_email("owner@example.com")[0]
    assert svc.drills.get(owner.id, drill_id).status == "live"

    assert store.set_kv("llm_cache", {"a": 1}) and store.set_kv("llm_cache", {"a": 2})
    assert store.get_kv("llm_cache")[0] == {"a": 2}

    assert store.clear_drill_data(drill_id)
    assert svc.drills.events(drill_id) == [] and svc.drills.reports(drill_id) == []
    assert store.load_state(drill_id) is not None                      # a restart wipes history, not the drill itself


def test_a_broken_database_returns_defaults_instead_of_raising() -> None:
    dead = Store(create_engine("sqlite:////nonexistent-dir/none.db"))
    assert dead.enabled
    assert dead.add_events(1, [(1, "t", "m")]) is False
    assert dead.add_report(1, "t", "radio", "created") is False
    assert dead.load_state(1) is None and dead.get_kv("x") is None and dead.set_kv("x", 1) is False


def test_csv_cells_cannot_become_spreadsheet_formulas() -> None:
    for danger in ("=1+1", "+cmd", "-2", "@SUM(A1)", "\tx"):
        assert csv_safe(danger).startswith("'")
    assert csv_safe("fire at the lab") == "fire at the lab" and csv_safe(5) == 5
