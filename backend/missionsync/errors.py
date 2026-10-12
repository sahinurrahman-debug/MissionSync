"""One error shape for the whole API:  {"error": "A human sentence.", "code": "not_found", "details": [...], "request_id": "req_ab12"}

`error` is always a plain string (safe to show to the user); stack traces and internals only ever reach the log.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .orchestrator import DomainError

logger = logging.getLogger("missionsync")

_CODES = {400: "validation_error", 401: "unauthorized", 403: "forbidden", 404: "not_found",
          405: "method_not_allowed", 409: "conflict", 413: "too_large", 429: "rate_limited", 503: "degraded"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list | None = None, headers: dict | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details = details or []
        self.headers = headers or {}


def request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "req_unknown")


def error_response(request: Request, status: int, code: str, message: str, details: list | None = None,
                   headers: dict | None = None) -> JSONResponse:
    body = {"error": message, "code": code, "details": details or [], "request_id": request_id(request)}
    return JSONResponse(status_code=status, content=body, headers={"X-Request-ID": request_id(request), **(headers or {})})


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def on_api_error(request: Request, exc: ApiError):
        return error_response(request, exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(DomainError)
    async def on_domain_error(request: Request, exc: DomainError):
        return error_response(request, exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in e["loc"] if p not in ("body", "query", "path")), "issue": e["msg"].removeprefix("Value error, ")} for e in exc.errors()]
        fields = ", ".join(d["field"] for d in details if d["field"]) or "request"
        return error_response(request, 400, "validation_error", f"Invalid {fields}.", details)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(request: Request, exc: StarletteHTTPException):
        code = _CODES.get(exc.status_code, "internal_error" if exc.status_code >= 500 else "error")
        return error_response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def on_unhandled(request: Request, exc: Exception):
        logger.exception("unhandled error")                                    # the trace goes to the log, never the client
        return error_response(request, 500, "internal_error", "Something went wrong on the server.")
