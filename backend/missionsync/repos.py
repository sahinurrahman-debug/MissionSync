"""Repositories: every read and write of user-owned data goes through here, and every drill query is scoped by
`owner_id`, so one account can never see or change another's drills (the check lives in the SQL, not in a route).

Unlike `persistence.Store` these raise on failure — a failed sign-up or delete must be reported, not swallowed.
"""
from __future__ import annotations

import csv
import hashlib
import io
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import Engine, delete, func, select, update
from sqlalchemy.exc import IntegrityError

from .db.schema import audit_events, drills, reports, sessions, users
from .persistence import csv_safe


class EmailTaken(Exception):
    pass


class LimitReached(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def normalize_email(email: str) -> str:
    return email.strip().lower()


@dataclass(frozen=True)
class User:
    id: int
    email: str
    display_name: str
    created_at: datetime

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "email": self.email, "display_name": self.display_name, "created_at": self.created_at.isoformat()}


@dataclass(frozen=True)
class DrillRecord:
    id: int
    owner_id: Optional[int]
    name: str
    notes: str
    status: str
    dataset: str
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    events: int = 0
    reports: int = 0

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "notes": self.notes, "status": self.status, "dataset": self.dataset,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "events": self.events, "reports": self.reports,
        }


def _user(row: Any) -> User:
    return User(id=row["id"], email=row["email"], display_name=row["display_name"], created_at=_aware(row["created_at"]))  # type: ignore[arg-type]


def _drill(row: Any, events: int = 0, n_reports: int = 0) -> DrillRecord:
    return DrillRecord(
        id=row["id"], owner_id=row["owner_id"], name=row["name"], notes=row["notes"], status=row["status"],
        dataset=row["dataset"], created_at=_aware(row["created_at"] or row["started_at"]), updated_at=_aware(row["updated_at"]),
        events=events, reports=n_reports,
    )


class UserRepo:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def create(self, email: str, display_name: str, password_hash: str) -> User:
        try:
            with self.engine.begin() as conn:
                res = conn.execute(users.insert().values(
                    email=normalize_email(email), display_name=display_name.strip(), password_hash=password_hash, created_at=_now()))
                uid = int(res.inserted_primary_key[0])
                row = conn.execute(select(users).where(users.c.id == uid)).mappings().one()
            return _user(row)
        except IntegrityError as exc:
            raise EmailTaken() from exc

    def by_email(self, email: str) -> Optional[tuple[User, str]]:
        with self.engine.connect() as conn:
            row = conn.execute(select(users).where(users.c.email == normalize_email(email))).mappings().first()
        return (_user(row), row["password_hash"]) if row else None

    def by_id(self, user_id: int) -> Optional[User]:
        with self.engine.connect() as conn:
            row = conn.execute(select(users).where(users.c.id == user_id)).mappings().first()
        return _user(row) if row else None

    def set_password_hash(self, user_id: int, password_hash: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(users).where(users.c.id == user_id).values(password_hash=password_hash))


class SessionRepo:
    """Server-side sessions. The browser holds a random token in an httpOnly cookie; only its SHA-256 is stored,
    so a leaked database cannot be replayed as logins."""

    TOUCH_EVERY_S = 60

    def __init__(self, engine: Engine, lifetime_days: int) -> None:
        self.engine = engine
        self.lifetime = timedelta(days=lifetime_days)

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create(self, user_id: int, user_agent: str = "") -> tuple[str, datetime]:
        token = secrets.token_urlsafe(32)
        now = _now()
        expires = now + self.lifetime
        with self.engine.begin() as conn:
            conn.execute(sessions.insert().values(
                id=self._key(token), user_id=user_id, created_at=now, expires_at=expires, last_seen_at=now, user_agent=user_agent[:200]))
        return token, expires

    def resolve(self, token: str) -> Optional[User]:
        if not token or len(token) > 200:
            return None
        key = self._key(token)
        now = _now()
        with self.engine.begin() as conn:
            row = conn.execute(
                select(sessions.c.expires_at, sessions.c.last_seen_at, users).join(users, users.c.id == sessions.c.user_id)
                .where(sessions.c.id == key)).mappings().first()
            if row is None:
                return None
            if _aware(row["expires_at"]) <= now:                       # type: ignore[operator]
                conn.execute(delete(sessions).where(sessions.c.id == key))
                return None
            if (now - _aware(row["last_seen_at"])).total_seconds() > self.TOUCH_EVERY_S:   # type: ignore[operator]
                conn.execute(update(sessions).where(sessions.c.id == key).values(last_seen_at=now))
        return _user(row)

    def revoke(self, token: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(delete(sessions).where(sessions.c.id == self._key(token)))

    def purge_expired(self) -> int:
        with self.engine.begin() as conn:
            return conn.execute(delete(sessions).where(sessions.c.expires_at <= _now())).rowcount or 0


class DrillRepo:
    def __init__(self, engine: Engine, max_per_user: int) -> None:
        self.engine = engine
        self.max_per_user = max_per_user

    # -- create / read ----------------------------------------------------------------

    def create(self, owner_id: int, name: str, notes: str = "") -> DrillRecord:
        with self.engine.begin() as conn:
            count = conn.execute(select(func.count()).select_from(drills).where(drills.c.owner_id == owner_id)).scalar_one()
            if count >= self.max_per_user:
                raise LimitReached()
            now = _now()
            res = conn.execute(drills.insert().values(
                owner_id=owner_id, name=name.strip(), notes=notes.strip(), status="new", dataset="", started_at=now, created_at=now, updated_at=now))
            row = conn.execute(select(drills).where(drills.c.id == int(res.inserted_primary_key[0]))).mappings().one()
        return _drill(row)

    def list(self, owner_id: int) -> list[DrillRecord]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(drills).where(drills.c.owner_id == owner_id).order_by(drills.c.id.desc())).mappings().all()
            out = []
            for row in rows:
                ev = conn.execute(select(func.count()).select_from(audit_events).where(audit_events.c.drill_id == row["id"])).scalar_one()
                rp = conn.execute(select(func.count()).select_from(reports).where(reports.c.drill_id == row["id"])).scalar_one()
                out.append(_drill(row, ev, rp))
        return out

    def get(self, owner_id: int, drill_id: int) -> Optional[DrillRecord]:
        """The drill, only if `owner_id` owns it — a stranger's drill is indistinguishable from a missing one."""
        with self.engine.connect() as conn:
            row = conn.execute(select(drills).where(drills.c.id == drill_id, drills.c.owner_id == owner_id)).mappings().first()
            if row is None:
                return None
            ev = conn.execute(select(func.count()).select_from(audit_events).where(audit_events.c.drill_id == drill_id)).scalar_one()
            rp = conn.execute(select(func.count()).select_from(reports).where(reports.c.drill_id == drill_id)).scalar_one()
        return _drill(row, ev, rp)

    # -- update / delete --------------------------------------------------------------

    def update(self, owner_id: int, drill_id: int, name: Optional[str] = None, notes: Optional[str] = None) -> Optional[DrillRecord]:
        values: dict[str, Any] = {"updated_at": _now()}
        if name is not None:
            values["name"] = name.strip()
        if notes is not None:
            values["notes"] = notes.strip()
        with self.engine.begin() as conn:
            res = conn.execute(update(drills).where(drills.c.id == drill_id, drills.c.owner_id == owner_id).values(**values))
            if res.rowcount == 0:
                return None
        return self.get(owner_id, drill_id)

    def delete(self, owner_id: int, drill_id: int) -> bool:
        with self.engine.begin() as conn:
            owned = conn.execute(select(drills.c.id).where(drills.c.id == drill_id, drills.c.owner_id == owner_id)).first()
            if owned is None:
                return False
            conn.execute(delete(audit_events).where(audit_events.c.drill_id == drill_id))      # explicit: legacy DBs lack the cascade
            conn.execute(delete(reports).where(reports.c.drill_id == drill_id))
            conn.execute(delete(drills).where(drills.c.id == drill_id))
        return True

    # -- after-action review (owner-checked by the caller via get()) ---------------------

    def events(self, drill_id: int) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(audit_events).where(audit_events.c.drill_id == drill_id).order_by(audit_events.c.seq, audit_events.c.id)).mappings().all()
        return [{"seq": x["seq"], "t": x["t"], "msg": x["msg"]} for x in rows]

    def reports(self, drill_id: int) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(reports).where(reports.c.drill_id == drill_id).order_by(reports.c.id)).mappings().all()
        return [{"created_at": _aware(x["created_at"]).isoformat(), "text": x["text"], "source": x["source"], "kind": x["kind"],  # type: ignore[union-attr]
                 "incident_title": x["incident_title"], "tier": x["tier"], "urgency": x["urgency"]} for x in rows]

    def export_csv(self, drill_id: int) -> str:
        """After-action export: submitted reports, then the full audit trail (FR-14)."""
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["# submitted reports"])
        w.writerow(["created_at", "source", "outcome", "tier", "urgency", "incident_title", "text"])
        for x in self.reports(drill_id):
            w.writerow([x["created_at"], x["source"], x["kind"], x["tier"] or "",
                        x["urgency"] if x["urgency"] is not None else "",
                        csv_safe(x["incident_title"]), csv_safe(x["text"])])
        w.writerow([])
        w.writerow(["# audit trail"])
        w.writerow(["seq", "time_utc", "event"])
        for x in self.events(drill_id):
            w.writerow([x["seq"], x["t"], csv_safe(x["msg"])])
        return buf.getvalue()
