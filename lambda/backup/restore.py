"""Manual, emergency restore of the Vaultwarden SQLite database from an S3 snapshot.

Lives in the same asset directory as index.py (the nightly backup job) and imports
validate_snapshot from it rather than duplicating it -- there must be exactly one
place that decides whether a snapshot is trustworthy.

This function is never scheduled. It is invoked by a human, with two possible
payloads:

    {"action": "list"}
        Returns up to DEFAULT_LIST_LIMIT backup object keys, newest first, so the
        operator can choose one without needing S3 console access.

    {"action": "restore", "key": "db/<timestamp>.sqlite3.gz",
     "confirm": "OVERWRITE-VAULT", "force": true}
        Performs the restore. See execute_restore for the ordering, which is the
        entire safety story: validate before touching the live database, preserve
        the live database before overwriting it, swap the new file into place
        atomically so a crash mid-restore can never leave a half-written database at
        the live path, and clear the old database's SQLite sidecar files afterwards.

        "force": true is part of the normal payload, not an escape hatch, because
        the concurrency pre-check cannot run from this VPC -- see
        assert_application_stopped for why, and README §7 for the operator
        procedure that replaces it (stop the application and verify it yourself
        first). It is safe to force: the preserved copy of the outgoing database
        is taken with SQLite's online backup API, which does not depend on writers
        being stopped.

Unlike index.py, this function's IAM role is granted read access to the backup
bucket (s3:GetObject, s3:ListBucket via grantRead in lib/constructs/backup.ts). That
is deliberate and does not weaken the backup role's write-only property: they are
two separate functions with two separate roles. A compromised backup role still
cannot read or delete historical snapshots; only this function's role can, and this
function is never invoked automatically.
"""

import gzip
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone

import boto3
import botocore.exceptions
from botocore.config import Config

from index import snapshot_database, validate_snapshot

DB_PATH = os.environ.get("DB_PATH", "/mnt/data/db.sqlite3")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")
APP_FUNCTION_NAME = os.environ.get("APP_FUNCTION_NAME", "vaultwarden")

CONFIRM_PHRASE = "OVERWRITE-VAULT"
DEFAULT_LIST_LIMIT = 20

# SQLite's sidecar files. Only "-journal" can exist in this deployment
# (ENABLE_DB_WAL is false, so the database runs in rollback-journal mode), but
# all three are handled: they are all bound to the *directory entry*, not to the
# database file's contents, so any of them left beside a freshly restored
# database would be applied to it. See clear_sidecar_files.
SIDECAR_SUFFIXES = ("-journal", "-wal", "-shm")

_s3 = boto3.client("s3")

# get_function_concurrency is a Lambda *control-plane* call, and this function
# runs in PRIVATE_ISOLATED subnets of a VPC with natGateways: 0 whose only
# endpoint is the S3 gateway endpoint. lambda.<region>.amazonaws.com resolves
# but is not routable, so the connection is black-holed rather than refused.
# With botocore's defaults (60 s connect timeout, 5 total attempts) that is up to
# five minutes of silence during an emergency. These settings bound it to a few
# seconds and an actionable error -- see assert_application_stopped.
#
# Note on retries: in botocore's legacy retry mode "max_attempts" counts RETRIES,
# not attempts (botocore/args.py: total_max_attempts = max_attempts + 1), so this
# resolves to two attempts and a worst case of roughly six seconds rather than
# three. That is the intended order of magnitude; the point is that it fails while
# the operator is still looking at the terminal.
_LAMBDA_CLIENT_CONFIG = Config(
    connect_timeout=3,
    read_timeout=3,
    retries={"max_attempts": 1},
)


def _lambda_client():
    # Created lazily, unlike _s3 above: boto3's Lambda client requires a resolvable
    # region at construction time (S3 falls back to a global endpoint), and the
    # Lambda runtime only sets AWS_REGION for an actual invocation. Constructing
    # this eagerly at import time would make `import restore` fail outside Lambda
    # -- including during local test collection.
    return boto3.client("lambda", config=_LAMBDA_CLIENT_CONFIG)


class RestoreNotConfirmedError(Exception):
    """Raised when a restore is attempted without the exact confirmation phrase."""


class ApplicationNotStoppedError(Exception):
    """Raised when the application function's reserved concurrency is not 0."""


class ConcurrencyCheckUnreachableError(Exception):
    """Raised when the Lambda control plane cannot be reached to run the check.

    Expected in the deployed configuration -- see assert_application_stopped.
    """


def require_confirmation(event: dict) -> None:
    """Raise RestoreNotConfirmedError unless event["confirm"] is exactly the phrase.

    This is the first thing execute_restore checks, before anything else runs. A
    restore destroys the current vault; it must never happen from a stray or
    malformed invocation.
    """
    if event.get("confirm") != CONFIRM_PHRASE:
        raise RestoreNotConfirmedError(
            f"restore requires event['confirm'] == {CONFIRM_PHRASE!r}; got "
            f"{event.get('confirm')!r}"
        )


def assert_application_stopped(lambda_client, function_name: str) -> None:
    """Raise ApplicationNotStoppedError unless `function_name`'s reserved
    concurrency is exactly 0.

    Guards against restoring the database while Vaultwarden might still be writing
    to it.

    **This check cannot succeed in the deployed configuration, by design.**
    get_function_concurrency is a Lambda control-plane call; this function runs in
    an isolated subnet whose VPC has no NAT gateway and exactly one endpoint (the
    free S3 gateway endpoint). Adding an interface endpoint for Lambda would cost
    $7.30/month against a stack that costs about $0.18/month, so it is not there
    and will not be. The call is therefore black-holed and raises a botocore
    connection error, which is translated below into an explicit instruction
    rather than a stack trace.

    The check is kept rather than deleted because it is correct code: it works if
    this module is run outside the VPC, and it would start working if AWS
    networking ever changed. What it must never do is hang for minutes and then
    fail with something unreadable, in the middle of an emergency.
    """
    try:
        response = lambda_client.get_function_concurrency(FunctionName=function_name)
    except botocore.exceptions.ConnectionError as exc:
        raise ConcurrencyCheckUnreachableError(
            "cannot reach the Lambda control plane to verify that "
            f"{function_name!r} is stopped. This is expected: this function runs in an "
            "isolated subnet with no NAT gateway and only an S3 gateway endpoint, so "
            "lambda.<region>.amazonaws.com is not routable from here, and adding an "
            "interface VPC endpoint for it would cost more per month than the entire "
            "stack. Verify it yourself from your own machine:\n"
            f"    aws lambda put-function-concurrency --function-name {function_name} "
            "--reserved-concurrent-executions 0\n"
            f"    aws lambda get-function-concurrency --function-name {function_name}\n"
            "and once that reports 0, re-invoke this function with \"force\": true in "
            "the payload to skip this unreachable check. The preserved copy of the "
            "outgoing database is taken with SQLite's online backup API, so it stays "
            "consistent whether or not anything is still writing -- \"force\" does not "
            f"weaken it. Underlying error: {exc}"
        ) from exc

    reserved = response.get("ReservedConcurrentExecutions")
    if reserved != 0:
        raise ApplicationNotStoppedError(
            f"{function_name!r} reserved concurrency is {reserved!r}, not 0 -- set it "
            'to 0 before restoring (aws lambda put-function-concurrency), or pass '
            '{"force": true} to bypass this check. Bypassing it means Vaultwarden may '
            "still be writing to the database mid-restore."
        )


def list_recent_backups(s3_client, bucket: str, limit: int = DEFAULT_LIST_LIMIT) -> list:
    """Return up to `limit` backup object keys under db/, newest first.

    index.py's backup_key() produces keys whose lexical order matches chronological
    order, so a plain reverse sort is sufficient -- no timestamp parsing needed.
    """
    response = s3_client.list_objects_v2(Bucket=bucket, Prefix="db/")
    keys = [obj["Key"] for obj in response.get("Contents", [])]
    return sorted(keys, reverse=True)[:limit]


def download_snapshot(s3_client, bucket: str, key: str, workdir: str) -> str:
    """Download the gzip snapshot at `key` into workdir and decompress it.

    Returns the path to the decompressed (but not yet validated) file. Downloading
    to /tmp rather than directly to EFS is deliberate: nothing under
    /mnt/data changes until validate_snapshot has passed.
    """
    archive_path = os.path.join(workdir, "snapshot.sqlite3.gz")
    snapshot_path = os.path.join(workdir, "snapshot.sqlite3")
    s3_client.download_file(bucket, key, archive_path)
    with gzip.open(archive_path, "rb") as src, open(snapshot_path, "wb") as dest:
        shutil.copyfileobj(src, dest)
    return snapshot_path


def preserve_current_database(db_path: str, now: datetime) -> str | None:
    """If a live database exists at db_path, copy it aside to a timestamped path
    before it is overwritten, and return that path. Returns None if there is
    nothing to preserve (e.g. a restore performed before any login ever created a
    database).

    This is the safety net for restoring the wrong backup: the database being
    replaced is never simply discarded, it is copied-and-kept alongside it.

    The copy is taken with the SQLite online backup API (index.py's
    snapshot_database, the same one the nightly job uses), not shutil.copy2. That
    matters because the only usable restore path in the deployed configuration is
    "force": true -- the concurrency check it bypasses cannot run from an isolated
    subnet (see assert_application_stopped). A plain byte copy would only be a
    consistent snapshot if something had already established that nothing is
    writing, which under "force" nothing has. The backup API needs no such
    assumption: it takes a consistent copy with writers active, and it applies any
    hot rollback journal on the way, so the preserved file is a real undo path
    rather than a possibly-torn one.

    Fallback: if the live database is not something SQLite can open at all -- a
    truncated or garbage file, which is one of the reasons an operator would be
    restoring in the first place -- there is no consistent snapshot to be had, and
    refusing to continue would block the restore exactly when it is needed most.
    In that case the bytes are preserved verbatim under a `.preserved-raw-` name.
    That artefact is for forensics, not for undo: it was already not a working
    database before this function touched it.
    """
    if not os.path.exists(db_path):
        return None

    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    preserved_path = f"{db_path}.preserved-{stamp}"
    try:
        snapshot_database(db_path, preserved_path)
    except sqlite3.Error:
        if os.path.exists(preserved_path):
            os.remove(preserved_path)
        preserved_path = f"{db_path}.preserved-raw-{stamp}"
        shutil.copy2(db_path, preserved_path)

    return preserved_path


def clear_sidecar_files(db_path: str, now: datetime) -> list:
    """Move any SQLite sidecar files beside db_path out of the way. Returns the
    list of paths they were moved to (empty if there were none).

    Called immediately after the restored database is swapped into place, and it
    is not optional. A rollback journal is bound to a *path*, not to the contents
    of the database that produced it: SQLite finds `<db>-journal` beside `<db>` on
    the next open, decides it is a hot journal left by a crashed writer, and rolls
    its pages back into whatever database is at that path now. With
    ENABLE_DB_WAL=false this deployment runs in rollback-journal mode, so
    `db.sqlite3-journal` exists whenever a transaction is in flight -- including
    when an execution environment is reclaimed mid-write, which is exactly the
    class of event that makes someone restore. Leaving it behind would let stale
    pages from the *old* database corrupt the *restored* one, seconds after it
    validated as sound.

    The files are renamed rather than deleted, so the state that led to the
    restore can still be examined. The new names deliberately do not end in a
    sidecar suffix: naming the moved journal `<preserved-copy>-journal` would
    simply recreate the same hazard next to the preserved copy.
    """
    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    moved = []
    for suffix in SIDECAR_SUFFIXES:
        stale_path = f"{db_path}.stale{suffix}.{stamp}"
        try:
            os.replace(f"{db_path}{suffix}", stale_path)
        except FileNotFoundError:
            continue
        moved.append(stale_path)
    return moved


def atomic_replace(src_path: str, dest_path: str) -> int:
    """Put src_path into place at dest_path atomically. Returns the final file's
    size in bytes.

    Copies src_path into a temporary file in dest_path's own directory -- the same
    EFS filesystem, not /tmp -- rather than writing dest_path directly, then uses
    os.replace to swap it into place: a single atomic rename on a POSIX filesystem.
    A crash or error at any point before os.replace leaves the previous database at
    dest_path untouched; a crash after leaves the new one. There is no window in
    which dest_path is a half-written file.
    """
    dest_dir = os.path.dirname(dest_path) or "."
    fd, tmp_path = tempfile.mkstemp(dir=dest_dir, prefix=".restore-", suffix=".sqlite3")
    try:
        with os.fdopen(fd, "wb") as tmp_file, open(src_path, "rb") as src_file:
            shutil.copyfileobj(src_file, tmp_file)
            tmp_file.flush()
            os.fsync(tmp_file.fileno())
        os.replace(tmp_path, dest_path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    return os.path.getsize(dest_path)


def execute_restore(event: dict, s3_client, lambda_client) -> dict:
    """Perform a restore. This function's statement order IS the safety story:

    1. Refuse unless confirmed.
    2. Refuse unless the application is stopped (unless force-bypassed; note that
       in the deployed configuration this check is unreachable and "force" is the
       normal path -- see assert_application_stopped).
    3. Download and decompress the requested snapshot to /tmp.
    4. Validate the DOWNLOADED snapshot before touching the live database.
    5. Preserve the current live database (SQLite online backup, consistent
       regardless of writers).
    6. Atomically replace the live database with the validated snapshot.
    7. Move the old database's SQLite sidecar files out of the way, so none of
       them is applied to the restored database on its next open.

    Nothing under DB_PATH is touched until step 4 has passed. If validate_snapshot
    raises, this function raises too, and steps 5-7 never run.
    """
    require_confirmation(event)

    key = event.get("key")
    if not key:
        raise ValueError("restore requires event['key'] naming the backup object to restore")

    if not event.get("force"):
        assert_application_stopped(lambda_client, APP_FUNCTION_NAME)

    with tempfile.TemporaryDirectory() as workdir:
        snapshot_path = download_snapshot(s3_client, BUCKET_NAME, key, workdir)

        # Validate the DOWNLOADED snapshot before touching the live database.
        # Restoring a corrupt backup over a working vault would turn a recoverable
        # situation into an unrecoverable one.
        validate_snapshot(snapshot_path)

        now = datetime.now(timezone.utc)
        preserved_path = preserve_current_database(DB_PATH, now)
        bytes_written = atomic_replace(snapshot_path, DB_PATH)
        # After the swap, never before: until the new database is in place, a
        # hot journal beside DB_PATH still belongs to the database at DB_PATH and
        # is the only thing that can roll it back to a consistent state.
        stale_sidecars = clear_sidecar_files(DB_PATH, now)

    return {
        "status": "ok",
        "key": key,
        "bytes": bytes_written,
        "preserved": preserved_path,
        "stale_sidecars": stale_sidecars,
    }


def handler(event, context):  # noqa: ARG001 - Lambda signature
    action = event.get("action")

    if action == "list":
        return {"status": "ok", "keys": list_recent_backups(_s3, BUCKET_NAME)}

    if action == "restore":
        return execute_restore(event, _s3, _lambda_client())

    raise ValueError(f"unknown action {action!r} -- expected 'list' or 'restore'")
