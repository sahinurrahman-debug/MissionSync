"""The live WebSocket of one drill. Authenticated with the same session cookie as the REST API; the handshake
is refused for foreign browser origins (cross-site WebSocket hijacking) and for drills the caller does not own."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import SESSION_COOKIE
from ..orchestrator import DomainError

router = APIRouter()

_extra_origins = {o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()}


def origin_allowed(ws: WebSocket) -> bool:
    """Browsers always send Origin on a WebSocket handshake; non-browser clients send none and are allowed
    (they still need a valid session cookie)."""
    origin = ws.headers.get("origin")
    if not origin or origin in _extra_origins:
        return True
    return urlparse(origin).netloc == ws.headers.get("host", "")


async def _refuse(ws: WebSocket, code: int) -> None:
    """Accept then close, so the browser actually receives our close code (4401 = sign in, 4404 = not yours, 4403 = bad origin)."""
    with contextlib.suppress(Exception):
        await ws.accept()
        await ws.close(code=code)


@router.websocket("/ws/drills/{drill_id}")
async def drill_socket(ws: WebSocket, drill_id: int) -> None:
    svc = ws.app.state.services
    if not origin_allowed(ws):
        return await _refuse(ws, 4403)
    token = ws.cookies.get(SESSION_COOKIE, "")
    user = await asyncio.to_thread(svc.sessions.resolve, token) if token else None
    if user is None:
        return await _refuse(ws, 4401)
    if await asyncio.to_thread(svc.drills.get, user.id, drill_id) is None:
        return await _refuse(ws, 4404)
    try:
        rt = await svc.manager.get(drill_id)
    except DomainError:
        return await _refuse(ws, 1013)
    if not await rt.hub.join(ws):
        return
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            rt.touch()
            if message.get("text") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        rt.hub.leave(ws)
