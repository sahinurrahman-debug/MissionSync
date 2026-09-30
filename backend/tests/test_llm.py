import asyncio
from types import SimpleNamespace

from missionsync import llm

from .fakes import FakeGroq


def _completion(content: str, finish: str = "stop"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish)],
        usage=SimpleNamespace(total_tokens=42),
    )


def _client(create):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


class RateLimitError(Exception):
    status_code = 429


def test_each_agent_uses_groq_json_mode_and_is_tracked(monkeypatch) -> None:
    requested = []

    async def create(**kwargs):
        requested.append(kwargs)
        return _completion('{"ok": true}')

    monkeypatch.setattr(llm, "_client", _client(create))

    async def run_agents():
        for name in ("surveillance", "terrain", "risk", "logistics", "command"):
            result, _ = await llm.llm_json("system", "{}", agent=name)
            assert result == {"ok": True}

    asyncio.run(run_agents())
    stats = llm.llm_stats()

    assert len(requested) == 5
    assert all(r["response_format"] == {"type": "json_object"} for r in requested)
    assert stats["mode"] == "llm"
    assert all(a["last_mode"] == "llm" for a in stats["agents"].values())
    assert stats["quota"]["tokens_used"][llm.PRIMARY_MODEL] == 5 * 42


def test_no_client_means_fallback_mode() -> None:
    result, latency = asyncio.run(llm.llm_json("s", "{}", agent="risk"))
    assert result is None and latency == 0
    assert llm.llm_stats()["mode"] == "fallback"


def test_parse_retry_after() -> None:
    assert llm.parse_retry_after("Please try again in 1m7.39s. Need more tokens?") == 67.39
    assert llm.parse_retry_after("try again in 2m28.608s") == 148.608
    assert llm.parse_retry_after("Please try again in 43.5s") == 43.5
    assert llm.parse_retry_after("try again in 250ms") == 0.25
    assert llm.parse_retry_after("no hint here") is None


def test_classify_error_distinguishes_daily_from_minute_limits() -> None:
    daily = RateLimitError("Rate limit ... on tokens per day (TPD): Limit 200000. Please try again in 1m7s")
    minute = RateLimitError("Rate limit ... on tokens per minute (TPM). Please try again in 3.2s")
    assert llm.classify_error(daily) == ("daily", 67.0)
    assert llm.classify_error(minute) == ("minute", 3.2)
    assert llm.classify_error(RuntimeError("boom"))[0] == "other"


def test_daily_quota_rotates_to_the_next_model_then_reports_exhaustion(monkeypatch) -> None:
    seen = []

    async def create(**kwargs):
        seen.append(kwargs["model"])
        if kwargs["model"] == llm.PRIMARY_MODEL:
            raise RateLimitError("on tokens per day (TPD) ... try again in 5m0s")
        return _completion('{"ok": 1}')

    monkeypatch.setattr(llm, "_client", _client(create))
    result, _ = asyncio.run(llm.llm_json("s", "{}", agent="risk"))
    assert result == {"ok": 1}
    assert seen == [llm.PRIMARY_MODEL, llm.FALLBACK_MODEL]
    assert llm.PRIMARY_MODEL in llm.llm_stats()["quota"]["exhausted_models"]

    # Once the primary is known to be exhausted it is not asked again.
    seen.clear()
    asyncio.run(llm.llm_json("s", "{}", agent="risk"))
    assert seen == [llm.FALLBACK_MODEL]

    # Every model spent: no requests at all, and the mode says why.
    async def always_daily(**kwargs):
        raise RateLimitError("on tokens per day (TPD) ... try again in 9m0s")

    monkeypatch.setattr(llm, "_client", _client(always_daily))
    llm._exhausted_until.clear()
    asyncio.run(llm.llm_json("s", "{}", agent="risk"))
    result, _ = asyncio.run(llm.llm_json("s", "{}", agent="risk"))
    assert result is None
    assert llm.llm_stats()["mode"] == "quota_exhausted"
    assert llm.active_model() is None


def test_truncated_or_malformed_json_is_retried_with_more_room(monkeypatch) -> None:
    calls = []

    async def create(**kwargs):
        calls.append(kwargs["max_tokens"])
        if len(calls) == 1:
            return _completion('{"a": ', finish="length")
        return _completion('{"a": 1}')

    monkeypatch.setattr(llm, "_client", _client(create))
    result, _ = asyncio.run(llm.llm_json("s", "{}", agent="terrain", max_tokens=100))
    assert result == {"a": 1}
    assert calls[1] > calls[0]


def test_extract_json_only_returns_objects() -> None:
    assert llm._extract_json('```json\n{"x": 1}\n```') == {"x": 1}
    assert llm._extract_json('noise {"x": 2} tail') == {"x": 2}
    assert llm._extract_json("[1, 2, 3]") is None
    assert llm._extract_json("") is None


def test_latency_log_is_bounded() -> None:
    for i in range(1000):
        llm.latency_log.append({"latency_ms": i, "ok": True})
    assert len(llm.latency_log) == 300


def test_fake_groq_is_used_end_to_end(monkeypatch) -> None:
    fake = FakeGroq()
    monkeypatch.setattr(llm, "_client", fake)
    result, _ = asyncio.run(llm.llm_json("You are the Risk-Scoring Agent", "{}", agent="risk"))
    assert result["severity"] == 80
