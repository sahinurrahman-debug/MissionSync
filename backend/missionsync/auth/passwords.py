"""Password hashing (argon2id) and the password policy. Passwords are never stored, logged or returned."""
from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()                        # argon2id with the library's current recommended parameters

MIN_LENGTH = 8
MAX_LENGTH = 128
_COMMON = frozenset({"password", "password1", "12345678", "123456789", "qwertyui", "iloveyou", "11111111", "abc12345", "missionsync"})

# A real hash of a throw-away value: verifying against it keeps unknown-email logins as slow as real ones,
# so response time does not reveal which emails have accounts.
_DUMMY = _hasher.hash("timing-equaliser-not-a-real-password")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash or _DUMMY, password) and stored_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


def password_problem(password: str, email: str = "") -> str | None:
    """A human sentence describing what is wrong with the password, or None when it is acceptable."""
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    if password.lower() in _COMMON or len(set(password)) < 3:
        return "That password is too easy to guess."
    if email and password.lower() == email.strip().lower():
        return "The password cannot be your email address."
    return None
