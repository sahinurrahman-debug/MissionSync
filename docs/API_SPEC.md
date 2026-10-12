# API Spec — MissionSync

*Written at Level 1 (Ronin) as a plan; rewritten at Level 3 (Samurai) to describe the API **as built**. Interactive docs are generated from the code and always current: `/docs` (Swagger UI), `/redoc`, `/openapi.json` on any running server.*

Base URL: the same origin as the dashboard (`http://127.0.0.1:8000` locally). All bodies are JSON.

## Conventions

**Authentication.** Everything except `/api/health`, sign-up and sign-in needs a valid session. The server sets an opaque `ms_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production) when you sign up or in; send it back on every request (browsers do this automatically, `fetch` needs `credentials: 'include'`). Without one → `401`.

**Ownership.** A drill belongs to the account that created it. Every `/api/drills/{id}…` route checks that in SQL; someone else's drill answers `404`, exactly like a missing one.

**Errors.** Every non-2xx response has the same shape — `error` is a plain sentence that is safe to show a user; stack traces never leave the server:

```json
{ "error": "That email and password do not match.", "code": "unauthorized",
  "details": [{ "field": "password", "issue": "That email and password do not match." }], "request_id": "req_9f31ab02" }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error` | Body failed server-side validation; `details[]` has one `{field, issue}` per problem |
| 401 | `unauthorized` | No / expired / revoked session, or wrong sign-in |
| 403 | `forbidden` | Sign-ups closed, or a request from a foreign website (origin guard) |
| 404 | `not_found` | Unknown route, or a drill / unit / incident / proposal that is not yours or does not exist |
| 409 | `conflict` | Email already registered; drill limit reached; the drill has ended; unit busy; stale proposal |
| 429 | `rate_limited` | Too many requests; `Retry-After` header and `details[0].issue` give the wait in seconds |
| 503 | `degraded` | The server is running its maximum number of drills; try again shortly |
| 500 | `internal_error` | Unexpected fault — the sentence is generic, the cause is in the log under `request_id` |

## Accounts

| Method | Route | Auth | Success | Description |
|---|---|---|---|---|
| POST | `/api/auth/signup` | – | `201 {user}` + cookie | `{email, password (8–128), display_name}`. Email is lower-cased and unique (`409`); the password is hashed with argon2id. Signs you in. |
| POST | `/api/auth/login` | – | `200 {user}` + cookie | `{email, password}`. A wrong email and a wrong password give the same `401` sentence. 8 attempts, then ~1 per 6 s, per IP and per email. |
| POST | `/api/auth/logout` | – | `204` | Revokes the session server-side and clears the cookie. |
| GET | `/api/auth/me` | session | `200 {user}` | Who the cookie belongs to. |

## Your drills (CRUD)

| Method | Route | Auth | Success | Description |
|---|---|---|---|---|
| GET | `/api/drills` | session | `200 {drills[], limit}` | Your drills, newest first, with status and report counts. |
| POST | `/api/drills` | session | `201 {drill}` | `{name (1–80), notes? (≤500)}`. At most `MAX_DRILLS_PER_USER` (default 10) → `409`. |
| GET | `/api/drills/{id}` | owner | `200 {drill}` | One drill. |
| PATCH | `/api/drills/{id}` | owner | `200 {drill}` | `{name?, notes?}` — at least one. |
| DELETE | `/api/drills/{id}` | owner | `204` | Stops the drill's simulation and deletes it with its audit trail and reports. |
| GET | `/api/drills/{id}/audit` | owner | `200 {events[], reports[]}` | The drill's stored audit trail and submitted reports. |
| GET | `/api/drills/{id}/export.csv` | owner | `200 text/csv` | After-action export (spreadsheet-formula-safe). |

## Running a drill (all owner-only)

| Method | Route | Description |
|---|---|---|
| GET | `/api/drills/{id}/snapshot` | The whole picture: `status` (`booting`/`live`/`ended`), `incidents`, `resources`, `proposals`, `actions`, `weather`, `metrics`, `event_log`, `pipeline`, `settings`. Opening a drill loads it (restores or boots it). |
| POST | `/api/drills/{id}/report` | `{text (1–2000), source?, lat?, lon?, confidence?, client_nonce? (≤64)}`. Answers fast: a recognised report is ranked at once by rules (`provisional: true`) and the LLM refines it in the background. The same `client_nonce` is processed once. Burst 5, then 1 per 2 s → `429`. |
| POST | `/api/drills/{id}/dispatch/approve` | `{proposal_ids?}` — omit to approve every pending proposal. |
| POST | `/api/drills/{id}/dispatch/reject` | `{proposal_id}` — that unit↔incident pairing is not proposed again. |
| POST | `/api/drills/{id}/dispatch/manual` | `{incident_id, resource_id, role?}` — unit must be available and capable; crew caps apply. |
| POST | `/api/drills/{id}/units/{unit_id}/recall` | Send a responding unit back to base. |
| PATCH | `/api/drills/{id}/incidents/{incident_id}` | `{status: "contained" \| "closed"}`. |
| POST | `/api/drills/{id}/settings` | `{auto_dispatch: bool}` — `false` (default): a human approves every dispatch; `true`: demo auto-commit. |
| POST | `/api/drills/{id}/end` | Freeze the drill for review (`409` once ended). |
| POST | `/api/drills/{id}/reset` | Start the drill over (clears its audit trail). |

Each action answers `200 {status, snapshot}`; a stale or impossible action answers `404`/`409` with a sentence the UI shows verbatim. Actions share a limiter of 30 burst, then 3/s.

## Live updates

`WS /ws/drills/{id}` — sends `{"type":"snapshot","data":…}` after every pipeline stage; answer the text frame `ping` with `{"type":"pong"}`. The handshake is refused unless the browser's origin matches the host (or `CORS_ORIGINS`), and the session must own the drill. The socket is accepted and immediately closed with a code the client acts on:

| Close code | Meaning | Client behaviour |
|---|---|---|
| 4401 | not signed in / session expired | go to sign-in |
| 4403 | request from a foreign site | – |
| 4404 | not your drill, or it was deleted | go to My drills |
| 1013 | server busy | retry with backoff |

A client that stops reading is dropped after 5 s and never delays anyone else.

## System

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | – | `{status, database, mode, model, quota, live_drills, signup_open, uptime_s, version}` — nothing about any account. |
| GET | `/docs`, `/redoc`, `/openapi.json` | – | Generated API documentation. |

## What changed from the Level 1 plan

Planned: Firebase JWTs, orgs with roles, `/api/orgs/…`, `/api/drills/{id}/join`, `/api/me`. Built: own cookie sessions (see [ARCHITECTURE.md §0](./ARCHITECTURE.md) for why), accounts own drills directly, `GET /api/auth/me` instead of `/api/me`, and the route shapes under `/api/drills/{id}/…` follow the plan. Orgs, roles and invites remain Shogun-level work.
