"""Optional Postgres persistence: drill history, the audit trail and submitted reports.

Enabled only when DATABASE_URL is set (Render injects it for a linked database);
without it every method is a no-op and the app runs purely in memory.

The database is an append-only record for after-action review — the live world
state stays in memory. A database failure must never take a drill down, so every
method swallows and logs its errors and returns a harmless default.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


def normalize_url(url: str) -> str:
    """Render hands out postgres:// URLs; SQLAlchemy + psycopg 3 want postgresql+psycopg://."""
    url = url.strip()
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def csv_safe(value: Any) -> Any:
    """Stop spreadsheet formula injection: report text is user input."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, url: Optional[str] = None) -> None:
        self.enabled = False
        self.error: Optional[str] = None
        self.backend = "disabled"
        self._engine: Any = None
        self._t: dict[str, Any] = {}
        if not url or not url.strip():
            return
        try:
            self._connect(normalize_url(url))
        except Exception as exc:  # bad URL, DB down, driver missing…
            self.error = f"{type(exc).__name__}: {str(exc)[:160]}"
            logger.error("Database disabled: %s", self.error)

    def _connect(self, url: str) -> None:
        from sqlalchemy import (
            Column, DateTime, Float, ForeignKey, Integer, MetaData, String, Table, Text, create_engine,
        )

        kwargs: dict[str, Any] = {"pool_pre_ping": True}
        if not url.startswith("sqlite"):
            kwargs.update(pool_size=3, max_overflow=2, pool_recycle=1800, connect_args={"connect_timeout": 5})
        self._engine = create_engine(url, **kwargs)
        meta = MetaData()
        drills = Table(
            "drills", meta,
            Column("id", Integer, primary_key=True, autoincrement=True),
            Column("started_at", DateTime(timezone=True), nullable=False),
            Column("dataset", String(40), nullable=False, default=""),
        )
        events = Table(
            "audit_events", meta,
            Column("id", Integer, primary_key=True, autoincrement=True),
            Column("drill_id", Integer, ForeignKey("drills.id"), nullable=False, index=True),
            Column("seq", Integer, nullable=False),
            Column("t", String(12), nullable=False),
            Column("msg", Text, nullable=False),
            Column("created_at", DateTime(timezone=True), nullable=False),
        )
        reports = Table(
            "reports", meta,
            Column("id", Integer, primary_key=True, autoincrement=True),
            Column("drill_id", Integer, ForeignKey("drills.id"), nullable=False, index=True),
            Column("text", Text, nullable=False),
            Column("source", String(20), nullable=False),
            Column("kind", String(10), nullable=False),
            Column("incident_title", Text, nullable=False, default=""),
            Column("tier", String(2)),
            Column("urgency", Float),
            Column("created_at", DateTime(timezone=True), nullable=False),
        )
        kv = Table(
            "kv", meta,
            Column("key", String(40), primary_key=True),
            Column("value", Text, nullable=False),
            Column("updated_at", DateTime(timezone=True), nullable=False),
        )
        self._t = {"drills": drills, "events": events, "reports": reports, "kv": kv}
        meta.create_all(self._engine)
        with self._engine.connect() as conn:       # fail now, not on the first drill
            conn.exec_driver_sql("SELECT 1")
        self.backend = self._engine.dialect.name
        self.enabled = True

    def status(self) -> str:
        return self.backend if self.enabled else ("error" if self.error else "disabled")

    # -- writes (never raise) --------------------------------------------------------

    def start_drill(self, dataset: str) -> Optional[int]:
        if not self.enabled:
            return None
        try:
            with self._engine.begin() as conn:
                res = conn.execute(self._t["drills"].insert().values(started_at=_now(), dataset=dataset))
                return int(res.inserted_primary_key[0])
        except Exception as exc:
            logger.error("start_drill failed: %s", exc)
            return None

    def add_events(self, drill_id: Optional[int], events: list[tuple[int, str, str]]) -> bool:
        if not self.enabled or drill_id is None or not events:
            return False
        try:
            now = _now()
            with self._engine.begin() as conn:
                conn.execute(self._t["events"].insert(), [
                    {"drill_id": drill_id, "seq": s, "t": t, "msg": m, "created_at": now} for s, t, m in events
                ])
            return True
        except Exception as exc:
            logger.error("add_events failed: %s", exc)
            return False

    def add_report(self, drill_id: Optional[int], text: str, source: str, kind: str,
                   title: str = "", tier: Optional[str] = None, urgency: Optional[float] = None) -> bool:
        if not self.enabled or drill_id is None:
            return False
        try:
            with self._engine.begin() as conn:
                conn.execute(self._t["reports"].insert().values(
                    drill_id=drill_id, text=text, source=source, kind=kind, incident_title=title,
                    tier=tier, urgency=urgency, created_at=_now()))
            return True
        except Exception as exc:
            logger.error("add_report failed: %s", exc)
            return False

    def set_kv(self, key: str, value: Any) -> bool:
        """Store a JSON document (world state, LLM cache). Replaces any previous value."""
        if not self.enabled:
            return False
        try:
            payload = json.dumps(value, separators=(",", ":"))
            kv = self._t["kv"]
            with self._engine.begin() as conn:
                conn.execute(kv.delete().where(kv.c.key == key))
                conn.execute(kv.insert().values(key=key, value=payload, updated_at=_now()))
            return True
        except Exception as exc:
            logger.error("set_kv(%s) failed: %s", key, exc)
            return False

    def get_kv(self, key: str) -> Optional[tuple[Any, datetime]]:
        if not self.enabled:
            return None
        try:
            from sqlalchemy import select

            kv = self._t["kv"]
            with self._engine.connect() as conn:
                row = conn.execute(select(kv).where(kv.c.key == key)).mappings().first()
            if row is None:
                return None
            at = row["updated_at"]
            return json.loads(row["value"]), (at if at.tzinfo else at.replace(tzinfo=timezone.utc))
        except Exception as exc:
            logger.error("get_kv(%s) failed: %s", key, exc)
            return None

    # -- reads (never raise) ------------------------------------------------------------

    def list_drills(self, limit: int = 25) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            from sqlalchemy import func, select

            d, e, r = self._t["drills"], self._t["events"], self._t["reports"]
            with self._engine.connect() as conn:
                rows = conn.execute(select(d).order_by(d.c.id.desc()).limit(limit)).mappings().all()
                out = []
                for row in rows:
                    n_events = conn.execute(select(func.count()).select_from(e).where(e.c.drill_id == row["id"])).scalar_one()
                    n_reports = conn.execute(select(func.count()).select_from(r).where(r.c.drill_id == row["id"])).scalar_one()
                    out.append({"id": row["id"], "started_at": row["started_at"].isoformat(), "dataset": row["dataset"],
                                "events": n_events, "reports": n_reports})
                return out
        except Exception as exc:
            logger.error("list_drills failed: %s", exc)
            return []

    def drill_exists(self, drill_id: int) -> bool:
        if not self.enabled:
            return False
        try:
            from sqlalchemy import select

            with self._engine.connect() as conn:
                return conn.execute(select(self._t["drills"].c.id).where(self._t["drills"].c.id == drill_id)).first() is not None
        except Exception:
            return False

    def drill_events(self, drill_id: int) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            from sqlalchemy import select

            e = self._t["events"]
            with self._engine.connect() as conn:
                rows = conn.execute(select(e).where(e.c.drill_id == drill_id).order_by(e.c.seq, e.c.id)).mappings().all()
                return [{"seq": x["seq"], "t": x["t"], "msg": x["msg"]} for x in rows]
        except Exception as exc:
            logger.error("drill_events failed: %s", exc)
            return []

    def drill_reports(self, drill_id: int) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            from sqlalchemy import select

            r = self._t["reports"]
            with self._engine.connect() as conn:
                rows = conn.execute(select(r).where(r.c.drill_id == drill_id).order_by(r.c.id)).mappings().all()
                return [{"created_at": x["created_at"].isoformat(), "text": x["text"], "source": x["source"], "kind": x["kind"],
                         "incident_title": x["incident_title"], "tier": x["tier"], "urgency": x["urgency"]} for x in rows]
        except Exception as exc:
            logger.error("drill_reports failed: %s", exc)
            return []

    def export_csv(self, drill_id: int) -> str:
        """After-action export: submitted reports, then the full audit trail (FR-14)."""
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["# submitted reports"])
        w.writerow(["created_at", "source", "outcome", "tier", "urgency", "incident_title", "text"])
        for x in self.drill_reports(drill_id):
            w.writerow([x["created_at"], x["source"], x["kind"], x["tier"] or "",
                        x["urgency"] if x["urgency"] is not None else "",
                        csv_safe(x["incident_title"]), csv_safe(x["text"])])
        w.writerow([])
        w.writerow(["# audit trail"])
        w.writerow(["seq", "time_utc", "event"])
        for x in self.drill_events(drill_id):
            w.writerow([x["seq"], x["t"], csv_safe(x["msg"])])
        return buf.getvalue()
