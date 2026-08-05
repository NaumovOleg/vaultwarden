"""Nightly consistent backup of the Vaultwarden SQLite database to S3.

Uses SQLite's online backup API rather than copying the file. A copy taken while
Vaultwarden is mid-write yields a torn, unusable database; the backup API
produces a consistent snapshot without stopping writers.
"""

import gzip
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone

import boto3

METRIC_NAMESPACE = "Vaultwarden"

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


def emit_snapshot_size_metric(raw_size: int, gz_size: int, key: str, now: datetime) -> dict:
    """Emit the snapshot's uncompressed byte size as a CloudWatch metric, and
    return the log record that carries it.

    This closes the one hole validate_snapshot structurally cannot: a
    freshly-migrated Vaultwarden database -- the state after anything that swaps
    the EFS filesystem, or after an erroneous restore -- has a complete schema and
    zero users, so it passes both `PRAGMA integrity_check` and the non-empty
    `sqlite_master` check. Ninety nightly uploads later, every snapshot that
    contained the real vault has expired under the bucket's lifecycle rule, and
    nothing anywhere reported a problem.

    Checking for Vaultwarden's own table names would catch it, but that couples
    this job to upstream's schema and turns a Vaultwarden upgrade into a silent
    backup outage -- the same class of failure it would be trying to prevent. Size
    is the schema-agnostic proxy: an empty vault is a few tens of KB, a real one
    is not, and a real one does not shrink. This function only publishes the
    number; no alarm is created here, because a threshold picked at deploy time --
    before any data exists -- would be pure noise. README §7 documents how to add
    one once the vault's normal size is known.

    Uses CloudWatch Embedded Metric Format: a single structured line on stdout
    that the Logs agent extracts into a metric. No new AWS resources, and one
    custom metric sits inside the always-free 10.
    """
    record = {
        "_aws": {
            "Timestamp": int(now.timestamp() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": METRIC_NAMESPACE,
                # No dimensions: one vault, one metric. Dimensions would multiply
                # the custom-metric count for no added signal.
                "Dimensions": [[]],
                "Metrics": [{"Name": "SnapshotBytes", "Unit": "Bytes"}],
            }],
        },
        "SnapshotBytes": raw_size,
        # Deliberately a plain property, not a second metric: useful context when
        # reading the log, but not worth another billable custom metric.
        "compressedBytes": gz_size,
        "key": key,
    }
    print(json.dumps(record))
    return record


def backup_key(now: datetime) -> str:
    """S3 key for a backup taken at `now`. Lexical order matches chronological order."""
    return f"db/{now.strftime('%Y-%m-%dT%H-%M-%SZ')}.sqlite3.gz"


def handler(event, context):  # noqa: ARG001 - Lambda signature
    if not os.path.exists(DB_PATH):
        # Expected between stack creation and first login.
        return {"status": "skipped", "reason": "database does not exist yet"}

    now = datetime.now(timezone.utc)
    key = backup_key(now)

    # Lambda gives every invocation 512 MB of writable /tmp at no cost.
    with tempfile.TemporaryDirectory() as workdir:
        snapshot = os.path.join(workdir, "snapshot.sqlite3")
        archive = snapshot + ".gz"

        raw_size = snapshot_database(DB_PATH, snapshot)
        validate_snapshot(snapshot)
        gz_size = compress(snapshot, archive)
        _s3.upload_file(archive, BUCKET_NAME, key)

    # After the upload, so the metric only ever describes a snapshot that is
    # actually in the bucket. See the function's docstring for what this catches
    # that validate_snapshot cannot.
    emit_snapshot_size_metric(raw_size, gz_size, key, now)

    return {"status": "ok", "key": key, "bytes": raw_size, "compressed": gz_size}
