import json
import sys
import types

from missionsync import xbd


def test_geojson_annotation_becomes_xbd_seed() -> None:
    seed = xbd.geojson_to_seed(
        {
            "features": [
                {"properties": {"feature_type": "building", "subtype": "minor-damage"}},
                {"properties": {"feature_type": "building", "subtype": "destroyed"}},
                {"properties": {"feature_type": "road", "subtype": "destroyed"}},
            ]
        },
        "xbd_full/hold/labels/hurricane-florence_00000006_post_disaster.json",
    )

    assert seed is not None
    assert seed["type"].value == "flood"
    assert seed["gt_urgency"] == 90.0
    assert "2 building footprints" in seed["text"]
    assert "destroyed" not in seed["text"]
    assert "damage is" not in seed["text"]
    assert seed["lat"] == seed["lon"] == 0.0


def test_load_xbd_records_downloads_configured_kaggle_annotation(
    monkeypatch, tmp_path
) -> None:
    annotation_path = "xbd_full/hold/labels/hurricane-florence_00000006_post_disaster.json"
    local_file = tmp_path / "annotation.json"
    local_file.write_text(
        json.dumps(
            {
                "features": [
                    {"properties": {"feature_type": "building", "subtype": "major-damage"}}
                ]
            }
        ),
        encoding="utf-8",
    )
    calls = []
    fake_kagglehub = types.SimpleNamespace(
        dataset_download=lambda slug, path: calls.append((slug, path)) or str(local_file)
    )
    monkeypatch.setitem(sys.modules, "kagglehub", fake_kagglehub)
    monkeypatch.setattr(xbd, "_CACHE", None)
    monkeypatch.setattr(xbd, "DATA_SOURCE", "not_loaded")

    records = xbd.load_xbd_records(file_path=annotation_path)

    assert len(records) == 1
    assert records[0]["gt_urgency"] == 70.0
    assert calls == [(xbd.KAGGLE_SLUG, annotation_path)]
    assert xbd.DATA_SOURCE == "kaggle"


def test_native_annotation_seed_uses_zero_damage_coordinates() -> None:
    seed = xbd.row_to_seed(
        {
            "disaster": "earthquake",
            "damage_grade": 3,
            "raw_text": "building assessed",
            "lat": 0.0,
            "lon": 0.0,
        }
    )

    assert seed is not None
    assert (seed["lat"], seed["lon"]) == (0.0, 0.0)


def test_offline_fallback_does_not_disclose_ground_truth_in_text() -> None:
    records = xbd._fallback_records()

    for record in records:
        assert record["gt_urgency"] is not None
        assert "destroyed" not in record["text"]
        assert "minor damage" not in record["text"]
