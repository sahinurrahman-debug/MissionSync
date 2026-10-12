"""Request bodies. Everything the client sends is validated here, on the server — the browser is never trusted."""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


def _clean(value: str) -> str:
    return " ".join(value.split())              # trims and collapses runs of whitespace


class SignupBody(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @field_validator("display_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = _clean(v)
        if not v:
            raise ValueError("Enter your name.")
        return v


class LoginBody(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


class DrillCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    notes: str = Field(default="", max_length=500)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = _clean(v)
        if not v:
            raise ValueError("Give the drill a name.")
        return v


class DrillPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = _clean(v)
        if not v:
            raise ValueError("Give the drill a name.")
        return v


class ApproveBody(BaseModel):
    proposal_ids: Optional[list[str]] = Field(default=None, max_length=50)


class RejectBody(BaseModel):
    proposal_id: str = Field(min_length=1, max_length=120)


class ManualDispatchBody(BaseModel):
    incident_id: str = Field(min_length=1, max_length=64)
    resource_id: str = Field(min_length=1, max_length=64)
    role: str = Field(default="", max_length=60)


class IncidentPatch(BaseModel):
    status: Literal["contained", "closed"]


class SettingsBody(BaseModel):
    auto_dispatch: bool
