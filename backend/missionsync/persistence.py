"""What a running drill writes to the database: its audit trail, submitted reports, saved world state and
the shared LLM cache.

A database hiccup must never take a live drill down, so every method here swallows and logs its errors and
returns a harmless default. The user-facing CRUD (accounts, drills) lives in `repos.py` and *does* raise.
Constructed without an engine the store is a no-op, which keeps the simulation unit-testable in memory.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Engine, delete, select, update

from .db.schema import audit_events, drills, kv, reports

logger = logging.getLogger(__name__)


def csv_safe(value: Any) -> Any:
    """Stop spreadsheet formula injection: report text is user input."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Store:
    def __init__(self, engine: Optional[Engine] = None) -> None:
        self._engine = engine
        self.enabled = engine is not None
        self.backend = engine.dialect.name if engine is not None else "disabled"

    def status(self) -> str:
        return self.backend

    # -- audit trail and reports -------------------------------------------------------

    def add_events(self, drill_id: Optional[int], events: list[tuple[int, str, str]]) -> bool:
        if not self.enabled or drill_id is None or not events:
            return False
        try:
            now = _now()
            with self._engine.begin() as conn:  # type: ignore[union-attr]
                conn.execute(audit_events.insert(), [
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
            with self._engine.begin() as conn:  # type: ignore[union-attr]
                conn.execute(reports.insert().values(
                    drill_id=drill_id, text=text, source=source, kind=kind, incident_title=title,
                    tier=tier, urgency=urgency, created_at=_now()))
            return True
        except Exception as exc:
            logger.error("add_report failed: %s", exc)
            return False

    def clear_drill_data(self, drill_id: Optional[int]) -> bool:
        """A restart wipes the drill's audit trail and reports (the drill itself stays)."""
        if not self.enabled or drill_id is None:
            return False
        try:
            with self._engine.begin() as conn:  # type: ignore[union-attr]
                conn.execute(delete(audit_events).where(audit_events.c.drill_id == drill_id))
                conn.execute(delete(reports).where(reports.c.drill_id == drill_id))
            return True
        except Exception as exc:
            logger.error("clear_drill_data failed: %s", exc)
            return False

    # -- per-drill world state -----------------------------------------------------------

    def save_state(self, drill_id: Optional[int], state: dict[str, Any], status: str, dataset: str) -> bool:
        if not self.enabled or drill_id is None:
            return False
        try:
            with self._engine.begin() as conn:  # type: ignore[union-attr]
                conn.execute(update(drills).where(drills.c.id == drill_id).values(
                    state=json.dumps(state, separators=(",", ":")), state_updated_at=_now(),
                    updated_at=_now(), status=status, dataset=dataset))
            return True
        except Exception as exc:
            logger.error("save_state failed: %s", exc)
            return False

    def load_state(self, drill_id: Optional[int]) -> Optional[tuple[dict[str, Any], datetime]]:
        if not self.enabled or drill_id is None:
            return None
        try:
            with self._engine.connect() as conn:  # type: ignore[union-attr]
                row = conn.execute(select(drills.c.state, drills.c.state_updated_at).where(drills.c.id == drill_id)).first()
            if row is None or not row[0]:
                return None
            return json.loads(row[0]), _aware(row[1] or _now())
        except Exception as exc:
            logger.error("load_state failed: %s", exc)
            return None

    # -- shared, non-personal key/value cache (LLM scores) -----------------------------------

    def set_kv(self, key: str, value: Any) -> bool:
        if not self.enabled:
            return False
        try:
            payload = json.dumps(value, separators=(",", ":"))
            with self._engine.begin() as conn:  # type: ignore[union-attr]
                conn.execute(delete(kv).where(kv.c.key == key))
                conn.execute(kv.insert().values(key=key, value=payload, updated_at=_now()))
            return True
        except Exception as exc:
            logger.error("set_kv(%s) failed: %s", key, exc)
            return False

    def get_kv(self, key: str) -> Optional[tuple[Any, datetime]]:
        if not self.enabled:
            return None
        try:
            with self._engine.connect() as conn:  # type: ignore[union-attr]
                row = conn.execute(select(kv).where(kv.c.key == key)).mappings().first()
            if row is None:
                return None
            return json.loads(row["value"]), _aware(row["updated_at"])
        except Exception as exc:
            logger.error("get_kv(%s) failed: %s", key, exc)
            return None
