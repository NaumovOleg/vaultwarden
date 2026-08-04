"""Nightly consistent backup of the Vaultwarden SQLite database to S3.

Uses SQLite's online backup API rather than copying the file. A copy taken while
Vaultwarden is mid-write yields a torn, unusable database; the backup API
produces a consistent snapshot without stopping writers.
"""

import gzip
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone

import boto3

DB_PATH = os.environ.get("DB_PATH", "/mnt/data/db.sqlite3")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")

_s3 = boto3.client("s3")


class InvalidSnapshotError(Exception):
    """Raised when a database snapshot fails validation and must not be uploaded."""


def snapshot_database(db_path: str, dest_path: str) -> int:
    """Write a consistent copy of the database to dest_path. Returns bytes written."""
    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)

    source = sqlite3.connect(db_path)
    try:
        dest = sqlite3.connect(dest_path)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()

    return os.path.getsize(dest_path)


def validate_snapshot(path: str) -> None:
    """Raise InvalidSnapshotError unless `path` is a structurally sound, non-empty database.

    Deliberately schema-agnostic: it does not look for specific Vaultwarden tables (e.g.
    `ciphers`), because those are upstream schema details that can change across Vaultwarden
    releases -- hardcoding them would turn a Vaultwarden upgrade into a silent backup outage,
    the same class of failure this function exists to catch. Instead it checks two properties
    that hold for any valid, populated SQLite database regardless of application schema:
    the file passes `PRAGMA integrity_check`, and it contains at least one schema object (a
    zero-length or truncated file opens without error but has none).
    """
    conn = sqlite3.connect(path)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise InvalidSnapshotError(f"snapshot failed integrity_check: {integrity}")

        object_count = conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
        if object_count == 0:
            raise InvalidSnapshotError(
                "snapshot has no schema objects -- source database is empty or truncated"
            )
    finally:
        conn.close()


def compress(src_path: str, dest_path: str) -> int:
    """Gzip src_path to dest_path. Returns the compressed size in bytes."""
    with open(src_path, "rb") as raw, gzip.open(dest_path, "wb") as archive:
        shutil.copyfileobj(raw, archive)
    return os.path.getsize(dest_path)


def backup_key(now: datetime) -> str:
    """S3 key for a backup taken at `now`. Lexical order matches chronological order."""
    return f"db/{now.strftime('%Y-%m-%dT%H-%M-%SZ')}.sqlite3.gz"


def handler(event, context):  # noqa: ARG001 - Lambda signature
    if not os.path.exists(DB_PATH):
        # Expected between stack creation and first login.
        return {"status": "skipped", "reason": "database does not exist yet"}

    key = backup_key(datetime.now(timezone.utc))

    # Lambda gives every invocation 512 MB of writable /tmp at no cost.
    with tempfile.TemporaryDirectory() as workdir:
        snapshot = os.path.join(workdir, "snapshot.sqlite3")
        archive = snapshot + ".gz"

        raw_size = snapshot_database(DB_PATH, snapshot)
        validate_snapshot(snapshot)
        gz_size = compress(snapshot, archive)
        _s3.upload_file(archive, BUCKET_NAME, key)

    return {"status": "ok", "key": key, "bytes": raw_size, "compressed": gz_size}
