import gzip
import os
import shutil
import sqlite3
from datetime import datetime, timezone

import botocore.exceptions
import pytest

import index
import restore


def make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE ciphers (id INTEGER PRIMARY KEY, data TEXT)")
    conn.executemany("INSERT INTO ciphers (data) VALUES (?)", [(f"row-{i}",) for i in range(100)])
    conn.commit()
    conn.close()


class FakeS3Client:
    """Stands in for boto3's S3 client so restore.py's S3-touching helpers can be
    tested without botocore, moto, or network access -- the same reasoning
    test_index.py uses for keeping AWS out of its own assertions. Records every
    call so tests can assert whether S3 was even reached.
    """

    def __init__(self, *, archive_bytes: bytes = b"", objects=None):
        self.archive_bytes = archive_bytes
        self.objects = objects or []
        self.download_calls = []
        self.list_calls = []

    def download_file(self, bucket, key, filename):
        self.download_calls.append((bucket, key, filename))
        with open(filename, "wb") as fh:
            fh.write(self.archive_bytes)

    def list_objects_v2(self, Bucket, Prefix=""):
        self.list_calls.append((Bucket, Prefix))
        return {"Contents": [{"Key": k} for k in self.objects if k.startswith(Prefix)]}


class FakeLambdaClient:
    """Stands in for boto3's Lambda client. Same reasoning as FakeS3Client."""

    def __init__(self, reserved_concurrent_executions):
        self.reserved = reserved_concurrent_executions
        self.calls = []

    def get_function_concurrency(self, FunctionName):
        self.calls.append(FunctionName)
        return {"ReservedConcurrentExecutions": self.reserved}


class BlackHoledLambdaClient:
    """Reproduces what the deployed function actually gets: the Lambda control
    plane is not routable from a PRIVATE_ISOLATED subnet whose VPC has no NAT
    gateway and only an S3 gateway endpoint, so botocore raises a connection
    error rather than returning anything.
    """

    def __init__(self):
        self.calls = []

    def get_function_concurrency(self, FunctionName):
        self.calls.append(FunctionName)
        raise botocore.exceptions.EndpointConnectionError(
            endpoint_url="https://lambda.eu-west-1.amazonaws.com/"
        )


def gzip_bytes(data: bytes) -> bytes:
    return gzip.compress(data)


# --- require_confirmation ----------------------------------------------------


def test_require_confirmation_rejects_a_missing_confirm():
    with pytest.raises(restore.RestoreNotConfirmedError):
        restore.require_confirmation({"action": "restore", "key": "db/x.sqlite3.gz"})


def test_require_confirmation_rejects_a_wrong_confirm():
    with pytest.raises(restore.RestoreNotConfirmedError):
        restore.require_confirmation({"confirm": "yes please"})


def test_require_confirmation_accepts_the_exact_phrase():
    restore.require_confirmation({"confirm": "OVERWRITE-VAULT"})  # must not raise


# --- assert_application_stopped ----------------------------------------------


def test_assert_application_stopped_accepts_zero_concurrency():
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=0)
    restore.assert_application_stopped(lambda_client, "vaultwarden")  # must not raise
    assert lambda_client.calls == ["vaultwarden"]


def test_assert_application_stopped_rejects_nonzero_concurrency():
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=10)
    with pytest.raises(restore.ApplicationNotStoppedError):
        restore.assert_application_stopped(lambda_client, "vaultwarden")


def test_assert_application_stopped_reports_an_unreachable_control_plane_as_such(tmp_path):
    """The deployed reality: this check cannot complete from an isolated subnet.
    It must say so, in the payload the operator needs, instead of surfacing a raw
    botocore traceback after a multi-minute hang.
    """
    lambda_client = BlackHoledLambdaClient()

    with pytest.raises(restore.ConcurrencyCheckUnreachableError) as excinfo:
        restore.assert_application_stopped(lambda_client, "vaultwarden")

    message = str(excinfo.value)
    # It must name the cause, the manual verification, and the way forward.
    assert "isolated subnet" in message
    assert "put-function-concurrency" in message
    assert "get-function-concurrency" in message
    assert '"force": true' in message
    # Not silently swallowed into the generic "not stopped" error, which would
    # send the operator looking for a concurrency setting that is already 0.
    assert not isinstance(excinfo.value, restore.ApplicationNotStoppedError)


def test_lambda_client_config_fails_fast_instead_of_hanging_on_a_black_holed_endpoint():
    """Mechanism-level guard. A black-holed TCP connect does not get refused, it
    gets no answer at all, so the only thing that bounds the wait is the client's
    own timeout. botocore's defaults (60 s connect, retries) turn this into
    minutes of silence during an emergency.
    """
    config = restore._LAMBDA_CLIENT_CONFIG

    assert config.connect_timeout == 3
    assert config.read_timeout == 3
    # botocore's legacy retry mode reads this as a retry count, so it resolves to
    # two attempts, ~6 s worst case -- versus the default 60 s x 5 = five minutes.
    assert config.retries["max_attempts"] == 1


# --- list_recent_backups ------------------------------------------------------


def test_list_recent_backups_returns_newest_first():
    s3 = FakeS3Client(
        objects=[
            "db/2026-08-01T03-00-00Z.sqlite3.gz",
            "db/2026-08-03T03-00-00Z.sqlite3.gz",
            "db/2026-08-02T03-00-00Z.sqlite3.gz",
        ]
    )

    keys = restore.list_recent_backups(s3, "test-bucket")

    assert keys == [
        "db/2026-08-03T03-00-00Z.sqlite3.gz",
        "db/2026-08-02T03-00-00Z.sqlite3.gz",
        "db/2026-08-01T03-00-00Z.sqlite3.gz",
    ]
    assert s3.list_calls == [("test-bucket", "db/")]


def test_list_recent_backups_caps_at_the_given_limit():
    s3 = FakeS3Client(objects=[f"db/2026-08-{i:02d}T03-00-00Z.sqlite3.gz" for i in range(1, 31)])

    keys = restore.list_recent_backups(s3, "test-bucket", limit=5)

    assert len(keys) == 5
    assert keys[0] == "db/2026-08-30T03-00-00Z.sqlite3.gz"


# --- preserve_current_database -------------------------------------------------


def test_preserve_current_database_returns_none_when_there_is_nothing_to_preserve(tmp_path):
    absent = str(tmp_path / "db.sqlite3")

    result = restore.preserve_current_database(absent, datetime.now(timezone.utc))

    assert result is None


def test_preserve_current_database_copies_the_live_database_aside_intact(tmp_path):
    live = str(tmp_path / "db.sqlite3")
    make_db(live)
    now = datetime(2026, 8, 4, 3, 0, 0, tzinfo=timezone.utc)

    preserved_path = restore.preserve_current_database(live, now)

    assert preserved_path == f"{live}.preserved-2026-08-04T03-00-00Z"
    assert os.path.exists(preserved_path)
    # The original is untouched by preservation itself.
    assert os.path.exists(live)
    # The preserved copy is a complete, readable database, not a truncated stub.
    conn = sqlite3.connect(preserved_path)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    conn.close()


def test_preserve_current_database_uses_the_sqlite_backup_api_not_a_raw_file_copy(
    tmp_path, monkeypatch
):
    """Mechanism-level guard, the same spy style test_index.py uses for
    snapshot_database: the preserved copy must be taken through SQLite's online
    backup API, never a raw byte copy.

    This is not a stylistic preference. The concurrency pre-check that would have
    established "nothing is writing" cannot run from the deployed VPC at all (see
    ConcurrencyCheckUnreachableError), so every real restore passes "force": true.
    A byte copy would therefore never have the guarantee it depends on, and the
    preserved database -- the entire undo path for restoring the wrong snapshot --
    could be torn. The backup API needs no such guarantee.
    """
    live = str(tmp_path / "db.sqlite3")
    make_db(live)

    backup_calls = []

    class SpyConnection(sqlite3.Connection):
        def backup(self, *args, **kwargs):
            backup_calls.append((args, kwargs))
            return super().backup(*args, **kwargs)

    original_connect = sqlite3.connect

    def spy_connect(*args, **kwargs):
        kwargs.setdefault("factory", SpyConnection)
        return original_connect(*args, **kwargs)

    copy_calls = []

    def spy_copy2(*args, **kwargs):
        copy_calls.append((args, kwargs))

    monkeypatch.setattr(sqlite3, "connect", spy_connect)
    monkeypatch.setattr(shutil, "copy2", spy_copy2)

    preserved_path = restore.preserve_current_database(live, datetime.now(timezone.utc))

    assert len(backup_calls) == 1
    assert copy_calls == []
    conn = sqlite3.connect(preserved_path)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    conn.close()


def test_preserve_current_database_falls_back_to_a_raw_copy_when_the_live_file_is_not_a_database(
    tmp_path,
):
    """A live database SQLite cannot open is one of the reasons to restore in the
    first place. Preservation must not become the thing that blocks the restore;
    the bytes are kept verbatim under a name that says they are not an undo path.
    """
    live = tmp_path / "db.sqlite3"
    live.write_bytes(b"this is not a sqlite database at all")
    now = datetime(2026, 8, 4, 3, 0, 0, tzinfo=timezone.utc)

    preserved_path = restore.preserve_current_database(str(live), now)

    assert preserved_path == f"{live}.preserved-raw-2026-08-04T03-00-00Z"
    with open(preserved_path, "rb") as fh:
        assert fh.read() == b"this is not a sqlite database at all"
    # The failed online-backup attempt left no half-made file behind under the
    # normal preserved name, which would otherwise look like a usable undo copy.
    assert not os.path.exists(f"{live}.preserved-2026-08-04T03-00-00Z")


# --- clear_sidecar_files ---------------------------------------------------------


def test_clear_sidecar_files_moves_every_sidecar_out_of_the_way(tmp_path):
    """A rollback journal is bound to a path, not to the database that wrote it.
    Left in place, SQLite treats it as a hot journal belonging to whatever is at
    that path now -- the freshly restored database -- and rolls stale pages into
    it.
    """
    live = tmp_path / "db.sqlite3"
    make_db(str(live))
    for suffix in ("-journal", "-wal", "-shm"):
        (tmp_path / f"db.sqlite3{suffix}").write_bytes(b"stale " + suffix.encode())
    now = datetime(2026, 8, 4, 3, 0, 0, tzinfo=timezone.utc)

    moved = restore.clear_sidecar_files(str(live), now)

    for suffix in ("-journal", "-wal", "-shm"):
        assert not os.path.exists(f"{live}{suffix}")
    assert len(moved) == 3
    # Kept for forensics rather than deleted...
    for path in moved:
        assert os.path.exists(path)
    # ...but under names that are not themselves sidecar names. Moving the
    # journal to "<preserved-copy>-journal" would just recreate the same hazard
    # beside the preserved copy.
    for path in moved:
        for suffix in ("-journal", "-wal", "-shm"):
            assert not path.endswith(suffix)


def test_clear_sidecar_files_is_a_no_op_when_there_are_none(tmp_path):
    live = tmp_path / "db.sqlite3"
    make_db(str(live))

    assert restore.clear_sidecar_files(str(live), datetime.now(timezone.utc)) == []
    assert os.listdir(tmp_path) == ["db.sqlite3"]


# --- atomic_replace -------------------------------------------------------------


def test_atomic_replace_uses_os_replace_as_the_mechanism(tmp_path, monkeypatch):
    """Mechanism-level guard, in the same spy style test_index.py uses for
    sqlite3.Connection.backup: atomic_replace must swap the file into place via
    os.replace, not by writing dest_path directly.
    """
    dest = str(tmp_path / "db.sqlite3")
    src = str(tmp_path / "new.sqlite3")
    with open(src, "wb") as fh:
        fh.write(b"new-database-bytes")

    calls = []
    original_replace = os.replace

    def spy_replace(*args, **kwargs):
        calls.append(args)
        return original_replace(*args, **kwargs)

    monkeypatch.setattr(os, "replace", spy_replace)

    size = restore.atomic_replace(src, dest)

    assert len(calls) == 1
    tmp_arg, dest_arg = calls[0]
    assert dest_arg == dest
    # The temp file lived in dest's own directory (the EFS mount), not /tmp.
    assert os.path.dirname(tmp_arg) == os.path.dirname(dest)
    with open(dest, "rb") as fh:
        assert fh.read() == b"new-database-bytes"
    assert size == len(b"new-database-bytes")


def test_atomic_replace_leaves_no_leftover_temp_file_on_success(tmp_path):
    dest = str(tmp_path / "db.sqlite3")
    src = str(tmp_path / "new.sqlite3")
    with open(src, "wb") as fh:
        fh.write(b"data")

    restore.atomic_replace(src, dest)

    leftovers = [f for f in os.listdir(tmp_path) if f.startswith(".restore-")]
    assert leftovers == []


# --- execute_restore: the full ordering ----------------------------------------


def test_execute_restore_rejects_a_missing_confirm_and_never_touches_s3_or_the_live_database(
    tmp_path, monkeypatch
):
    live = tmp_path / "db.sqlite3"
    live.write_bytes(b"original-live-database")
    monkeypatch.setattr(restore, "DB_PATH", str(live))

    s3 = FakeS3Client(archive_bytes=gzip_bytes(b"whatever"))
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=0)

    with pytest.raises(restore.RestoreNotConfirmedError):
        restore.execute_restore({"action": "restore", "key": "db/x.sqlite3.gz"}, s3, lambda_client)

    assert s3.download_calls == []
    assert live.read_bytes() == b"original-live-database"


def test_execute_restore_rejects_a_zero_length_snapshot_and_leaves_the_live_database_untouched(
    tmp_path, monkeypatch
):
    """The most important test in this file: a corrupt or zero-length downloaded
    snapshot must be rejected by validate_snapshot before anything under DB_PATH is
    touched. Without this, a bad backup would overwrite a working vault and turn a
    recoverable situation into an unrecoverable one.
    """
    live = tmp_path / "db.sqlite3"
    live.write_bytes(b"original-live-database-bytes")
    monkeypatch.setattr(restore, "DB_PATH", str(live))

    s3 = FakeS3Client(archive_bytes=gzip_bytes(b""))  # decompresses to a zero-length file
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=0)

    with pytest.raises(index.InvalidSnapshotError):
        restore.execute_restore(
            {"action": "restore", "key": "db/bad.sqlite3.gz", "confirm": "OVERWRITE-VAULT"},
            s3,
            lambda_client,
        )

    # Live database is byte-for-byte untouched -- no preservation, no replacement.
    assert live.read_bytes() == b"original-live-database-bytes"
    # No stray preserved-copy or temp file appeared either.
    leftovers = [f for f in os.listdir(tmp_path) if f != "db.sqlite3"]
    assert leftovers == []


def test_execute_restore_rejects_a_structurally_corrupt_snapshot_and_leaves_the_live_database_untouched(
    tmp_path, monkeypatch
):
    """Same property as the zero-length case, but for bytes that are not a SQLite
    database at all (as opposed to an empty one) -- validate_snapshot's underlying
    sqlite3.connect().execute() rejects it before DB_PATH is touched either way.
    """
    live = tmp_path / "db.sqlite3"
    live.write_bytes(b"original-live-database-bytes")
    monkeypatch.setattr(restore, "DB_PATH", str(live))

    s3 = FakeS3Client(archive_bytes=gzip_bytes(b"this is not a sqlite database"))
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=0)

    with pytest.raises(sqlite3.DatabaseError):
        restore.execute_restore(
            {"action": "restore", "key": "db/bad.sqlite3.gz", "confirm": "OVERWRITE-VAULT"},
            s3,
            lambda_client,
        )

    assert live.read_bytes() == b"original-live-database-bytes"


def test_execute_restore_refuses_when_the_application_is_not_stopped(tmp_path, monkeypatch):
    live = tmp_path / "db.sqlite3"
    live.write_bytes(b"original-live-database-bytes")
    monkeypatch.setattr(restore, "DB_PATH", str(live))

    s3 = FakeS3Client(archive_bytes=gzip_bytes(b"irrelevant, should never be reached"))
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=10)

    with pytest.raises(restore.ApplicationNotStoppedError):
        restore.execute_restore(
            {"action": "restore", "key": "db/x.sqlite3.gz", "confirm": "OVERWRITE-VAULT"},
            s3,
            lambda_client,
        )

    assert s3.download_calls == []
    assert live.read_bytes() == b"original-live-database-bytes"


def test_execute_restore_force_bypasses_the_concurrency_check(tmp_path, monkeypatch):
    live = tmp_path / "db.sqlite3"
    make_db(str(live))
    monkeypatch.setattr(restore, "DB_PATH", str(live))
    monkeypatch.setattr(restore, "BUCKET_NAME", "test-bucket")

    new_db = tmp_path / "new.sqlite3"
    make_db(str(new_db))
    with open(new_db, "rb") as fh:
        archive_bytes = gzip_bytes(fh.read())

    s3 = FakeS3Client(archive_bytes=archive_bytes)
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=10)  # would normally block

    result = restore.execute_restore(
        {
            "action": "restore",
            "key": "db/good.sqlite3.gz",
            "confirm": "OVERWRITE-VAULT",
            "force": True,
        },
        s3,
        lambda_client,
    )

    assert result["status"] == "ok"
    # force bypasses the check entirely -- the Lambda client is never even called.
    assert lambda_client.calls == []


def test_execute_restore_preserves_the_current_database_then_replaces_it_atomically(
    tmp_path, monkeypatch
):
    """The full happy path, proving the ordering end to end: the pre-restore
    database is preserved intact under a timestamped name, and the live path ends
    up holding the new, validated snapshot.
    """
    live = tmp_path / "db.sqlite3"
    make_db(str(live))
    monkeypatch.setattr(restore, "DB_PATH", str(live))
    monkeypatch.setattr(restore, "BUCKET_NAME", "test-bucket")

    new_db = tmp_path / "new.sqlite3"
    new_conn = sqlite3.connect(str(new_db))
    new_conn.execute("CREATE TABLE ciphers (id INTEGER PRIMARY KEY, data TEXT)")
    new_conn.execute("INSERT INTO ciphers (data) VALUES ('from-the-backup')")
    new_conn.commit()
    new_conn.close()
    with open(new_db, "rb") as fh:
        archive_bytes = gzip_bytes(fh.read())

    s3 = FakeS3Client(archive_bytes=archive_bytes)
    lambda_client = FakeLambdaClient(reserved_concurrent_executions=0)

    result = restore.execute_restore(
        {"action": "restore", "key": "db/good.sqlite3.gz", "confirm": "OVERWRITE-VAULT"},
        s3,
        lambda_client,
    )

    assert result["status"] == "ok"
    assert result["key"] == "db/good.sqlite3.gz"
    assert result["bytes"] > 0
    assert result["preserved"] is not None

    # The live path now holds the restored database's content.
    restored_conn = sqlite3.connect(str(live))
    assert restored_conn.execute("SELECT data FROM ciphers").fetchone()[0] == "from-the-backup"
    restored_conn.close()

    # The preserved copy holds the ORIGINAL 100-row database, readable and complete.
    preserved_conn = sqlite3.connect(result["preserved"])
    assert preserved_conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    preserved_conn.close()

    assert s3.download_calls == [("test-bucket", "db/good.sqlite3.gz", s3.download_calls[0][2])]


def test_execute_restore_leaves_no_journal_beside_the_restored_database(tmp_path, monkeypatch):
    """The corruption path this guards: with ENABLE_DB_WAL=false the database runs
    in rollback-journal mode, so `db.sqlite3-journal` exists whenever a transaction
    is in flight -- including when an execution environment is reclaimed mid-write,
    which is exactly the kind of event that leads to a restore. A journal is not
    bound to a particular database file. Left in place, SQLite finds it beside the
    RESTORED database on the next open, treats it as a hot journal, and rolls those
    stale pages into a database that validated as sound seconds earlier.
    """
    live = tmp_path / "db.sqlite3"
    make_db(str(live))
    journal = tmp_path / "db.sqlite3-journal"
    journal.write_bytes(b"\x00" * 512)  # a leftover journal from the crashed writer
    monkeypatch.setattr(restore, "DB_PATH", str(live))
    monkeypatch.setattr(restore, "BUCKET_NAME", "test-bucket")

    new_db = tmp_path / "new.sqlite3"
    make_db(str(new_db))
    with open(new_db, "rb") as fh:
        archive_bytes = gzip_bytes(fh.read())

    result = restore.execute_restore(
        {
            "action": "restore",
            "key": "db/good.sqlite3.gz",
            "confirm": "OVERWRITE-VAULT",
            "force": True,
        },
        FakeS3Client(archive_bytes=archive_bytes),
        FakeLambdaClient(reserved_concurrent_executions=0),
    )

    assert result["status"] == "ok"
    assert not journal.exists()
    # Moved aside for forensics, not deleted, and reported back to the operator.
    assert len(result["stale_sidecars"]) == 1
    moved = result["stale_sidecars"][0]
    assert moved.startswith(f"{live}.stale-journal.")
    assert os.path.exists(moved)
    # The restored database opens cleanly, with no stale pages rolled into it.
    conn = sqlite3.connect(str(live))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()


# --- handler dispatch (pure dispatch logic only; S3/Lambda paths are exercised
# above through execute_restore and list_recent_backups directly, not through the
# module-level _s3/_lambda clients -- same boundary test_index.py keeps around its
# own handler, which only unit-tests the no-AWS skip branch) -----------------------


def test_handler_rejects_an_unknown_action():
    with pytest.raises(ValueError):
        restore.handler({"action": "wipe-everything"}, None)


def test_handler_requires_an_action():
    with pytest.raises(ValueError):
        restore.handler({}, None)
