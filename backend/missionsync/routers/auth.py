"""Sign up, sign in, sign out and "who am I". Sessions are server-side; the browser only holds an opaque
random token in an httpOnly cookie that JavaScript cannot read."""
from __future__ import annotations

import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response

from ..auth import SESSION_COOKIE, hash_password, needs_rehash, password_problem, verify_password
from ..deps import client_ip, current_user, enforce, get_services
from ..errors import ApiError
from ..repos import EmailTaken, User, normalize_email
from ..schemas import LoginBody, SignupBody
from ..services import Services

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


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response, svc: Services = Depends(get_services)) -> dict:
    email = normalize_email(body.email)
    enforce(svc.login_limiter, client_ip(request), "Too many sign-in attempts — wait a moment and try again.")
    enforce(svc.login_limiter, f"email:{email}", "Too many sign-in attempts for this account — wait a moment and try again.")
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


@router.get("/me")
async def me(user: User = Depends(current_user)) -> dict:
    return {"user": user.public()}
