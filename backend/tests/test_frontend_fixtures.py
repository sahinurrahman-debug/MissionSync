"""The frontend's component tests run on snapshots captured from this backend. If the API shape changes, these fail
until the fixtures are regenerated (`python scripts/make_frontend_fixtures.py`) — so the UI tests can never drift
away from what the server really sends."""
import json
from pathlib import Path

from missionsync.hub import snapshot_json

from .test_orchestrator import booted, run, tick

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test-utils" / "fixtures"


def shape(value):
    """Key structure only (values differ run to run): dict → sorted keys with the shape of each; list → shape of first item."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__ if value is not None else "null"


def keys_only(s):
    """Compare which fields exist, ignoring the type of nullable ones and empty collections."""
    if isinstance(s, dict):
        return {k: keys_only(v) for k, v in s.items()}
    if isinstance(s, list):
        return [keys_only(s[0])] if s else []
    return "leaf"


async def live_snapshot(auto: bool) -> dict:
    o = await booted(auto=auto)
    for _ in range(3 if auto else 0):
        await tick(o, 1)
    return snapshot_json(o.snapshot())


def test_fixtures_have_the_same_fields_as_the_live_api() -> None:
    for name, auto in (("manual", False), ("auto", True)):
        fixture = json.loads((FIXTURES / f"snapshot.{name}.json").read_text(encoding="utf-8"))
        live = run(live_snapshot(auto))
        stored, current = keys_only(shape(fixture)), keys_only(shape(live))
        for top in ("incidents", "resources", "proposals", "actions", "settings"):
            assert stored.get(top) == current.get(top), f"snapshot.{name}.json is stale in '{top}' — regenerate the fixtures"
        assert set(stored) == set(current), f"snapshot.{name}.json has different top-level fields: {set(stored) ^ set(current)}"
        assert set(fixture["metrics"]) == set(live["metrics"]), "metrics fields changed — regenerate the fixtures"


def test_the_fixtures_show_the_two_states_the_ui_tests_rely_on() -> None:
    manual = json.loads((FIXTURES / "snapshot.manual.json").read_text(encoding="utf-8"))
    auto = json.loads((FIXTURES / "snapshot.auto.json").read_text(encoding="utf-8"))
    assert manual["proposals"] and all(r["status"] == "available" for r in manual["resources"])
    assert not auto["proposals"] and any(r["status"] == "en_route" for r in auto["resources"])
    assert manual["settings"]["auto_dispatch"] is False and auto["settings"]["auto_dispatch"] is True
