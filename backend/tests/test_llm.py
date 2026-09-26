import asyncio
from types import SimpleNamespace

from missionsync import llm


def test_each_agent_uses_groq_json_mode_and_is_tracked(monkeypatch) -> None:
    requested = []

    async def create(**kwargs):
        requested.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))]
        )

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))
    )
    monkeypatch.setattr(llm, "_client", fake_client)
    monkeypatch.setattr(llm, "latency_log", [])
    monkeypatch.setattr(
        llm,
        "_agent_runs",
        {
            name: {
                "calls": 0,
                "llm_successes": 0,
                "fallbacks": 0,
                "last_mode": "not_run",
            }
            for name in ("surveillance", "terrain", "risk", "logistics", "command")
        },
    )

    async def run_agents():
        for name in ("surveillance", "terrain", "risk", "logistics", "command"):
            result, _ = await llm.llm_json("system", "{}", agent=name)
            assert result == {"ok": True}

    asyncio.run(run_agents())
    stats = llm.llm_stats()

    assert len(requested) == 5
    assert all(request["response_format"] == {"type": "json_object"} for request in requested)
    assert stats["mode"] == "llm"
    assert all(agent["last_mode"] == "llm" for agent in stats["agents"].values())
