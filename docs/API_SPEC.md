# API Spec — MissionSync

*Planned API contract · Journey to Mastery — Level 1 (Ronin)*

Status: **partly implemented.** The backend serves one shared drill (checkpointed to Postgres when a database is attached, and restored after a restart); the org/auth/per-drill-session endpoints in §1 are Samurai scope. The implemented single-drill routes below are the Level 2 surface. The dashboard talks to the backend through the routes marked ✅ (or runs its in-browser demo engine when no backend is reachable).

| Route | State | Notes |
|---|---|---|
| `GET /api/health` | ✅ | Adds `state` (booting/live), LLM `mode` (`llm` / `fallback` / `quota_exhausted`), active `model`, per-model `quota`, `dataset`, `uptime_s`. |
| `GET /api/snapshot` | ✅ | The full `WorldSnapshot`: `status`, `incidents`, `resources`, `weather`, `actions`, `metrics`, structured `event_log` (`{seq,t,msg}`), and `pipeline` (`{stage,origin}`). |
| `POST /api/report` | ✅ | Body `{text (1–2000 chars), source?, lat?, lon?, confidence?, client_nonce? (≤64)}`. Answers fast: recognised reports are ranked immediately by rules and flagged `provisional` while the LLM refines them in the background (the refined score arrives over the WebSocket). Returns `{status, outcome:{kind: created\|merged\|rejected, incident_id, title, tier, urgency, provisional, message}, injections, snapshot}`. A repeated `client_nonce` returns the first result instead of creating a duplicate. Rate-limited (burst 5, then 1 per 2 s per client) → `429` with `Retry-After`. |
| `POST /api/dispatch/approve` | ✅ | Body `{proposal_ids?: string[]}` — omit to approve every pending proposal. Commits the dispatch(es); a stale id → `404`. |
| `POST /api/dispatch/reject` | ✅ | Body `{proposal_id}`. Removes the proposal; that unit↔incident pairing is not proposed again. |
| `POST /api/dispatch/manual` | ✅ | Body `{incident_id, resource_id, role?}`. Net-control override; unit must be available and capable, crew cap respected (`409` otherwise). |
| `POST /api/units/{unit_id}/recall` | ✅ | Sends a unit that is en route / on scene back to base. |
| `PATCH /api/incidents/{incident_id}` | ✅ | Body `{status: "contained" \| "closed"}`; frees the incident's units. |
| `POST /api/reset` | 🔒 | Restarts the drill. Admin key. |
| `POST /api/drill/end` | 🔒 | Ends the drill: snapshot `status` becomes `ended`, all mutating actions answer `409` until a reset. Admin key. |
| `POST /api/settings` | 🔒 | Body `{auto_dispatch: bool}` — `false` (default): agents propose and a human approves; `true`: commit immediately. Admin key. |
| `GET /api/drills`, `GET /api/drills/{id}/audit`, `GET /api/drills/{id}/export.csv` | ✅ | With a database: drill history, per-drill audit trail and the after-action CSV (formula-injection safe). |
| `GET /api/audit` | ✅ | The timestamped event log (last 300 entries). |
| `WS /ws` | ✅ | Pushes a snapshot after every pipeline **stage**; answers the text frame `ping` with `{"type":"pong"}`. Browser origins must be in `CORS_ORIGINS` (else close `4403`); more than `MAX_WS_CLIENTS` connections get close `1013`; a client that stops reading is dropped after 5 s and never delays the others. |
| everything else below | planned | |

🔒 = requires the `X-Admin-Key` header when the server has `ADMIN_KEY` set (`401 unauthorized` otherwise). `GET /api/health` reports `admin_protected` so the dashboard knows whether to ask. The snapshot also carries `proposals` (pending dispatches), `settings.auto_dispatch`, `drill_id`, `elapsed_s` and, in `metrics`, `database`, `viewers`, `peak_viewers`, `provisional_incidents`, `pending_proposals`.

Errors from every implemented route use the standard envelope in §3, including `request_id` (also sent as the `X-Request-ID` header).

---

## 1. Planned endpoints

All routes are prefixed with `/api`. `Auth` shows the minimum role required; roles are per-org (see §2).

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | none | Liveness + mode (`llm` / `fallback`) + version. Used by uptime checks. |
| POST | `/api/auth/session` | none | Exchange a Firebase ID token for a session: verifies token, upserts `User`, returns profile + org memberships. |
| GET | `/api/me` | any authenticated | Current user's profile and org/role list. |
| POST | `/api/orgs` | any authenticated | Create an organization; creator becomes `owner`. |
| POST | `/api/orgs/{org_id}/members` | `admin` | Invite a member by email (sends Firebase invite); assign initial role. |
| GET | `/api/orgs/{org_id}/drills` | `viewer` | List drill sessions for the org (past + scheduled + live). |
| POST | `/api/orgs/{org_id}/drills` | `admin` | Create a drill session: name, start time, roster, and the `Resource` units fielded. |
| POST | `/api/drills/{drill_id}/join` | `viewer` | Join a live drill; returns initial `WorldSnapshot` and connects presence. |
| GET | `/api/drills/{drill_id}/snapshot` | `viewer` | Full `WorldSnapshot` — initial-paint fallback if the WebSocket is slow to connect. |
| POST | `/api/drills/{drill_id}/reports` | `responder` | Submit a free-text field report → triggers the pipeline. Returns report id + accepted timestamp. |
| GET | `/api/drills/{drill_id}/audit` | `viewer` | Timestamped audit/event log for after-action review. |
| POST | `/api/drills/{drill_id}/end` | `admin` | End a live drill: stop the pipeline, freeze the picture, and keep the full audit trail for after-action review. |
| GET | `/api/drills/{drill_id}/export.csv` | `admin` | Export the drill's audit log and final incident list as CSV (FR-14). |
| PATCH | `/api/drills/{drill_id}/incidents/{incident_id}` | `net_control` | Update an incident: mark contained/closed, correct population/injuries, adjust location. |
| POST | `/api/drills/{drill_id}/units/{unit_id}/status` | `net_control` | Human commit of a recommendation: set unit status / assignment / role. The system never dispatches on its own. |
| WS | `/ws/drills/{drill_id}?token=<jwt>` | `viewer` | Live push of `WorldSnapshot` after every pipeline cycle; also accepts keepalive pings. |

Non-REST conventions:

- **Rate limit:** `POST /api/drills/{drill_id}/reports` is capped per user (burst of 5, then 1 per 2 s) — protects the cycle budget from a stuck keyboard, returns `429` with the standard error shape.
- **Idempotency:** report submission is idempotent per `(user, client_nonce)` so a double-click cannot create two incidents.

---

## 2. Auth strategy

**Provider: Firebase Authentication** (email/password + Google sign-in), with org membership and roles stored in PostgreSQL.

Flow:

1. Frontend authenticates with Firebase; receives a short-lived **ID token** (JWT).
2. Every REST call carries `Authorization: Bearer <ID token>`.
3. Backend verifies the token server-side via `firebase-admin` (signature against Google's public keys, expiry, audience), extracts the `uid`, and maps it to the local `User` row.
4. **Authorization is role-based per org:** `owner` → `admin` → `net_control` → `responder` → `viewer`. Drill access requires membership in the owning org; the endpoint table's `Auth` column names the minimum role.
5. **WebSocket auth:** browsers cannot set headers on WebSocket connections, so the client passes the same ID token as a `token` query parameter; the server verifies it *before* calling `accept()`. Expired token ⇒ close with code `4401`.

Why this provider:

- Email verification, password reset, and session refresh are exactly the boring, security-sensitive parts I should not hand-roll for a volunteer community.
- Free tier comfortably covers the 25-user scale; no per-seat cost.
- Identity lives in Firebase; **relationships** (org → member → role, org → drills) live in Postgres where they can be queried and audited. If Firebase ever needs replacing, only the token-verification layer changes.

---

## 3. Standard error shape

Every non-2xx response, from every route, uses one envelope:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Report text must be between 1 and 2000 characters.",
    "details": [
      { "field": "text", "issue": "length out of range" }
    ],
    "request_id": "req_9f2c41b7"
  }
}
```

- `code` — stable machine-readable string (below); the frontend switches on this, never on the message.
- `message` — one human-readable sentence, safe to show in a toast.
- `details` — optional array for field-level problems (mainly validation).
- `request_id` — echoed in server logs; a drill participant can read this out over radio and net control can find the exact failure.

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error` | Malformed body / out-of-range fields (FastAPI's default 422s are overridden to this shape). |
| 401 | `unauthorized` | Missing, expired, or invalid token (or WS close code `4401`). |
| 403 | `forbidden` | Valid token, but not a member of the org / role too low. |
| 404 | `not_found` | Drill, incident, or unit doesn't exist in the caller's scope. |
| 409 | `conflict` | e.g. joining a drill that already ended; assigning a unit already on scene elsewhere. |
| 429 | `rate_limited` | Report flood past the burst cap; `details` includes retry hint. |
| 500 | `internal_error` | Unhandled server fault; `request_id` in logs. |
| 503 | `degraded` | Only if the pipeline cannot accept reports at all. Normal LLM-outage fallback is **not** an error — the snapshot simply carries `mode: "fallback"` and a banner on the board. |

Pipeline-side problems (an agent failed, a report couldn't be parsed) are **not** HTTP errors: they surface as `AuditEvent` rows in the event log and a degraded-mode banner, because the person who needs to know is watching the board, not the network tab.

---

*Related: auth/storage choices in [ARCHITECTURE.md](./ARCHITECTURE.md) · role definitions and NFRs in [REQUIREMENTS.md](./REQUIREMENTS.md)*
