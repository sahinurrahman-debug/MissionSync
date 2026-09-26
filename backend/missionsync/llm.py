"""Central Groq LLM client wrapper.

All agents talk to Groq through this module. Features:
- Async client for concurrent agent execution
- JSON mode with one automatic repair retry
- Latency tracking per call (feeds the response-latency metric)
- Per-agent call status so the system degrades gracefully if the key is
  missing or Groq is down mid-demo (rule-based fallback keeps the dashboard
  alive instead of failing in front of judges)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

API_KEY = os.getenv("GROQ_API_KEY", "").strip()

# Groq retired the previous Llama models; these GPT-OSS models support JSON mode.
PRIMARY_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
FALLBACK_MODEL = "openai/gpt-oss-120b"

_client: Any = None
if API_KEY:
    try:
        from groq import AsyncGroq

        _client = AsyncGroq(api_key=API_KEY)
    except Exception as exc:  # pragma: no cover
        print(f"[llm] Groq SDK unavailable, agents will use fallbacks: {exc}")
        _client = None
else:
    print("[llm] GROQ_API_KEY not set — agents running in rule-based fallback mode")

latency_log: list[dict[str, Any]] = []
_REQUIRED_AGENTS = ("surveillance", "terrain", "risk", "logistics", "command")
_agent_runs: dict[str, dict[str, Any]] = {
    name: {"calls": 0, "llm_successes": 0, "fallbacks": 0, "last_mode": "not_run"}
    for name in _REQUIRED_AGENTS
}


def _record_agent_call(agent: str, succeeded: bool) -> None:
    run = _agent_runs.setdefault(
        agent, {"calls": 0, "llm_successes": 0, "fallbacks": 0, "last_mode": "not_run"}
    )
    run["calls"] += 1
    run["llm_successes" if succeeded else "fallbacks"] += 1
    run["last_mode"] = "llm" if succeeded else "fallback"


def _extract_json(text: str) -> Optional[dict[str, Any]]:
    """Parse JSON out of a model response, tolerating code fences and prose."""
    if not text:
        return None
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fenced:
        cleaned = fenced.group(1)
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end > start:
            cleaned = cleaned[start : end + 1]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


async def llm_json(
    system: str,
    user: str,
    agent: str = "agent",
    temperature: float = 0.2,
    max_tokens: int = 900,
) -> tuple[Optional[dict[str, Any]], int]:
    """Call Groq in JSON mode. Returns (parsed_dict, latency_ms).

    parsed_dict is None if the call failed after retries — callers must
    handle that and fall back to deterministic logic.
    """
    if _client is None:
        _record_agent_call(agent, False)
        return None, 0

    started = time.perf_counter()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    for attempt in range(2):
        try:
            response = await asyncio.wait_for(
                _client.chat.completions.create(
                    model=PRIMARY_MODEL if attempt == 0 else FALLBACK_MODEL,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                ),
                timeout=25.0,
            )
            content = response.choices[0].message.content or ""
            latency_ms = int((time.perf_counter() - started) * 1000)
            parsed = _extract_json(content)
            if parsed is not None:
                latency_log.append(
                    {"agent": agent, "latency_ms": latency_ms, "attempt": attempt, "ok": True}
                )
                _record_agent_call(agent, True)
                return parsed, latency_ms
            # Malformed JSON: one repair pass with the stronger model
            messages.append({"role": "assistant", "content": content[:2000]})
            messages.append(
                {
                    "role": "user",
                    "content": "That was not valid JSON. Return ONLY the corrected JSON object, no prose.",
                }
            )
            max_tokens = max_tokens + 200
        except Exception as exc:
            latency_ms = int((time.perf_counter() - started) * 1000)
            latency_log.append(
                {"agent": agent, "latency_ms": latency_ms, "attempt": attempt, "ok": False, "error": str(exc)[:200]}
            )
            if attempt == 1:
                _record_agent_call(agent, False)
                return None, latency_ms
            await asyncio.sleep(0.4)
    _record_agent_call(agent, False)
    return None, int((time.perf_counter() - started) * 1000)


def llm_stats() -> dict[str, Any]:
    """Aggregate LLM latency stats for the metrics panel."""
    calls = sum(run["calls"] for run in _agent_runs.values())
    successes = sum(run["llm_successes"] for run in _agent_runs.values())
    mode = (
        "llm"
        if _client is not None
        and all(_agent_runs[name]["last_mode"] == "llm" for name in _REQUIRED_AGENTS)
        else "fallback"
    )
    return {
        "calls": calls,
        "avg_latency_ms": (
            int(sum(entry["latency_ms"] for entry in latency_log) / len(latency_log))
            if latency_log else 0
        ),
        "success_rate": round(successes / calls, 3) if calls else 1.0,
        "mode": mode,
        "agents": {name: dict(run) for name, run in _agent_runs.items()},
    }
