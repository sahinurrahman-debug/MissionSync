"""A fake Groq client that answers every agent with schema-correct JSON, so the
whole pipeline can be exercised in pure LLM mode (no rule-based fallback)."""
import asyncio
import json
from types import SimpleNamespace
from typing import Any, Callable, Optional

from missionsync import agents


def _resp(payload: dict[str, Any], finish: str = "stop") -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)), finish_reason=finish)],
        usage=SimpleNamespace(total_tokens=100),
    )


class FakeGroq:
    """Routes on the system prompt. `hooks` lets a test override one agent's payload."""

    def __init__(self, hooks: Optional[dict[str, Callable[[dict], dict]]] = None, delay: float = 0.0) -> None:
        self.calls: list[dict[str, Any]] = []
        self.hooks = hooks or {}
        self.delay = delay                      # simulated LLM latency per call, seconds
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def count(self, agent: str) -> int:
        marker = {"surveillance": "Surveillance Agent", "terrain": "Terrain Agent", "risk": "Risk-Scoring Agent",
                  "logistics": "Logistics Agent", "command": "Command Recommendation Agent"}[agent]
        return sum(1 for c in self.calls if marker in c["messages"][0]["content"])

    async def _create(self, **kw: Any) -> SimpleNamespace:
        self.calls.append(kw)
        if self.delay:
            await asyncio.sleep(self.delay)
        system = kw["messages"][0]["content"]
        user = kw["messages"][1]["content"]
        for name, marker in (("surveillance", "Surveillance Agent"), ("terrain", "Terrain Agent"),
                             ("risk", "Risk-Scoring Agent"), ("logistics", "Logistics Agent"),
                             ("command", "Command Recommendation Agent")):
            if marker in system:
                data = json.loads(user) if user.lstrip().startswith("{") else {"text": user}
                payload = getattr(self, f"_{name}")(data)
                if name in self.hooks:
                    payload = self.hooks[name](payload)
                return _resp(payload)
        raise AssertionError("unknown agent prompt")

    # -- agents -----------------------------------------------------------

    @staticmethod
    def _surveillance(data: dict) -> dict:
        out = []
        for sig in data["signals"]:
            itype = agents.classify_text(sig["raw_text"])
            if itype is None:
                continue
            out.append({
                "type": itype.value, "title": sig["raw_text"][:60], "description": sig["raw_text"][:120],
                "lat": sig["lat"], "lon": sig["lon"], "zone": sig.get("zone", ""),
                "affected_population": 12, "injuries": 3, "counts_reported": True,
                "confidence": 0.9, "linked_incident_id": None,
            })
        return {"incidents": out}

    @staticmethod
    def _terrain(_data: dict) -> dict:
        return {"access_difficulty": 40, "escalation_risk": 55, "hazards": ["wind"], "notes": "ok"}

    @staticmethod
    def _risk(_data: dict) -> dict:
        return {"severity": 80, "population": 60, "spread": 50, "time_criticality": 70, "rationale": "llm rationale"}

    @staticmethod
    def _logistics(data: dict) -> dict:
        picks = []
        for inc in data["incidents"]:
            for cand in inc["candidates"][: inc["needs"]]:
                picks.append({"incident_id": inc["incident_id"], "resource_id": cand["resource_id"],
                              "role": "llm role", "rationale": "llm pick"})
        return {"assignments": picks}

    @staticmethod
    def _command(data: dict) -> dict:
        return {"recommendations": [
            {"incident_id": i["incident_id"], "headline": f"LLM order for {i['title'][:20]}",
             "actions": ["a1", "a2"], "warnings": []}
            for i in data["incidents"]
        ]}
