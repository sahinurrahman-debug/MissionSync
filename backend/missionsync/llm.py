"""Central Groq LLM client wrapper.

All agents talk to Groq through this module. Features:
- Async client for concurrent agent execution (bounded concurrency)
- JSON mode with automatic repair retry
- Quota awareness: Groq's free tier caps tokens per day *per model*. When a
  model's daily budget is spent we mark it exhausted, rotate to the next model,
  and surface the state in ``llm_stats()`` so the dashboard can say so plainly
  instead of silently degrading. Per-minute limits are waited out briefly.
- Latency + token tracking per call (feeds the response-latency metric)
- Per-agent call status so the system degrades gracefully if the key is
  missing or every model is out of quota (rule-based twins keep the board alive)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

API_KEY = os.getenv("GROQ_API_KEY", "").strip()

# Groq retired the previous Llama models; these GPT-OSS models support JSON mode.
PRIMARY_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
FALLBACK_MODEL = os.getenv("GROQ_FALLBACK_MODEL", "openai/gpt-oss-120b")
MODELS: list[str] = [PRIMARY_MODEL] + ([FALLBACK_MODEL] if FALLBACK_MODEL != PRIMARY_MODEL else [])

REQUEST_TIMEOUT_S = 20.0
MAX_CONCURRENCY = 2
MAX_MINUTE_WAIT_S = 12.0   # longer waits are treated as "unavailable for now"

_client: Any = None
if API_KEY:
    try:
        from groq import AsyncGroq

        _client = AsyncGroq(api_key=API_KEY, max_retries=0)
    except Exception as exc:  # pragma: no cover
        logger.warning("Groq SDK unavailable, agents will use fallbacks: %s", exc)
        _client = None
else:
    logger.warning("GROQ_API_KEY not set — agents running in rule-based fallback mode")

latency_log: deque[dict[str, Any]] = deque(maxlen=300)
_REQUIRED_AGENTS = ("surveillance", "terrain", "risk", "logistics", "command")


def _fresh_agent_runs() -> dict[str, dict[str, Any]]:
    return {
        name: {"calls": 0, "llm_successes": 0, "fallbacks": 0, "last_mode": "not_run"}
        for name in _REQUIRED_AGENTS
    }


_agent_runs: dict[str, dict[str, Any]] = _fresh_agent_runs()
_exhausted_until: dict[str, float] = {}     # model -> epoch seconds when its daily quota returns
_tokens_used: dict[str, int] = {}           # model -> tokens consumed this process
_reasoning_supported = True                  # flips off if the API rejects reasoning_effort
_semaphore: Optional[asyncio.Semaphore] = None


def _sem() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    return _semaphore


def _record_agent_call(agent: str, succeeded: bool) -> None:
    run = _agent_runs.setdefault(
        agent, {"calls": 0, "llm_successes": 0, "fallbacks": 0, "last_mode": "not_run"}
    )
    run["calls"] += 1
    run["llm_successes" if succeeded else "fallbacks"] += 1
    run["last_mode"] = "llm" if succeeded else "fallback"


def _extract_json(text: str) -> Optional[dict[str, Any]]:
    """Parse a JSON *object* out of a model response, tolerating fences and prose."""
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
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


# --------------------------------------------------------------------------
# Rate-limit handling
# --------------------------------------------------------------------------

_RETRY_RE = re.compile(
    r"try again in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?\s*(?:([\d.]+)ms)?", re.I
)


def parse_retry_after(message: str) -> Optional[float]:
    """'Please try again in 1m7.39s' -> 67.39 (seconds). None when absent."""
    m = _RETRY_RE.search(message or "")
    if not m or not any(m.groups()):
        return None
    h, mins, secs, ms = m.groups()
    return (int(h or 0) * 3600) + (int(mins or 0) * 60) + float(secs or 0) + float(ms or 0) / 1000.0


def classify_error(exc: Exception) -> tuple[str, float]:
    """Returns (kind, wait_seconds). kind: daily | minute | bad_request | other."""
    status = getattr(exc, "status_code", None)
    message = str(exc)
    if status == 429 or type(exc).__name__ == "RateLimitError":
        wait = parse_retry_after(message)
        if wait is None:
            headers = getattr(getattr(exc, "response", None), "headers", None)
            try:
                wait = float(headers.get("retry-after")) if headers else None
            except (TypeError, ValueError):
                wait = None
        low = message.lower()
        if "per day" in low or "(tpd)" in low or "(rpd)" in low:
            return "daily", wait if wait is not None else 3600.0
        return "minute", wait if wait is not None else 5.0
    if status == 400 or type(exc).__name__ == "BadRequestError":
        return "bad_request", 0.0
    return "other", 0.0


def _available_models(now: Optional[float] = None) -> list[str]:
    now = now if now is not None else time.time()
    return [m for m in MODELS if _exhausted_until.get(m, 0.0) <= now]


def _mark_exhausted(model: str, wait_s: float) -> None:
    _exhausted_until[model] = time.time() + max(wait_s, 30.0)


async def llm_json(
    system: str,
    user: str,
    agent: str = "agent",
    temperature: float = 0.2,
    max_tokens: int = 900,
) -> tuple[Optional[dict[str, Any]], int]:
    """Call Groq in JSON mode. Returns (parsed_dict, latency_ms).

    parsed_dict is None if the call could not be completed — callers must
    handle that and fall back to deterministic logic.
    """
    global _reasoning_supported
    if _client is None:
        _record_agent_call(agent, False)
        return None, 0

    started = time.perf_counter()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    failed_models: set[str] = set()
    minute_waited = False

    async with _sem():
        for attempt in range(4):
            candidates = [m for m in _available_models() if m not in failed_models] or [
                m for m in _available_models()
            ]
            if not candidates:
                break  # every model is out of quota
            model = candidates[0]
            params: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            }
            if _reasoning_supported and model.startswith("openai/gpt-oss"):
                params["reasoning_effort"] = "low"
            try:
                response = await asyncio.wait_for(
                    _client.chat.completions.create(**params), timeout=REQUEST_TIMEOUT_S
                )
            except Exception as exc:
                latency_ms = int((time.perf_counter() - started) * 1000)
                kind, wait = classify_error(exc)
                latency_log.append(
                    {"agent": agent, "latency_ms": latency_ms, "attempt": attempt, "ok": False,
                     "model": model, "error": f"{kind}: {str(exc)[:160]}"}
                )
                if kind == "daily":
                    _mark_exhausted(model, wait)
                    continue                      # rotate to the next model immediately
                if kind == "minute" and wait <= MAX_MINUTE_WAIT_S and not minute_waited:
                    minute_waited = True
                    await asyncio.sleep(wait + 0.25)
                    continue
                if kind == "bad_request" and "reasoning" in str(exc).lower() and _reasoning_supported:
                    _reasoning_supported = False  # model/API doesn't take reasoning_effort
                    continue
                failed_models.add(model)
                await asyncio.sleep(0.3)
                continue

            latency_ms = int((time.perf_counter() - started) * 1000)
            choice = response.choices[0]
            content = choice.message.content or ""
            usage = getattr(response, "usage", None)
            if usage is not None:
                _tokens_used[model] = _tokens_used.get(model, 0) + int(getattr(usage, "total_tokens", 0) or 0)
            parsed = _extract_json(content)
            if parsed is not None and getattr(choice, "finish_reason", "stop") != "length":
                latency_log.append(
                    {"agent": agent, "latency_ms": latency_ms, "attempt": attempt, "ok": True, "model": model}
                )
                _record_agent_call(agent, True)
                return parsed, latency_ms

            # Truncated or malformed JSON: ask again with more room / a repair nudge.
            latency_log.append(
                {"agent": agent, "latency_ms": latency_ms, "attempt": attempt, "ok": False,
                 "model": model, "error": "truncated" if getattr(choice, "finish_reason", "") == "length" else "malformed_json"}
            )
            max_tokens = int(max_tokens * 1.6) + 100
            if content:
                messages = messages[:2] + [
                    {"role": "assistant", "content": content[:1500]},
                    {"role": "user", "content": "That was not valid, complete JSON. Return ONLY the corrected JSON object, no prose."},
                ]

    _record_agent_call(agent, False)
    return None, int((time.perf_counter() - started) * 1000)


def active_model() -> Optional[str]:
    models = _available_models()
    return models[0] if models and _client is not None else None


def llm_stats() -> dict[str, Any]:
    """Aggregate LLM latency/quota stats for the metrics panel and /api/health."""
    calls = sum(run["calls"] for run in _agent_runs.values())
    successes = sum(run["llm_successes"] for run in _agent_runs.values())
    now = time.time()
    exhausted = {m: max(0, int(_exhausted_until.get(m, 0.0) - now)) for m in MODELS if _exhausted_until.get(m, 0.0) > now}
    quota_exhausted = _client is not None and len(exhausted) == len(MODELS)
    if _client is None:
        mode = "fallback"
    elif quota_exhausted:
        mode = "quota_exhausted"
    elif any(_agent_runs[name]["last_mode"] == "fallback" for name in _REQUIRED_AGENTS):
        mode = "fallback"
    else:
        mode = "llm"
    log = list(latency_log)
    ok_latencies = [e["latency_ms"] for e in log if e.get("ok")]
    return {
        "calls": calls,
        "avg_latency_ms": int(sum(ok_latencies) / len(ok_latencies)) if ok_latencies else 0,
        "success_rate": round(successes / calls, 3) if calls else 1.0,
        "mode": mode,
        "model": active_model(),
        "configured": _client is not None,
        "quota": {"exhausted_models": exhausted, "tokens_used": dict(_tokens_used)},
        "agents": {name: dict(run) for name, run in _agent_runs.items()},
    }
