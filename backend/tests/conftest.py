"""Shared fixtures. Tests never touch the network: Groq is disabled and Kaggle is
stubbed unless a test installs a fake client on purpose."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from missionsync import agents, llm, xbd  # noqa: E402

_REAL_LOAD_XBD_RECORDS = xbd.load_xbd_records


@pytest.fixture
def real_load_xbd_records():
    """The genuine Kaggle loader (the autouse fixture stubs it out for other tests)."""
    return _REAL_LOAD_XBD_RECORDS


@pytest.fixture(autouse=True)
def isolated_world(monkeypatch):
    monkeypatch.setattr(llm, "_client", None)                     # no live LLM
    monkeypatch.setattr(llm, "_agent_runs", llm._fresh_agent_runs())
    monkeypatch.setattr(llm, "_exhausted_until", {})
    monkeypatch.setattr(llm, "_tokens_used", {})
    monkeypatch.setattr(llm, "latency_log", llm.deque(maxlen=300))
    monkeypatch.setattr(xbd, "load_xbd_records", lambda *a, **k: [])   # no Kaggle
    monkeypatch.setattr(xbd, "_CACHE", None)
    agents.clear_caches()
    yield
    agents.clear_caches()
