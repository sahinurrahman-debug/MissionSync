# How MissionSync works — a guided tour of the code

This project was built with an AI coding assistant (Claude Code), and the point of this page is to make sure the *understanding* ends up with the person who ships it. Read it with the code open: every section names the file to look at and a question to answer in your own words.

## 1. Follow one request: "Approve all"

1. **Click** — `frontend/src/components/Recommendations.tsx` calls `onApprove()`.
2. **Optimistic update** — `frontend/src/pages/DrillBoard.tsx` hides the proposals immediately (`hideProposals`), then calls `source.approve()`. If the server answers with an error it calls `showProposals()` and a toast explains why. *Why show the result before the server confirms?* The button feels instant; the cost is a rollback path.
3. **HTTP** — `frontend/src/api/remote.ts` → `api/http.ts` sends `POST /api/drills/7/dispatch/approve` with `credentials: 'include'` so the browser attaches the session cookie.
4. **Who is calling?** — `backend/missionsync/deps.py`: `current_user` reads the cookie, hashes it, and looks it up in the `sessions` table. No match or expired → `401`.
5. **Is it theirs?** — `owned_drill` runs `SELECT … WHERE id = ? AND owner_id = ?` (`repos.py`). Someone else's drill returns nothing → `404`. *Why 404 and not 403?* A 403 would confirm the drill exists.
6. **Which simulation?** — `manager.py`'s `DrillManager.get(id)` returns the running `Orchestrator` for that drill, loading it from the database if needed.
7. **Do it** — `orchestrator.py` `approve()` validates every proposal again (the world may have moved on), commits the dispatches under a lock, and logs it.
8. **Everyone sees it** — `hub.py` serialises the new snapshot once and puts it in each viewer's outbox; the WebSocket pushes it; `remote.ts` applies it and React re-renders.

## 2. The ideas worth being able to explain

**Agents propose, code decides.** The LLM suggests scores and assignments, but `agents.py` validates everything (types, ranges, capability, crew size) before it can touch state. A hallucinated unit name simply cannot be dispatched. *Where is the final gate?* `_apply_assignments` in `orchestrator.py`.

**Provisional-then-refine.** An LLM call takes 10–30 s; a report must feel instant. So a report is ranked immediately by rule-based "twins" of the agents (marked *AI scoring…*), and the LLM refines it in a background task (`_refine_loop`). The result is re-validated when applied because the world changed meanwhile.

**Sessions, not tokens in JavaScript.** `routers/auth.py` creates a random 256-bit token, stores only its SHA-256 in `sessions`, and sets it as an `HttpOnly` cookie, so a script injected into the page (XSS) cannot read it and a database leak cannot be replayed. Logging out deletes the row, which really ends the session. *What would a JWT in `localStorage` have changed?* It cannot be revoked and any XSS can steal it.

**Passwords.** `auth/passwords.py` uses argon2id: slow and memory-hungry on purpose. Login always performs a hash (even for unknown emails) so response time does not reveal which emails have accounts.

**Why the whole thing is one origin.** See `docs/ARCHITECTURE.md §0`. Cookies, CORS and WebSockets all get simpler when the page and the API share a host.

**Migrations.** `backend/migrations/versions/` is the history of the schema. `alembic upgrade head` builds the database from nothing and the app runs it on start-up, so a new environment is one command. `0001` adopts the old pre-accounts tables; `0002` adds users and ownership. `tests/test_migrations.py` proves it from scratch, twice, and backwards.

**One orchestrator per drill.** `manager.py` keeps each open drill in memory with its own lock, tick loop and WebSocket hub, saves it to `drills.state` after each cycle, and unloads idle ones. Two users' drills share nothing except the LLM score cache (keyed by report *content*, never by user).

**Optimistic UI.** `hooks/useDrills.ts` shows a created/renamed/deleted drill immediately and undoes it with a message if the server refuses. The tests in `pages/pages.test.tsx` pin both halves.

## 3. How it is tested (and what to read first)

| Question | Test file |
|---|---|
| Can user B ever touch user A's drill? | `backend/tests/test_isolation.py` — 15 routes × (another user, anonymous), plus WebSockets |
| Are sign-up/sign-in and cookies secure? | `backend/tests/test_auth.py` |
| Does CRUD validate on the server and clean up? | `backend/tests/test_drills_crud.py` |
| Does the schema build from scratch? | `backend/tests/test_migrations.py` |
| Does the UI redirect, validate inline and roll back? | `frontend/src/pages/pages.test.tsx` |
| Does the real app work end to end? | `scripts/e2e_screens.mjs` (headless browser) |

## 4. Exercises to check your understanding

1. Change the session lifetime to 1 day and prove with a test that a day-old session is rejected (`SESSION_DAYS`, `test_auth.py`).
2. Add a `PATCH` field (say `scenario`) to drills: schema → migration `0003` → repo → route → form → tests. Which of those would you forget first?
3. Break isolation on purpose: remove `owner_id` from `DrillRepo.get`. Which tests fail, and which did *not*? What does that tell you about the tests?
4. Explain, without looking, why `DELETE /api/drills/{id}` unloads the running drill *before* deleting rows.
5. Open the network tab during sign-in: which cookie flags do you see, and why can `document.cookie` not show it?

## 5. Where I would go next (Shogun)

Organisations and roles, email verification and password reset, a Redis-backed rate limiter and session cache for more than one instance, and replacing the in-memory drill runtime with a worker so a deploy never interrupts a live drill.
