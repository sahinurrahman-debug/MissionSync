"""Create, read, update and delete your own drills, plus the after-action review of each. Every route is
scoped to the signed-in user: a drill that is not yours answers 404, whatever the id."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Response

from ..deps import current_user, enforce, get_services, owned_drill
from ..errors import ApiError
from ..repos import DrillRecord, LimitReached, User
from ..schemas import DrillCreate, DrillPatch
from ..services import Services

router = APIRouter(prefix="/api/drills", tags=["drills"])


@router.get("")
async def list_drills(user: User = Depends(current_user), svc: Services = Depends(get_services)) -> dict:
    rows = await asyncio.to_thread(svc.drills.list, user.id)
    return {"drills": [d.public() for d in rows], "limit": svc.settings.max_drills_per_user}


@router.post("", status_code=201)
async def create_drill(body: DrillCreate, user: User = Depends(current_user), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, f"user:{user.id}")
    try:
        drill = await asyncio.to_thread(svc.drills.create, user.id, body.name, body.notes)
    except LimitReached:
        msg = f"You can keep up to {svc.settings.max_drills_per_user} drills. Delete one to make room."
        raise ApiError(409, "conflict", msg) from None
    return {"drill": drill.public()}


@router.get("/{drill_id}")
async def read_drill(drill: DrillRecord = Depends(owned_drill)) -> dict:
    return {"drill": drill.public()}


@router.patch("/{drill_id}")
async def update_drill(
    body: DrillPatch, drill: DrillRecord = Depends(owned_drill), user: User = Depends(current_user), svc: Services = Depends(get_services),
) -> dict:
    enforce(svc.ops_limiter, f"user:{user.id}")
    if body.name is None and body.notes is None:
        raise ApiError(400, "validation_error", "Send a new name or notes to update.")
    updated = await asyncio.to_thread(svc.drills.update, user.id, drill.id, body.name, body.notes)
    if updated is None:                                                   # deleted between the check and the write
        raise ApiError(404, "not_found", "That drill does not exist.")
    return {"drill": updated.public()}


@router.delete("/{drill_id}", status_code=204)
async def delete_drill(
    drill: DrillRecord = Depends(owned_drill), user: User = Depends(current_user), svc: Services = Depends(get_services),
) -> Response:
    enforce(svc.ops_limiter, f"user:{user.id}")
    await svc.manager.unload(drill.id, save=False)                        # stop its simulation before its rows disappear
    await asyncio.to_thread(svc.drills.delete, user.id, drill.id)
    return Response(status_code=204)


@router.get("/{drill_id}/audit")
async def drill_audit(drill: DrillRecord = Depends(owned_drill), svc: Services = Depends(get_services)) -> dict:
    events = await asyncio.to_thread(svc.drills.events, drill.id)
    reports = await asyncio.to_thread(svc.drills.reports, drill.id)
    return {"drill_id": drill.id, "events": events, "reports": reports}


@router.get("/{drill_id}/export.csv")
async def drill_export(drill: DrillRecord = Depends(owned_drill), svc: Services = Depends(get_services)) -> Response:
    rt = svc.manager.peek(drill.id)
    if rt is not None:
        await rt.orch._persist()                                          # include the latest lines of a running drill
    body = await asyncio.to_thread(svc.drills.export_csv, drill.id)
    return Response(
        content=body, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="missionsync-drill-{drill.id}.csv"'},
    )
