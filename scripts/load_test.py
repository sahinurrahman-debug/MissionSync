#!/usr/bin/env python
"""Load-test a running MissionSync API: N dashboards on the WebSocket plus a stream of reports.

    python scripts/load_test.py [--url http://127.0.0.1:8000] [--clients 50] [--reports 20]

Reports: intake latency (POST /api/report → answer) and push latency (POST -> the next WebSocket
frame that contains the new incident), p50/p95/max, plus dropped sockets and snapshot size.
Point it at a local server; it spends LLM quota only if the server has a key (use the rule-based
mode for a pure-infrastructure number: start the server without GROQ_API_KEY).
"""
from __future__ import annotations

import argparse
import sys
import asyncio
import json
import statistics
import time
import uuid

import httpx
import websockets

REPORTS = [
    "Smoke and flames visible from the third floor of a warehouse on the Industrial Park, workers evacuating.",
    "Water is rising quickly along Riverfront, two cars stuck and people on a roof.",
    "Person collapsed with chest pain at the Downtown transit hub, bystander doing CPR.",
    "Gas smell reported near the North Hills school, children being moved outside.",
    "Brush fire spreading up the hillside in North Hills toward three homes.",
]


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")


def line(name: str, xs: list[float]) -> str:
    if not xs:
        return f"{name:<28} no samples"
    return f"{name:<28} p50 {statistics.median(xs):7.0f} ms   p95 {pct(xs, .95):7.0f} ms   max {max(xs):7.0f} ms   (n={len(xs)})"


async def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--clients", type=int, default=50)
    ap.add_argument("--reports", type=int, default=20)
    ap.add_argument("--gap", type=float, default=2.2, help="seconds between reports (the limiter allows ~1 per 2 s)")
    a = ap.parse_args()
    ws_url = a.url.replace("http", "ws", 1) + "/ws"

    frames = [0] * a.clients
    bytes_seen = [0] * a.clients
    dropped = 0
    waiters: dict[str, tuple[float, asyncio.Event, list[float]]] = {}
    stop = asyncio.Event()

    async def client(i: int) -> None:
        nonlocal dropped
        try:
            async with websockets.connect(ws_url, max_size=None, open_timeout=15) as ws:
                while not stop.is_set():
                    raw = await asyncio.wait_for(ws.recv(), timeout=60)
                    frames[i] += 1
                    bytes_seen[i] += len(raw)
                    if i != 0 or not waiters:
                        continue
                    try:
                        titles = {x.get("title", "") + x.get("description", "") for x in json.loads(raw).get("data", {}).get("incidents", [])}
                    except Exception:
                        continue
                    for key, (t0, ev, out) in list(waiters.items()):
                        if not ev.is_set() and any(key in t for t in titles):
                            out.append((time.perf_counter() - t0) * 1000)
                            ev.set()
        except Exception:
            dropped += 1

    tasks = [asyncio.create_task(client(i)) for i in range(a.clients)]
    await asyncio.sleep(3)
    connected = a.clients - dropped
    print(f"connected {connected}/{a.clients} sockets")

    intake: list[float] = []
    push: list[float] = []
    failures = 0
    async with httpx.AsyncClient(timeout=120) as http:
        for n in range(a.reports):
            marker = uuid.uuid4().hex[:8]
            text = f"{REPORTS[n % len(REPORTS)]} Ref {marker}."
            ev = asyncio.Event()
            waiters[marker] = (time.perf_counter(), ev, push)
            t0 = time.perf_counter()
            try:
                r = await http.post(a.url + "/api/report", json={"text": text, "source": "radio", "client_nonce": uuid.uuid4().hex})
                if r.status_code == 429:
                    await asyncio.sleep(float(r.headers.get("Retry-After", 2)))
                    continue
                r.raise_for_status()
                intake.append((time.perf_counter() - t0) * 1000)
                try:
                    await asyncio.wait_for(ev.wait(), timeout=10)
                except asyncio.TimeoutError:
                    pass                                              # merged into an existing incident: no new marker
            except Exception as e:
                failures += 1
                print("  report failed:", e)
            await asyncio.sleep(a.gap)

    stop.set()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    live = [i for i in range(a.clients) if frames[i]]
    print(line("report -> HTTP answer", intake))
    print(line("report -> WS push (client 0)", push))
    print(f"report failures              {failures}")
    print(f"sockets that dropped         {dropped}")
    if live:
        print(f"frames per client            {statistics.mean(frames[i] for i in live):.1f} avg;  avg snapshot {statistics.mean(bytes_seen[i] / frames[i] for i in live) / 1024:.1f} KiB")
    h = httpx.get(a.url + "/api/health", timeout=10).json()
    print(f"health: viewers {h.get('viewers')}  peak {h.get('peak_viewers')}  mode {h.get('mode')}")


if __name__ == "__main__":
    asyncio.run(main())
