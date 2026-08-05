"""Manual, emergency restore of the Vaultwarden SQLite database from an S3 snapshot.

Lives in the same asset directory as index.py (the nightly backup job) and imports
validate_snapshot from it rather than duplicating it -- there must be exactly one
place that decides whether a snapshot is trustworthy.

This function is never scheduled. It is invoked by a human, with two possible
payloads:

    {"action": "list"}
        Returns up to DEFAULT_LIST_LIMIT backup object keys, newest first, so the
        operator can choose one without needing S3 console access.

    {"action": "restore", "key": "db/<timestamp>.sqlite3.gz", "confirm": "OVERWRITE-VAULT"}
        Performs the restore. See execute_restore for the ordering, which is the
        entire safety story: validate before touching the live database, preserve
        the live database before overwriting it, and swap the new file into place
        atomically so a crash mid-restore can never leave a half-written database at
        the live path.

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
import tempfile
from datetime import datetime, timezone

import boto3

from index import validate_snapshot

DB_PATH = os.environ.get("DB_PATH", "/mnt/data/db.sqlite3")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")
APP_FUNCTION_NAME = os.environ.get("APP_FUNCTION_NAME", "vaultwarden")

CONFIRM_PHRASE = "OVERWRITE-VAULT"
DEFAULT_LIST_LIMIT = 20

_s3 = boto3.client("s3")


def _lambda_client():
    # Created lazily, unlike _s3 above: boto3's Lambda client requires a resolvable
    # region at construction time (S3 falls back to a global endpoint), and the
    # Lambda runtime only sets AWS_REGION for an actual invocation. Constructing
    # this eagerly at import time would make `import restore` fail outside Lambda
    # -- including during local test collection.
    return boto3.client("lambda")


class RestoreNotConfirmedError(Exception):
    """Raised when a restore is attempted without the exact confirmation phrase."""


class ApplicationNotStoppedError(Exception):
    """Raised when the application function's reserved concurrency is not 0."""


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
    to it. Callers may bypass this one check by passing {"force": true} in the
    restore event -- documented as dangerous in the README: it exists only so a
    broken concurrency check cannot itself block an emergency restore, not as a
    routine option. Bypassing it has a second, quieter cost too: execute_restore's
    preserve_current_database step relies on this check having passed to assume its
    plain file copy of the outgoing database is consistent -- see the comment at
    that call site.
    """
    response = lambda_client.get_function_concurrency(FunctionName=function_name)
    reserved = response.get("ReservedConcurrentExecutions")
    if reserved != 0:
        raise ApplicationNotStoppedError(
            f"{function_name!r} reserved concurrency is {reserved!r}, not 0 -- set it "
            'to 0 before restoring (aws lambda put-function-concurrency), or pass '
            '{"force": true} to bypass this check. Bypassing is dangerous: '
            "Vaultwarden may still be writing to the database mid-restore."
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
    replaced is never simply discarded, it is renamed-and-kept alongside it.

    This is a plain file copy (shutil.copy2), not the SQLite online-backup API
    index.py's snapshot_database uses for the nightly job. That is safe here only
    because the caller (execute_restore) is expected to have already confirmed
    nothing is writing to db_path -- see the comment at its call site below for the
    one case (a "force"d restore) where that assumption does not hold.
    """
    if not os.path.exists(db_path):
        return None

    preserved_path = f"{db_path}.preserved-{now.strftime('%Y-%m-%dT%H-%M-%SZ')}"
    shutil.copy2(db_path, preserved_path)
    return preserved_path


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
    2. Refuse unless the application is stopped (unless force-bypassed).
    3. Download and decompress the requested snapshot to /tmp.
    4. Validate the DOWNLOADED snapshot before touching the live database.
    5. Preserve the current live database.
    6. Atomically replace the live database with the validated snapshot.

    Nothing under DB_PATH is touched until step 4 has passed. If validate_snapshot
    raises, this function raises too, and neither step 5 nor step 6 ever runs.
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

        # preserve_current_database uses a plain file copy, which is only a
        # guaranteed-consistent snapshot of DB_PATH because assert_application_stopped
        # above (unless bypassed with "force") already established that nothing is
        # writing to it. "force" skips that check entirely -- so a forced restore
        # performed while Vaultwarden genuinely is still writing can produce a
        # preserved copy that is itself torn/inconsistent, even though the live
        # database ends up fine either way (atomic_replace's os.replace swap below is
        # unconditional). Do not treat "preserved" as a reliable undo path when the
        # restore was forced.
        preserved_path = preserve_current_database(DB_PATH, datetime.now(timezone.utc))
        bytes_written = atomic_replace(snapshot_path, DB_PATH)

    return {
        "status": "ok",
        "key": key,
        "bytes": bytes_written,
        "preserved": preserved_path,
    }


def handler(event, context):  # noqa: ARG001 - Lambda signature
    action = event.get("action")

    if action == "list":
        return {"status": "ok", "keys": list_recent_backups(_s3, BUCKET_NAME)}

    if action == "restore":
        return execute_restore(event, _s3, _lambda_client())

    raise ValueError(f"unknown action {action!r} -- expected 'list' or 'restore'")
