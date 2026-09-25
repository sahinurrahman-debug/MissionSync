"""Central Groq LLM client wrapper.

All agents talk to Groq through this module. Features:
- Async client for concurrent agent execution
- JSON mode with one automatic repair retry
- Latency tracking per call (feeds the response-latency metric)
- LLM_AVAILABILITY flag so the system degrades gracefully if the key is
  missing or Groq is down mid-demo (rule-based fallback keeps the dashboard
  alive instead of failing in front of judges)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Optional

from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("GROQ_API_KEY", "").strip()

# Fastest reliable JSON-mode models on Groq (free tier)
PRIMARY_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
FALLBACK_MODEL = "llama-3.3-70b-versatile"

LLM_AVAILABILITY = bool(API_KEY)

_client: Any = None
if API_KEY:
    try:
        from groq import AsyncGroq

        _client = AsyncGroq(api_key=API_KEY)
    except Exception as exc:  # pragma: no cover
        print(f"[llm] Groq SDK unavailable, agents will use fallbacks: {exc}")
        _client = None
        LLM_AVAILABILITY = False
else:
    print("[llm] GROQ_API_KEY not set — agents running in rule-based fallback mode")

latency_log: list[dict[str, Any]] = []


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
                return None, latency_ms
            await asyncio.sleep(0.4)
    return None, int((time.perf_counter() - started) * 1000)


def llm_stats() -> dict[str, Any]:
    """Aggregate LLM latency stats for the metrics panel."""
    if not latency_log:
        return {"calls": 0, "avg_latency_ms": 0, "success_rate": 1.0}
    ok_calls = [entry for entry in latency_log if entry["ok"]]
    return {
        "calls": len(latency_log),
        "avg_latency_ms": int(sum(entry["latency_ms"] for entry in latency_log) / len(latency_log)),
        "success_rate": round(len(ok_calls) / len(latency_log), 3),
        "mode": "llm" if LLM_AVAILABILITY else "fallback",
    }
