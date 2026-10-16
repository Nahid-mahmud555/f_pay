"""
F PAY — database.py
===================
Pure-Python data layer for the F Pay demo.

Uses SQLite (standard library). No external services required.
All money-moving operations are wrapped in atomic transactions
using `BEGIN IMMEDIATE`, so balance updates can never double-count.

Security notes (READ THIS):
    - PINs are hashed with werkzeug.security (PBKDF2-SHA256 by default).
      Install once:  pip install werkzeug
    - OTPs are hashed and stored with an expiry and attempt counter.
    - Every balance change goes through a SECURITY-DEFINER-style function
      in this module (allocate_to_layer, release_layer, execute_transfer).
      The client NEVER sends a balance value — only an amount and a target.
    - Sandbox and normal wallets are separate rows. Nothing crosses.
    - This is still a DEMO. Do not put real money behind it.

Usage from app.py:
    import database as db
    db.init_db()
    uid = db.create_user("Alice", "01700000000", "my favourite", "1234")
    ...
"""

import os
import sqlite3
import secrets
import string
from datetime import datetime, timedelta
from contextlib import contextmanager

from werkzeug.security import generate_password_hash, check_password_hash


# ═══════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════

DB_PATH = os.environ.get("FPAY_DB", "fpay.db")

MIN_TRANSFER_CNY    = 20
SANDBOX_START_CNY   = 1
NORMAL_START_CNY    = 10000
MAX_LAYERS          = 30
OTP_TTL_SECONDS     = 5 * 60
OTP_MAX_ATTEMPTS    = 5
RECOVERY_CODE_TTL   = 10 * 60


# ═══════════════════════════════════════════════════════════════════════════
# Connection helper — one per call, WAL mode, foreign keys ON
# ═══════════════════════════════════════════════════════════════════════════

@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH, isolation_level=None)  # autocommit off via BEGIN
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def _transaction():
    """Atomic write transaction. Rolls back on any exception."""
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


# ═══════════════════════════════════════════════════════════════════════════
# Schema
# ═══════════════════════════════════════════════════════════════════════════

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name             TEXT    NOT NULL,
    primary_phone         TEXT    NOT NULL UNIQUE,
    pin_hash              TEXT    NOT NULL,
    duplicate_pin_hash    TEXT,                          -- nullable
    fav_sentence_hash     TEXT    NOT NULL,
    backup_phone          TEXT,
    backup_verified       INTEGER NOT NULL DEFAULT 0,    -- 0 / 1
    created_at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode                  TEXT    NOT NULL CHECK (mode IN ('normal','sandbox')),
    balance               REAL    NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency              TEXT    NOT NULL DEFAULT 'CNY',
    created_at            TEXT    NOT NULL,
    UNIQUE (user_id, mode)
);

CREATE TABLE IF NOT EXISTS money_layers (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id             INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    layer_number          INTEGER NOT NULL CHECK (layer_number BETWEEN 1 AND 30),
    title                 TEXT,
    description           TEXT,
    allocated_amount      REAL    NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
    is_locked             INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL,
    UNIQUE (wallet_id, layer_number)
);

CREATE TABLE IF NOT EXISTS budget_plans (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id             INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    title                 TEXT    NOT NULL,
    description           TEXT,
    layer_number          INTEGER,
    planned_amount        REAL    CHECK (planned_amount IS NULL OR planned_amount >= 0),
    reporting_interval    INTEGER NOT NULL CHECK (reporting_interval IN (7,15,30)),
    is_active             INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    reference             TEXT    NOT NULL UNIQUE,
    wallet_id             INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    purpose               TEXT    NOT NULL,
    amount                REAL    NOT NULL CHECK (amount > 0),
    source_layer_number   INTEGER NOT NULL,
    recipient_phone       TEXT,
    status                TEXT    NOT NULL CHECK (status IN ('pending','completed','failed','cancelled')),
    budget_plan_id        INTEGER REFERENCES budget_plans(id) ON DELETE SET NULL,
    planned_amount_snap   REAL,
    budget_difference     REAL,
    is_demo               INTEGER NOT NULL DEFAULT 1,
    is_seed               INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_wallet_time
    ON transactions (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_challenges (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
    purpose               TEXT    NOT NULL,   -- signup | reset | transaction | backup
    code_hash             TEXT    NOT NULL,
    transaction_ref       TEXT,               -- nullable; links to pending txn
    expires_at            TEXT    NOT NULL,
    attempts              INTEGER NOT NULL DEFAULT 0,
    max_attempts          INTEGER NOT NULL DEFAULT 5,
    consumed_at           TEXT,
    created_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otp_user_purpose
    ON otp_challenges (user_id, purpose, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER,
    wallet_id             INTEGER,
    event                 TEXT    NOT NULL,
    metadata              TEXT,
    created_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events (created_at DESC);
"""


def init_db(seed_demo: bool = False):
    """Create tables, then optionally seed a demo account + sandbox wallet."""
    with _connect() as conn:
        conn.executescript(SCHEMA)
    if seed_demo:
        seed_demo_account()


# ═══════════════════════════════════════════════════════════════════════════
# Utilities
# ═══════════════════════════════════════════════════════════════════════════

def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _new_reference() -> str:
    """Format: FPAY-XXXXXXXX (base36-ish, uppercase)."""
    alphabet = string.ascii_uppercase + string.digits
    return "FPAY-" + "".join(secrets.choice(alphabet) for _ in range(8))


def _normalize(s: str) -> str:
    """Whitespace + case + punctuation normalization for plan matching."""
    import re
    s = (s or "").lower()
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _hash_secret(s: str) -> str:
    return generate_password_hash(s, method="pbkdf2:sha256")


def _verify_secret(s: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return check_password_hash(hashed, s)
    except Exception:
        return False


def _audit(conn, user_id, wallet_id, event, metadata=None):
    conn.execute(
        "INSERT INTO audit_events (user_id, wallet_id, event, metadata, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (user_id, wallet_id, event, metadata, _now()),
    )


# ═══════════════════════════════════════════════════════════════════════════
# USERS  —  Layer 1
# ═══════════════════════════════════════════════════════════════════════════

def create_user(full_name: str, phone: str, fav_sentence: str, pin: str,
                backup_phone: str = None) -> int:
    """
    Create user + both wallets (normal & sandbox) in one transaction.
    Returns user_id. Raises ValueError on duplicate phone or bad input.
    """
    full_name = (full_name or "").strip()
    phone     = (phone or "").strip()
    pin       = (pin or "").strip()
    fav       = (fav_sentence or "").strip()

    if len(full_name) < 2:      raise ValueError("full_name_too_short")
    if not phone.isdigit() or not (10 <= len(phone) <= 15):
        raise ValueError("invalid_phone")
    if len(fav) < 3:            raise ValueError("fav_sentence_too_short")
    if not pin.isdigit() or not (4 <= len(pin) <= 6):
        raise ValueError("invalid_pin")

    with _transaction() as conn:
        row = conn.execute("SELECT id FROM users WHERE primary_phone = ?", (phone,)).fetchone()
        if row:
            raise ValueError("phone_taken")

        cur = conn.execute(
            "INSERT INTO users "
            "(full_name, primary_phone, pin_hash, fav_sentence_hash, "
            " backup_phone, backup_verified, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                full_name,
                phone,
                _hash_secret(pin),
                _hash_secret(fav.lower()),
                backup_phone,
                1 if backup_phone else 0,
                _now(),
            ),
        )
        uid = cur.lastrowid

        # Two wallets, completely separate rows.
        for mode, starting in (("normal", NORMAL_START_CNY), ("sandbox", SANDBOX_START_CNY)):
            wcur = conn.execute(
                "INSERT INTO wallets (user_id, mode, balance, currency, created_at) "
                "VALUES (?, ?, ?, 'CNY', ?)",
                (uid, mode, starting, _now()),
            )
            wid = wcur.lastrowid

            # 30 empty layers per wallet
            for n in range(1, MAX_LAYERS + 1):
                conn.execute(
                    "INSERT INTO money_layers "
                    "(wallet_id, layer_number, allocated_amount, is_locked, created_at, updated_at) "
                    "VALUES (?, ?, 0, 1, ?, ?)",
                    (wid, n, _now(), _now()),
                )

            # Seed the sandbox with clearly-labelled fictional transactions.
            if mode == "sandbox":
                _seed_sandbox_transactions(conn, wid)

        _audit(conn, uid, None, "user_created", f"phone={phone}")
        return uid


def get_user_by_id(user_id: int):
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_user_by_phone(phone: str):
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE primary_phone = ?", (phone,)).fetchone()
        return dict(row) if row else None


def set_duplicate_pin(user_id: int, regular_pin: str, duplicate_pin: str) -> None:
    """Verify regular PIN, then set duplicate PIN. Never equal to regular."""
    if duplicate_pin == regular_pin:
        raise ValueError("duplicate_equals_regular")
    if not duplicate_pin.isdigit() or not (4 <= len(duplicate_pin) <= 6):
        raise ValueError("invalid_duplicate_pin")

    with _transaction() as conn:
        row = conn.execute("SELECT pin_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise ValueError("user_not_found")
        if not _verify_secret(regular_pin, row["pin_hash"]):
            raise ValueError("regular_pin_incorrect")

        conn.execute(
            "UPDATE users SET duplicate_pin_hash = ? WHERE id = ?",
            (_hash_secret(duplicate_pin), user_id),
        )
        _audit(conn, user_id, None, "duplicate_pin_set")


def disable_duplicate_pin(user_id: int, regular_pin: str) -> None:
    with _transaction() as conn:
        row = conn.execute("SELECT pin_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not _verify_secret(regular_pin, row["pin_hash"]):
            raise ValueError("regular_pin_incorrect")
        conn.execute("UPDATE users SET duplicate_pin_hash = NULL WHERE id = ?", (user_id,))
        _audit(conn, user_id, None, "duplicate_pin_disabled")


# ═══════════════════════════════════════════════════════════════════════════
# AUTHENTICATION  —  Layer 1 + Layer 9
# ═══════════════════════════════════════════════════════════════════════════

def authenticate(phone: str, pin: str):
    """
    Returns one of:
        {'ok': True,  'user_id': int, 'mode': 'normal'|'sandbox'}
        {'ok': False, 'reason': 'no_user'|'bad_credentials'}
    Never reveals which PIN matched.
    """
    u = get_user_by_phone(phone)
    if not u:
        return {"ok": False, "reason": "no_user"}

    if _verify_secret(pin, u["pin_hash"]):
        return {"ok": True, "user_id": u["id"], "mode": "normal"}
    if u["duplicate_pin_hash"] and _verify_secret(pin, u["duplicate_pin_hash"]):
        return {"ok": True, "user_id": u["id"], "mode": "sandbox"}

    return {"ok": False, "reason": "bad_credentials"}


# ═══════════════════════════════════════════════════════════════════════════
# OTP  —  server-issued challenges
# ═══════════════════════════════════════════════════════════════════════════

def issue_otp(user_id: int, purpose: str, transaction_ref: str = None) -> str:
    """Create a 5-digit OTP. Returns the plaintext code (caller shows/sends it)."""
    code = f"{secrets.randbelow(90000) + 10000:05d}"
    expires = _iso(datetime.utcnow() + timedelta(seconds=OTP_TTL_SECONDS))

    with _transaction() as conn:
        conn.execute(
            "INSERT INTO otp_challenges "
            "(user_id, purpose, code_hash, transaction_ref, expires_at, "
            " attempts, max_attempts, created_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            (user_id, purpose, _hash_secret(code), transaction_ref,
             expires, OTP_MAX_ATTEMPTS, _now()),
        )
        _audit(conn, user_id, None, "otp_issued", f"purpose={purpose}")
    return code


def verify_otp(user_id: int, purpose: str, code: str) -> bool:
    """Verify latest unconsumed OTP for (user, purpose). Enforces attempts & expiry."""
    now = _now()
    with _transaction() as conn:
        row = conn.execute(
            "SELECT * FROM otp_challenges "
            "WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL "
            "ORDER BY id DESC LIMIT 1",
            (user_id, purpose),
        ).fetchone()
        if not row:
            return False
        if row["expires_at"] < now:
            return False
        if row["attempts"] >= row["max_attempts"]:
            return False

        conn.execute(
            "UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?",
            (row["id"],),
        )
        if _verify_secret(code, row["code_hash"]):
            conn.execute(
                "UPDATE otp_challenges SET consumed_at = ? WHERE id = ?",
                (_now(), row["id"]),
            )
            return True
        return False


# ═══════════════════════════════════════════════════════════════════════════
# WALLETS  —  Layer 2
# ═══════════════════════════════════════════════════════════════════════════

def get_wallet(user_id: int, mode: str):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        return dict(row) if row else None


def get_wallet_summary(user_id: int, mode: str) -> dict:
    """
    Returns:
        balance, allocated, unallocated, layers (list of dicts)
    All numbers derived from the DB. Nothing trusted from the client.
    """
    with _connect() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        layers = [dict(r) for r in conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? ORDER BY layer_number",
            (w["id"],),
        ).fetchall()]

        # Spend per layer from completed transactions
        spent_by_layer = {r["source_layer_number"]: r["total"] for r in conn.execute(
            "SELECT source_layer_number, SUM(amount) AS total FROM transactions "
            "WHERE wallet_id = ? AND status = 'completed' "
            "GROUP BY source_layer_number",
            (w["id"],),
        ).fetchall()}

        for l in layers:
            spent = spent_by_layer.get(l["layer_number"], 0.0) or 0.0
            l["spent"] = round(spent, 2)
            l["remaining"] = round(max(0.0, l["allocated_amount"] - spent), 2)

        allocated = round(sum(l["allocated_amount"] for l in layers), 2)
        balance   = round(w["balance"], 2)
        return {
            "wallet_id":   w["id"],
            "mode":        w["mode"],
            "balance":     balance,
            "allocated":   allocated,
            "unallocated": round(balance - allocated, 2),
            "currency":    w["currency"],
            "layers":      layers,
        }


# ═══════════════════════════════════════════════════════════════════════════
# LAYERS  —  Layer 3
# ═══════════════════════════════════════════════════════════════════════════

def allocate_to_layer(user_id: int, mode: str, layer_number: int,
                      title: str, amount: float, description: str = "") -> None:
    """
    Atomically move money from unallocated balance into a layer.
    Raises ValueError on:
        invalid_amount, invalid_layer, layer_configured,
        wallet_not_found, insufficient_unallocated
    """
    if not (1 <= layer_number <= MAX_LAYERS):
        raise ValueError("invalid_layer")
    title = (title or "").strip()
    if not title:
        raise ValueError("title_required")
    if amount is None or amount <= 0:
        raise ValueError("invalid_amount")

    with _transaction() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        # Unallocated = balance - SUM(allocated)
        alloc_row = conn.execute(
            "SELECT COALESCE(SUM(allocated_amount), 0) AS a "
            "FROM money_layers WHERE wallet_id = ?",
            (w["id"],),
        ).fetchone()
        unallocated = w["balance"] - alloc_row["a"]

        if amount > unallocated + 1e-9:
            raise ValueError("insufficient_unallocated")

        layer = conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? AND layer_number = ?",
            (w["id"], layer_number),
        ).fetchone()
        if layer["title"]:
            raise ValueError("layer_configured")

        conn.execute(
            "UPDATE money_layers SET title = ?, description = ?, "
            "allocated_amount = ?, is_locked = 1, updated_at = ? "
            "WHERE id = ?",
            (title, description, amount, _now(), layer["id"]),
        )
        _audit(conn, user_id, w["id"], "layer_allocated",
               f"layer={layer_number} amount={amount}")


def adjust_layer(user_id: int, mode: str, layer_number: int,
                 new_amount: float, new_title: str = None,
                 new_description: str = None) -> None:
    """
    Change a layer's allocated amount (and optionally title/description).
    The delta is validated against unallocated balance.
    """
    if new_amount is None or new_amount < 0:
        raise ValueError("invalid_amount")

    with _transaction() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        layer = conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? AND layer_number = ?",
            (w["id"], layer_number),
        ).fetchone()
        if not layer or not layer["title"]:
            raise ValueError("layer_not_configured")

        alloc_row = conn.execute(
            "SELECT COALESCE(SUM(allocated_amount), 0) AS a "
            "FROM money_layers WHERE wallet_id = ? AND layer_number != ?",
            (w["id"], layer_number),
        ).fetchone()
        unallocated_for_this = w["balance"] - alloc_row["a"]

        if new_amount > unallocated_for_this + 1e-9:
            raise ValueError("insufficient_unallocated")

        conn.execute(
            "UPDATE money_layers SET allocated_amount = ?, "
            "title = COALESCE(?, title), "
            "description = COALESCE(?, description), "
            "updated_at = ? WHERE id = ?",
            (new_amount, new_title, new_description, _now(), layer["id"]),
        )
        _audit(conn, user_id, w["id"], "layer_adjusted",
               f"layer={layer_number} new={new_amount}")


def release_layer(user_id: int, mode: str, layer_number: int) -> None:
    """Empty a configured layer back into the unallocated balance."""
    with _transaction() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        layer = conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? AND layer_number = ?",
            (w["id"], layer_number),
        ).fetchone()
        if not layer or not layer["title"]:
            raise ValueError("layer_not_configured")

        # Refuse to release if there are completed transactions on the layer
        used = conn.execute(
            "SELECT COUNT(*) AS c FROM transactions "
            "WHERE wallet_id = ? AND source_layer_number = ? AND status = 'completed'",
            (w["id"], layer_number),
        ).fetchone()
        if used["c"] > 0:
            raise ValueError("layer_has_history")

        conn.execute(
            "UPDATE money_layers SET title = NULL, description = NULL, "
            "allocated_amount = 0, is_locked = 1, updated_at = ? WHERE id = ?",
            (_now(), layer["id"]),
        )
        _audit(conn, user_id, w["id"], "layer_released", f"layer={layer_number}")


# ═══════════════════════════════════════════════════════════════════════════
# BUDGET PLANS  —  Layer 5
# ═══════════════════════════════════════════════════════════════════════════

def create_plan(user_id: int, mode: str, title: str, description: str = "",
                layer_number: int = None, planned_amount: float = None,
                reporting_interval: int = 30) -> int:
    if not (title or "").strip():
        raise ValueError("title_required")
    if reporting_interval not in (7, 15, 30):
        raise ValueError("invalid_interval")
    if planned_amount is not None and planned_amount < 0:
        raise ValueError("invalid_amount")
    if layer_number is not None and not (1 <= layer_number <= MAX_LAYERS):
        raise ValueError("invalid_layer")

    with _transaction() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        cur = conn.execute(
            "INSERT INTO budget_plans "
            "(wallet_id, title, description, layer_number, planned_amount, "
            " reporting_interval, is_active, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (w["id"], title.strip(), description.strip() or None,
             layer_number, planned_amount, reporting_interval, _now()),
        )
        _audit(conn, user_id, w["id"], "plan_created", f"title={title}")
        return cur.lastrowid


def update_plan(user_id: int, plan_id: int, **fields) -> None:
    """Update title/description/layer_number/planned_amount/reporting_interval."""
    allowed = {"title", "description", "layer_number",
               "planned_amount", "reporting_interval", "is_active"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return

    if "reporting_interval" in updates and updates["reporting_interval"] not in (7, 15, 30):
        raise ValueError("invalid_interval")

    with _transaction() as conn:
        # Ownership check via wallet
        row = conn.execute(
            "SELECT bp.id FROM budget_plans bp "
            "JOIN wallets w ON w.id = bp.wallet_id "
            "WHERE bp.id = ? AND w.user_id = ?",
            (plan_id, user_id),
        ).fetchone()
        if not row:
            raise ValueError("plan_not_found")

        cols = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [plan_id]
        conn.execute(f"UPDATE budget_plans SET {cols} WHERE id = ?", vals)
        _audit(conn, user_id, None, "plan_updated", f"plan={plan_id}")


def delete_plan(user_id: int, plan_id: int) -> None:
    with _transaction() as conn:
        row = conn.execute(
            "SELECT bp.id FROM budget_plans bp "
            "JOIN wallets w ON w.id = bp.wallet_id "
            "WHERE bp.id = ? AND w.user_id = ?",
            (plan_id, user_id),
        ).fetchone()
        if not row:
            raise ValueError("plan_not_found")
        conn.execute("DELETE FROM budget_plans WHERE id = ?", (plan_id,))
        _audit(conn, user_id, None, "plan_deleted", f"plan={plan_id}")


def list_plans(user_id: int, mode: str) -> list:
    with _connect() as conn:
        w = conn.execute(
            "SELECT id FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            return []
        rows = conn.execute(
            "SELECT * FROM budget_plans WHERE wallet_id = ? ORDER BY id DESC",
            (w["id"],),
        ).fetchall()
        return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════════
# BUDGET MATCHING  —  Layer 6 (deterministic, no "AI")
# ═══════════════════════════════════════════════════════════════════════════

def match_plan(purpose: str, plans: list) -> dict:
    """
    Returns:
        {'kind': 'none'}
        {'kind': 'unique',    'plan': {...}}
        {'kind': 'ambiguous','plans': [...]}
    """
    p = _normalize(purpose)
    if not p:
        return {"kind": "none"}

    exact = [pl for pl in plans if _normalize(pl["title"]) == p]
    if len(exact) == 1:
        return {"kind": "unique", "plan": exact[0]}
    if len(exact) > 1:
        return {"kind": "ambiguous", "plans": exact}

    toks = set(p.split())
    subset = [pl for pl in plans
              if toks and toks.issubset(set(_normalize(pl["title"]).split()))]
    if len(subset) == 1:
        return {"kind": "unique", "plan": subset[0]}
    if len(subset) > 1:
        return {"kind": "ambiguous", "plans": subset}

    return {"kind": "none"}


def budget_check(purpose: str, amount: float, plans: list) -> dict:
    """
    Returns:
        {'severity': 'unlinked'|'ambiguous'|'over'|'under'|'on',
         'plan': ..., 'planned': ..., 'diff': ...}
    """
    m = match_plan(purpose, plans)
    if m["kind"] == "ambiguous":
        return {"severity": "ambiguous", "plans": m["plans"]}
    if m["kind"] != "unique":
        return {"severity": "unlinked"}

    plan = m["plan"]
    if plan["planned_amount"] is None:
        return {"severity": "unlinked"}

    planned = float(plan["planned_amount"])
    diff = round(amount - planned, 2)
    sev = "over" if diff > 0 else "under" if diff < 0 else "on"
    return {"severity": sev, "plan": plan, "planned": planned, "diff": diff}


# ═══════════════════════════════════════════════════════════════════════════
# TRANSFERS  —  Layer 4
# ═══════════════════════════════════════════════════════════════════════════

def prepare_transfer(user_id: int, mode: str, recipient: str, purpose: str,
                     source_layer_number: int, amount: float, pin: str) -> dict:
    """
    Validate everything, then return a PENDING transaction dict.
    Does NOT move money. Does NOT issue OTP.

    Raises ValueError with a machine-readable reason.
    """
    recipient = (recipient or "").strip()
    purpose   = (purpose or "").strip()
    pin       = (pin or "").strip()

    if not recipient.isdigit() or not (10 <= len(recipient) <= 15):
        raise ValueError("invalid_recipient")
    if len(purpose) < 2:
        raise ValueError("purpose_required")
    if not (1 <= source_layer_number <= MAX_LAYERS):
        raise ValueError("invalid_layer")
    if amount is None or amount <= 0:
        raise ValueError("invalid_amount")
    if amount < MIN_TRANSFER_CNY:
        raise ValueError("below_minimum")

    # PIN must match the *regular* PIN (transfers never use duplicate)
    u = get_user_by_id(user_id)
    if not u or not _verify_secret(pin, u["pin_hash"]):
        raise ValueError("incorrect_pin")

    with _connect() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        layer = conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? AND layer_number = ?",
            (w["id"], source_layer_number),
        ).fetchone()
        if not layer or not layer["title"]:
            raise ValueError("layer_not_configured")

        spent = conn.execute(
            "SELECT COALESCE(SUM(amount),0) AS s FROM transactions "
            "WHERE wallet_id = ? AND source_layer_number = ? AND status = 'completed'",
            (w["id"], source_layer_number),
        ).fetchone()["s"]
        remaining = layer["allocated_amount"] - spent
        if amount > remaining + 1e-9:
            raise ValueError("insufficient_layer_funds")

        plans = [dict(r) for r in conn.execute(
            "SELECT * FROM budget_plans WHERE wallet_id = ? AND is_active = 1",
            (w["id"],),
        ).fetchall()]

    budget = budget_check(purpose, amount, plans)

    ref = _new_reference()
    return {
        "reference":           ref,
        "wallet_id":           w["id"],
        "user_id":             user_id,
        "mode":                mode,
        "recipient":           recipient,
        "purpose":             purpose,
        "source_layer_number": source_layer_number,
        "amount":              round(amount, 2),
        "budget":              budget,
    }


def create_pending_transaction(pending: dict) -> None:
    """Persist the pending transfer so it can be resumed after OTP."""
    with _transaction() as conn:
        b = pending["budget"]
        plan_id = b["plan"]["id"] if b.get("severity") in ("over", "under", "on") else None
        planned = b.get("planned")
        diff    = b.get("diff")

        conn.execute(
            "INSERT INTO transactions "
            "(reference, wallet_id, purpose, amount, source_layer_number, "
            " recipient_phone, status, budget_plan_id, planned_amount_snap, "
            " budget_difference, is_demo, is_seed, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1, 0, ?)",
            (pending["reference"], pending["wallet_id"], pending["purpose"],
             pending["amount"], pending["source_layer_number"],
             pending["recipient"], plan_id, planned, diff, _now()),
        )
        _audit(conn, pending["user_id"], pending["wallet_id"],
               "txn_pending", pending["reference"])


def finalize_transfer(user_id: int, reference: str) -> dict:
    """
    Move money. Called ONLY after OTP verification succeeded.
    Re-validates balances inside the transaction; refuses if insufficient.
    """
    with _transaction() as conn:
        txn = conn.execute(
            "SELECT * FROM transactions WHERE reference = ? AND status = 'pending'",
            (reference,),
        ).fetchone()
        if not txn:
            raise ValueError("pending_not_found")

        w = conn.execute(
            "SELECT * FROM wallets WHERE id = ? AND user_id = ?",
            (txn["wallet_id"], user_id),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        layer = conn.execute(
            "SELECT * FROM money_layers WHERE wallet_id = ? AND layer_number = ?",
            (w["id"], txn["source_layer_number"]),
        ).fetchone()
        if not layer or not layer["title"]:
            raise ValueError("layer_not_configured")

        spent = conn.execute(
            "SELECT COALESCE(SUM(amount),0) AS s FROM transactions "
            "WHERE wallet_id = ? AND source_layer_number = ? AND status = 'completed'",
            (w["id"], txn["source_layer_number"]),
        ).fetchone()["s"]
        remaining = layer["allocated_amount"] - spent
        if txn["amount"] > remaining + 1e-9:
            conn.execute(
                "UPDATE transactions SET status = 'failed' WHERE id = ?",
                (txn["id"],),
            )
            _audit(conn, user_id, w["id"], "txn_failed_insufficient", reference)
            raise ValueError("insufficient_layer_funds")

        conn.execute(
            "UPDATE transactions SET status = 'completed' WHERE id = ?",
            (txn["id"],),
        )
        _audit(conn, user_id, w["id"], "txn_completed", reference)

        return dict(conn.execute(
            "SELECT * FROM transactions WHERE id = ?", (txn["id"],)
        ).fetchone())


def cancel_pending_transaction(user_id: int, reference: str) -> None:
    with _transaction() as conn:
        conn.execute(
            "UPDATE transactions SET status = 'cancelled' "
            "WHERE reference = ? AND status = 'pending'",
            (reference,),
        )
        _audit(conn, user_id, None, "txn_cancelled", reference)


# ═══════════════════════════════════════════════════════════════════════════
# HISTORY  —  Layer 6D
# ═══════════════════════════════════════════════════════════════════════════

def list_transactions(user_id: int, mode: str, limit: int = 200) -> list:
    with _connect() as conn:
        w = conn.execute(
            "SELECT id FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            return []
        rows = conn.execute(
            "SELECT * FROM transactions WHERE wallet_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (w["id"], limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════════
# INSIGHTS  —  Layer 6E
# ═══════════════════════════════════════════════════════════════════════════

def spending_report(user_id: int, mode: str, period_days: int = 30) -> dict:
    """Return aggregated spending for the given window."""
    if period_days not in (7, 15, 30):
        raise ValueError("invalid_period")

    cutoff = _iso(datetime.utcnow() - timedelta(days=period_days))

    with _connect() as conn:
        w = conn.execute(
            "SELECT * FROM wallets WHERE user_id = ? AND mode = ?",
            (user_id, mode),
        ).fetchone()
        if not w:
            raise ValueError("wallet_not_found")

        txns = [dict(r) for r in conn.execute(
            "SELECT * FROM transactions "
            "WHERE wallet_id = ? AND status = 'completed' AND created_at >= ? "
            "ORDER BY created_at DESC",
            (w["id"], cutoff),
        ).fetchall()]

        plans = [dict(r) for r in conn.execute(
            "SELECT * FROM budget_plans WHERE wallet_id = ? AND is_active = 1",
            (w["id"],),
        ).fetchall()]

    total_spent = round(sum(t["amount"] for t in txns), 2)
    planned_total = round(sum(
        float(p["planned_amount"]) for p in plans if p["planned_amount"] is not None
    ), 2)

    by_layer = {}
    for t in txns:
        by_layer[t["source_layer_number"]] = round(
            by_layer.get(t["source_layer_number"], 0) + t["amount"], 2
        )

    over  = [t for t in txns if t["budget_difference"] is not None and t["budget_difference"] > 0]
    under = [t for t in txns if t["budget_difference"] is not None and t["budget_difference"] < 0]
    unplanned = [t for t in txns if t["planned_amount_snap"] is None]

    highest = sorted(by_layer.items(), key=lambda kv: -kv[1])[:1]

    return {
        "period_days":      period_days,
        "total_spent":      total_spent,
        "planned_total":    planned_total,
        "remaining_budget": round(planned_total - total_spent, 2),
        "by_layer":         by_layer,
        "over_budget":      over,
        "under_budget":     under,
        "unplanned":        unplanned,
        "highest_layer":    highest[0] if highest else None,
        "transactions":     txns,
    }


# ═══════════════════════════════════════════════════════════════════════════
# SEED DATA  —  sandbox-only fictional history
# ═══════════════════════════════════════════════════════════════════════════

def _seed_sandbox_transactions(conn, wallet_id: int):
    """
    Insert 5 clearly-labelled fictional transactions, dated relative to now.
    Runs INSIDE the caller's transaction. Never touches balance.
    """
    seeds = [
        ("Netflix Subscription", 500,  4, 1),
        ("Food Delivery",        250,  8, 2),
        ("Mobile Recharge",      100,  2, 3),
        ("Shopping",             700,  11, 4),
        ("Monthly Savings",     1000, 12, 5),
    ]
    for i, (purpose, amount, layer, days_ago) in enumerate(seeds):
        ref = f"DEMO-SEED-{1000 + i}"
        ts  = _iso(datetime.utcnow() - timedelta(days=days_ago))
        conn.execute(
            "INSERT INTO transactions "
            "(reference, wallet_id, purpose, amount, source_layer_number, "
            " recipient_phone, status, is_demo, is_seed, created_at) "
            "VALUES (?, ?, ?, ?, ?, '01XXXXXXXXX', 'completed', 1, 1, ?)",
            (ref, wallet_id, purpose, amount, layer, ts),
        )


def seed_demo_account():
    """
    Create a demo account for hackathon judges:
        phone: 01700000000
        PIN:   1234
        DupPIN: 4545
    Idempotent — will not duplicate if it already exists.
    """
    if get_user_by_phone("01700000000"):
        return
    uid = create_user(
        full_name="Demo User",
        phone="01700000000",
        fav_sentence="my first pet",
        pin="1234",
        backup_phone=None,
    )
    set_duplicate_pin(uid, regular_pin="1234", duplicate_pin="4545")
    # Configure a few layers so the demo starts with structure
    allocate_to_layer(uid, "normal", 4, "Netflix Subscription", 500, "Monthly subscription")
    allocate_to_layer(uid, "normal", 8, "Food Delivery", 1500, "Weekly food budget")
    allocate_to_layer(uid, "normal", 12, "Emergency Savings", 3000, "Slowly build up")
    create_plan(uid, "normal", "Netflix Subscription", "Streaming", 4, 500, 30)
    create_plan(uid, "normal", "Food Delivery", "Weekly food", 8, 1500, 7)


# ═══════════════════════════════════════════════════════════════════════════
# SELF-TEST  —  run: python database.py
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import pprint
    import sys

    # Clean slate for the test
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    print("== init_db + seed_demo ==")
    init_db(seed_demo=True)

    print("\n== authenticate (regular PIN) ==")
    r = authenticate("01700000000", "1234")
    print(r)
    assert r["ok"] and r["mode"] == "normal"

    print("\n== authenticate (duplicate PIN -> sandbox) ==")
    r = authenticate("01700000000", "4545")
    print(r)
    assert r["ok"] and r["mode"] == "sandbox"

    print("\n== authenticate (wrong PIN) ==")
    r = authenticate("01700000000", "9999")
    print(r)
    assert not r["ok"]

    uid = get_user_by_phone("01700000000")["id"]

    print("\n== wallet summary (normal) ==")
    s = get_wallet_summary(uid, "normal")
    print("balance", s["balance"], "allocated", s["allocated"], "unallocated", s["unallocated"])
    assert s["balance"] == 10000
    assert s["allocated"] == 5000

    print("\n== wallet summary (sandbox) ==")
    s = get_wallet_summary(uid, "sandbox")
    print("sandbox balance", s["balance"])
    assert s["balance"] == 1

    print("\n== send below minimum ==")
    try:
        prepare_transfer(uid, "normal", "01711111111", "Netflix Subscription",
                         4, 10, "1234")
        print("ERROR: should have raised")
    except ValueError as e:
        print("rejected:", e)
        assert str(e) == "below_minimum"

    print("\n== prepare transfer ¥1000 on plan ¥500 ==")
    pending = prepare_transfer(uid, "normal", "01711111111", "Netflix Subscription",
                               4, 1000, "1234")
    print("budget:", pending["budget"]["severity"], pending["budget"]["diff"])
    assert pending["budget"]["severity"] == "over"
    assert pending["budget"]["diff"] == 500

    create_pending_transaction(pending)

    print("\n== OTP issue + verify ==")
    code = issue_otp(uid, "transaction", pending["reference"])
    print("demo OTP:", code)
    assert verify_otp(uid, "transaction", code)

    print("\n== finalize transfer ==")
    t = finalize_transfer(uid, pending["reference"])
    print("status:", t["status"], "amount:", t["amount"])
    assert t["status"] == "completed"

    print("\n== layer remaining after transfer ==")
    s = get_wallet_summary(uid, "normal")
    l4 = [l for l in s["layers"] if l["layer_number"] == 4][0]
    print("layer 4 remaining:", l4["remaining"])
    assert l4["remaining"] == 0  # allocated 500, spent 500

    print("\n== spending report ==")
    rep = spending_report(uid, "normal", 30)
    print("total spent:", rep["total_spent"])
    print("over-budget:", len(rep["over_budget"]))
    print("unplanned:", len(rep["unplanned"]))
    assert rep["total_spent"] == 1000

    print("\n== sandbox isolation ==")
    s_sandbox = get_wallet_summary(uid, "sandbox")
    print("sandbox balance:", s_sandbox["balance"])
    assert s_sandbox["balance"] == 1
    assert len([t for t in list_transactions(uid, "sandbox") if not t["is_seed"]]) == 0

    print("\n== audit log ==")
    with _connect() as conn:
        rows = conn.execute("SELECT event FROM audit_events ORDER BY id").fetchall()
        print([r["event"] for r in rows])

    print("\n✅ All self-tests passed.")
