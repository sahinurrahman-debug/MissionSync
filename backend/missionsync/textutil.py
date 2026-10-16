"""Text hygiene for everything a person can type: control characters (NUL breaks Postgres text columns) and the
invisible direction-override characters that let a name pretend to be something else are removed on the way in."""
from __future__ import annotations

import re

# Everything below U+0020 except tab, newline and carriage return; DEL and the C1 range; zero-width and bidirectional
# format characters (U+200B-200F, U+202A-202E, U+2060-2069) and the byte-order mark.
CONTROL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def strip_controls(value: str) -> str:
    """Remove control and invisible formatting characters; keeps tabs and line breaks."""
    return CONTROL.sub("", value)


def clean_line(value: str) -> str:
    """One line of plain text: controls removed, whitespace runs collapsed, ends trimmed."""
    return " ".join(strip_controls(value).split())


def has_controls(value: str) -> bool:
    return CONTROL.search(value) is not None
