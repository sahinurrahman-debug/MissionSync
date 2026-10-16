"""Running a drill: report intake and the human-commit actions. All of them act on one of YOUR drills."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..deps import current_user, enforce, get_services, running_drill
from ..hub import snapshot_json
from ..manager import DrillRuntime
from ..models import IncomingReport, WorldSnapshot
from ..repos import User
from ..schemas import ApproveBody, IncidentPatch, ManualDispatchBody, RejectBody, SettingsBody
from ..services import Services

router = APIRouter(prefix="/api/drills/{drill_id}", tags=["drill"])


def _ok(snap: WorldSnapshot, **extra) -> dict:
    return {"status": "ok", **extra, "snapshot": snapshot_json(snap)}


def _who(rt: DrillRuntime) -> str:
    return f"drill:{rt.drill_id}"


@router.get("/snapshot")
async def snapshot(rt: DrillRuntime = Depends(running_drill)) -> dict:
    return snapshot_json(rt.orch.snapshot())


@router.post("/report")
async def inject_report(report: IncomingReport, rt: DrillRuntime = Depends(running_drill), user: User = Depends(current_user), svc: Services = Depends(get_services)) -> dict:
    """Accepts free text and answers fast: recognised reports are ranked immediately (rules) and
    refined by the LLM in the background (watch the WebSocket)."""
    enforce(svc.user_report_limiter, f"user:{user.id}", "Too many reports — slow down a little.")
    enforce(svc.report_limiter, _who(rt), "Too many reports — slow down a little.")
    outcome, snap = await rt.orch.inject_report(report)
    return {
        "status": "processed",
        "outcome": outcome.model_dump(mode="json"),
        "injections": rt.orch._injection_count,
        "snapshot": snapshot_json(snap),
    }


@router.post("/dispatch/approve")
async def dispatch_approve(body: ApproveBody | None = None, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.approve(body.proposal_ids if body else None))


@router.post("/dispatch/reject")
async def dispatch_reject(body: RejectBody, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.reject(body.proposal_id))


@router.post("/dispatch/manual")
async def dispatch_manual(body: ManualDispatchBody, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.manual_dispatch(body.incident_id, body.resource_id, body.role))


@router.post("/units/{unit_id}/recall")
async def unit_recall(unit_id: str, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.recall(unit_id))


@router.patch("/incidents/{incident_id}")
async def incident_patch(incident_id: str, body: IncidentPatch, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.set_incident_status(incident_id, body.status))


@router.post("/reset")
async def reset(rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.report_limiter, _who(rt))
    return {"status": "reset", "snapshot": snapshot_json(await rt.orch.reset())}


@router.post("/end")
async def end(rt: DrillRuntime = Depends(running_drill)) -> dict:
    return _ok(await rt.orch.end_drill())


@router.post("/settings")
async def settings(body: SettingsBody, rt: DrillRuntime = Depends(running_drill), svc: Services = Depends(get_services)) -> dict:
    enforce(svc.ops_limiter, _who(rt))
    return _ok(await rt.orch.set_auto_dispatch(body.auto_dispatch))
