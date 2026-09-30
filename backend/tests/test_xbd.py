import json
import sys
import types

from missionsync import xbd
from missionsync.models import IncidentType

FLORENCE = "xbd_full/hold/labels/hurricane-florence_00000006_post_disaster.json"
GRADE_WORDS = ("destroyed", "major-damage", "minor-damage", "no-damage", "un-classified", "grade")


def doc(subtypes, disaster="hurricane-florence", dtype="flooding"):
    return {
        "features": {"lng_lat": [
            {"properties": {"feature_type": "building", "subtype": s},
             "wkt": "POLYGON ((-79.5 35.2, -79.4 35.2, -79.4 35.3, -79.5 35.2))"} for s in subtypes
        ] + [{"properties": {"feature_type": "road", "subtype": "destroyed"}}]},
        "metadata": {"disaster": disaster, "disaster_type": dtype},
    }


def test_scene_becomes_a_seed_with_counts_type_and_hidden_ground_truth() -> None:
    seed = xbd.geojson_to_seed(doc(["destroyed"] * 4 + ["major-damage"] * 8 + ["minor-damage"] * 6 + ["no-damage"] * 2,
                                   "guatemala-volcano", "volcano"), "x/guatemala-volcano_00000004_post_disaster.json")
    assert seed["type"] == IncidentType.LANDSLIDE
    assert seed["counts"] == {"0": 2, "1": 6, "2": 8, "3": 4}
    # hidden truth = mean grade urgency over the buildings (roads are ignored)
    assert seed["gt_urgency"] == round((2 * 10 + 6 * 40 + 8 * 70 + 4 * 90) / 20, 1) == 59.0
    assert (seed["lon"], seed["lat"]) == (-79.5, 35.2)                     # real coordinates kept as provenance
    assert seed["population"] == 4 * 5 + 8 * 3 + 6 and seed["injuries"] == 4 + 4


def test_scene_text_shows_observable_counts_but_never_the_grade_labels() -> None:
    seed = xbd.geojson_to_seed(doc(["destroyed", "major-damage", "no-damage"]), FLORENCE)
    text = seed["text"].lower()
    assert "3 structures assessed" in text and "1 collapsed" in text and "1 severely" in text
    assert not any(word in text for word in GRADE_WORDS)
    assert str(seed["gt_urgency"]) not in seed["text"]


def test_unclassified_buildings_carry_no_signal() -> None:
    seed = xbd.geojson_to_seed(doc(["un-classified"] * 5 + ["no-damage"] * 2), FLORENCE)
    assert seed["counts"] == {"0": 2, "1": 0, "2": 0, "3": 0} and seed["gt_urgency"] == 10.0
    assert xbd.geojson_to_seed(doc(["un-classified"] * 3), FLORENCE) is None         # nothing gradable
    assert xbd.geojson_to_seed({"features": []}, FLORENCE) is None


def test_disaster_type_maps_to_incident_type() -> None:
    for dtype, expected in (("flooding", IncidentType.FLOOD), ("fire", IncidentType.FIRE),
                            ("wind", IncidentType.STRUCTURAL_COLLAPSE), ("volcano", IncidentType.LANDSLIDE)):
        assert xbd.geojson_to_seed(doc(["major-damage"], dtype=dtype), FLORENCE)["type"] == expected
    # no metadata → falls back to the event name
    no_meta = {"features": doc(["destroyed"])["features"]}
    assert xbd.geojson_to_seed(no_meta, "a/socal-fire_00000005_post_disaster.json")["type"] == IncidentType.FIRE


def test_kaggle_files_are_downloaded_and_converted(monkeypatch, tmp_path, real_load_xbd_records) -> None:
    local = tmp_path / "annotation.json"
    local.write_text(json.dumps(doc(["major-damage"])), encoding="utf-8")
    calls = []
    fake = types.SimpleNamespace(dataset_download=lambda slug, path: calls.append((slug, path)) or str(local))
    monkeypatch.setitem(sys.modules, "kagglehub", fake)
    monkeypatch.setattr(xbd, "_cached_file", lambda p: None)
    monkeypatch.setattr(xbd, "DATA_SOURCE", "not_loaded")

    records = real_load_xbd_records(file_path=FLORENCE)

    assert len(records) == 1 and records[0]["gt_urgency"] == 70.0
    assert calls == [(xbd.KAGGLE_SLUG, FLORENCE)] and xbd.DATA_SOURCE == "kaggle"


def test_download_backs_off_on_429_and_prefers_the_local_cache(monkeypatch) -> None:
    attempts = []

    def flaky(slug, path):
        attempts.append(path)
        if len(attempts) < 3:
            raise RuntimeError("429 Client Error: Too Many Requests")
        return "/tmp/file.json"

    monkeypatch.setattr(xbd.time, "sleep", lambda s: None)
    monkeypatch.setattr(xbd, "_cached_file", lambda p: None)
    assert xbd._download_with_backoff(types.SimpleNamespace(dataset_download=flaky), "p") == "/tmp/file.json"
    assert len(attempts) == 3

    monkeypatch.setattr(xbd, "_cached_file", lambda p: "/cache/hit.json")
    boom = types.SimpleNamespace(dataset_download=lambda *a, **k: (_ for _ in ()).throw(AssertionError("no API call")))
    assert xbd._download_with_backoff(boom, "p") == "/cache/hit.json"


def test_bundled_snapshot_is_real_data_with_variety() -> None:
    seeds = xbd.load_snapshot()
    assert len(seeds) >= 9
    assert {s["type"] for s in seeds} >= {IncidentType.FLOOD, IncidentType.FIRE,
                                          IncidentType.LANDSLIDE, IncidentType.STRUCTURAL_COLLAPSE}
    assert max(s["gt_urgency"] for s in seeds) >= 55 and min(s["gt_urgency"] for s in seeds) <= 10
    assert all(s["source_file"].endswith(".json") and not any(w in s["text"].lower() for w in GRADE_WORDS) for s in seeds)


def test_load_seeds_defaults_to_the_bundled_snapshot_and_kaggle_is_opt_in(monkeypatch) -> None:
    kaggle = [{"type": IncidentType.FIRE, "gt_urgency": 50.0}]
    monkeypatch.setattr(xbd, "load_xbd_records", lambda *a, **k: kaggle)

    monkeypatch.delenv("XBD_SOURCE", raising=False)
    snapshot_first = xbd.load_seeds()
    assert snapshot_first != kaggle and xbd.DATA_SOURCE == "xbd_snapshot"      # instant, no Kaggle traffic

    monkeypatch.setenv("XBD_SOURCE", "kaggle")
    assert xbd.load_seeds() == kaggle
    monkeypatch.delenv("XBD_SOURCE")
    monkeypatch.setenv("XBD_FILE_PATH", FLORENCE)                              # a specific file always goes to Kaggle
    assert xbd.load_seeds() == kaggle
    monkeypatch.delenv("XBD_FILE_PATH")

    monkeypatch.setenv("XBD_SOURCE", "kaggle")
    monkeypatch.setattr(xbd, "load_xbd_records", lambda *a, **k: [])
    assert xbd.load_seeds() and xbd.DATA_SOURCE == "xbd_snapshot"               # Kaggle down → real snapshot

    monkeypatch.setattr(xbd, "load_snapshot", lambda *a, **k: [])
    fallback = xbd.load_seeds()
    assert xbd.DATA_SOURCE == "offline_fallback" and len(fallback) == 10
    assert all(not any(w in r["text"].lower() for w in GRADE_WORDS) for r in fallback)


def test_pick_seeds_is_deterministic_diverse_and_caps_quiet_scenes() -> None:
    records = xbd.load_snapshot()
    a = xbd.pick_seeds(records, 9, salt="scenario")
    b = xbd.pick_seeds(list(reversed(records)), 9, salt="scenario")
    assert [s["source_file"] for s in a] == [s["source_file"] for s in b]      # order-independent
    assert len({s["type"] for s in a[:4]}) == 4                                # first deal spans hazard types
    assert sum(1 for s in a if s["gt_urgency"] <= 10) <= 4
    assert xbd.pick_seeds([], 5, "x") == []
