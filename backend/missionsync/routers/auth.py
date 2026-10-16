"""Sign up, sign in, sign out and "who am I". Sessions are server-side; the browser only holds an opaque
random token in an httpOnly cookie that JavaScript cannot read."""
from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request, Response

from ..auth import SESSION_COOKIE, hash_password, needs_rehash, password_problem, verify_password
from ..deps import client_ip, current_user, enforce, get_services
from ..errors import ApiError
from ..repos import EmailTaken, LimitReached, User, normalize_email
from ..schemas import LoginBody, PasswordBody, SignupBody
from ..services import Services, housekeeping

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _start_session(response: Response, svc: Services, request: Request, user: User) -> None:
    token, expires = svc.sessions.create(user.id, request.headers.get("user-agent", ""))
    _set_cookie(response, svc, token, expires)


def _set_cookie(response: Response, svc: Services, token: str, expires: datetime) -> None:
    response.set_cookie(
        SESSION_COOKIE, token, expires=expires, max_age=svc.settings.session_days * 86400,
        httponly=True, secure=svc.settings.secure_cookies, samesite="lax", path="/",
    )


@router.post("/signup", status_code=201)
async def signup(body: SignupBody, request: Request, response: Response, svc: Services = Depends(get_services)) -> dict:
    if not svc.settings.allow_signup:
        raise ApiError(403, "forbidden", "New sign-ups are closed on this server.")
    enforce(svc.signup_limiter, client_ip(request), "Too many sign-up attempts — wait a moment.")
    problem = password_problem(body.password, body.email)
    if problem:
        raise ApiError(400, "validation_error", problem, [{"field": "password", "issue": problem}])
    password_hash = await asyncio.to_thread(hash_password, body.password)
    try:
        user = await asyncio.to_thread(svc.users.create, body.email, body.display_name, password_hash)
    except EmailTaken:
        msg = "An account with this email already exists. Try signing in instead."
        raise ApiError(409, "conflict", msg, [{"field": "email", "issue": msg}]) from None
    await asyncio.to_thread(_start_session, response, svc, request, user)
    return {"user": user.public()}


GUEST_DOMAIN = "guest.missionsync.invalid"          # .invalid can never receive mail or collide with a real address


@router.post("/demo", status_code=201)
async def demo(request: Request, response: Response, svc: Services = Depends(get_services)) -> dict:
    """One click, no form: a temporary guest account that owns one ready-to-open drill (the real xBD scenario with
    the real AI agents). Nobody can sign in to it again — the password is random and never shown — so it lives for
    `guest_hours` (the session lasts as long) and is then deleted with its data."""
    if not svc.settings.allow_demo:
        raise ApiError(403, "forbidden", "The one-click demo is switched off on this server. Please create an account.")
    enforce(svc.demo_limiter, client_ip(request), "Too many demos started from this connection — wait a minute, or create an account.")
    if await asyncio.to_thread(svc.users.count_guests) >= svc.settings.max_guests:
        await housekeeping(svc)                                       # expired guests may be holding the places
        if await asyncio.to_thread(svc.users.count_guests) >= svc.settings.max_guests:
            raise ApiError(503, "degraded", "The demo is busy right now. Please try again in a few minutes, or create a free account.")
    lifetime = timedelta(hours=svc.settings.guest_hours)
    unusable = "!" + secrets.token_hex(16)                            # not a hash of anything: nobody can ever sign in to a guest
    user = await asyncio.to_thread(svc.users.create, f"guest-{secrets.token_hex(6)}@{GUEST_DOMAIN}", "Demo guest", unusable, True)
    try:
        drill = await asyncio.to_thread(
            svc.drills.create, user.id, "Demo Drill",
            f"Real xBD damage scenarios with the AI agents. This temporary account is deleted after {svc.settings.guest_hours} hours.",
            svc.settings.guest_max_drills,
        )
    except Exception:
        await asyncio.to_thread(svc.users.delete_with_data, user.id)   # never leave an empty guest behind
        raise
    token, expires = await asyncio.to_thread(svc.sessions.create, user.id, request.headers.get("user-agent", ""), lifetime)
    response.set_cookie(
        SESSION_COOKIE, token, expires=expires, max_age=int(lifetime.total_seconds()),
        httponly=True, secure=svc.settings.secure_cookies, samesite="lax", path="/",
    )
    try:
        await svc.manager.get(drill.id)                  # start booting it now so it is ready when the page opens
    except Exception:                                    # a busy server must not fail the sign-up; opening the drill retries
        pass
    return {"user": user.public(), "drill": drill.public(), "expires_in_hours": svc.settings.guest_hours}


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response, svc: Services = Depends(get_services)) -> dict:
    email = normalize_email(body.email)
    ip = client_ip(request)
    enforce(svc.login_limiter, ip, "Too many sign-in attempts — wait a moment and try again.")
    # Keyed by address AND email: a stranger guessing at your address cannot lock you out from your own connection.
    enforce(svc.login_limiter, f"{ip}|{email}", "Too many sign-in attempts for this account — wait a moment and try again.")
    found = await asyncio.to_thread(svc.users.by_email, email)
    stored = found[1] if found else None
    ok = await asyncio.to_thread(verify_password, stored, body.password)     # always runs a full hash: no timing oracle
    if not ok or found is None:
        msg = "That email and password do not match."
        raise ApiError(401, "unauthorized", msg, [{"field": "password", "issue": msg}])
    user = found[0]
    if stored and needs_rehash(stored):
        await asyncio.to_thread(svc.users.set_password_hash, user.id, await asyncio.to_thread(hash_password, body.password))
    await asyncio.to_thread(_start_session, response, svc, request, user)
    return {"user": user.public()}


@router.post("/logout", status_code=204)
async def logout(request: Request, svc: Services = Depends(get_services)) -> Response:
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        await asyncio.to_thread(svc.sessions.revoke, token)
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=svc.settings.secure_cookies, samesite="lax")
    return response


@router.post("/logout-all", status_code=204)
async def logout_all(user: User = Depends(current_user), svc: Services = Depends(get_services)) -> Response:
    """Sign this account out on every device (the live sockets close within seconds)."""
    await asyncio.to_thread(svc.sessions.revoke_all, user.id)
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=svc.settings.secure_cookies, samesite="lax")
    return response


@router.delete("/me", status_code=204)
async def delete_account(body: PasswordBody, request: Request, user: User = Depends(current_user), svc: Services = Depends(get_services)) -> Response:
    """Delete the account and everything it owns. Needs the password again, so a stolen session cannot do it."""
    enforce(svc.login_limiter, f"{client_ip(request)}|{user.email}", "Too many attempts — wait a moment and try again.")
    found = await asyncio.to_thread(svc.users.by_email, user.email)
    if found is None or not await asyncio.to_thread(verify_password, found[1], body.password):
        msg = "That password is not right."
        raise ApiError(401, "unauthorized", msg, [{"field": "password", "issue": msg}])
    for drill_id in await asyncio.to_thread(svc.users.drill_ids, user.id):
        await svc.manager.unload(drill_id, save=False)
    await asyncio.to_thread(svc.users.delete_with_data, user.id)
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=svc.settings.secure_cookies, samesite="lax")
    return response


@router.get("/me")
async def me(user: User = Depends(current_user)) -> dict:
    return {"user": user.public()}


@router.get("/session")
async def session(request: Request, svc: Services = Depends(get_services)) -> dict:
    """Like /me, but a visitor is a normal answer ({"user": null}), not an error — so the page can ask on load
    without a failed request showing up in the browser console."""
    token = request.cookies.get(SESSION_COOKIE, "")
    user = await asyncio.to_thread(svc.sessions.resolve, token) if token else None
    return {"user": user.public() if user else None}
