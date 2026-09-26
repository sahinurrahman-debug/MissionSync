import asyncio
import json

from missionsync import agents


def test_surveillance_does_not_send_hidden_dataset_metadata(monkeypatch) -> None:
    received = {}

    async def fake_llm_json(system, user, **kwargs):
        received.update(json.loads(user))
        return {"incidents": []}, 0

    monkeypatch.setattr(agents, "llm_json", fake_llm_json)
    asyncio.run(
        agents.run_surveillance(
            [
                {
                    "source": "drone",
                    "lat": 34.0,
                    "lon": -118.0,
                    "raw_text": "Damaged building reported",
                    "confidence": 0.8,
                    "_ground_truth_urgency": 90,
                    "_damage_grade": 3,
                    "_type_hint": "structural_collapse",
                    "_dataset_lat": 40.0,
                    "_dataset_lon": -70.0,
                }
            ],
            [],
        )
    )

    assert received["signals"] == [
        {
            "source": "drone",
            "lat": 34.0,
            "lon": -118.0,
            "raw_text": "Damaged building reported",
            "confidence": 0.8,
        }
    ]
