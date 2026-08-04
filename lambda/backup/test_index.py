import gzip
import os
import shutil
import sqlite3
from datetime import datetime, timezone

import pytest

import index


def make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE ciphers (id INTEGER PRIMARY KEY, data TEXT)")
    conn.executemany("INSERT INTO ciphers (data) VALUES (?)", [(f"row-{i}",) for i in range(100)])
    conn.commit()
    conn.close()


def test_snapshot_produces_a_readable_database_with_all_rows(tmp_path):
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")
    make_db(src)

    size = index.snapshot_database(src, dest)

    assert size > 0
    conn = sqlite3.connect(dest)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    conn.close()


def test_snapshot_is_consistent_while_a_writer_holds_an_open_transaction(tmp_path):
    """Sanity check only: snapshot_database must not raise, and must see the last
    committed state, while a writer holds an open transaction elsewhere.

    This does NOT prove the online-backup-API-vs-raw-copy property its name suggests. Verified
    experimentally (see task report) that a naive shutil.copyfile passes this exact scenario too:
    under SQLite's default rollback-journal mode and default page cache, a single small
    uncommitted INSERT never leaves the in-memory page cache before commit, so the on-disk bytes
    are byte-identical to the pre-transaction state for the whole life of this test regardless of
    which copy mechanism is used. See test_snapshot_database_uses_the_sqlite_backup_api_not_a_raw_file_copy
    for the test that actually enforces the mechanism, and its docstring for why a true torn-read
    reproduction on a local filesystem was attempted and abandoned as inherently
    NFS/EFS-specific -- not a gap that was overlooked.
    """
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")
    make_db(src)

    writer = sqlite3.connect(src)
    writer.execute("BEGIN")
    writer.execute("INSERT INTO ciphers (data) VALUES ('uncommitted')")

    index.snapshot_database(src, dest)
    writer.rollback()
    writer.close()

    conn = sqlite3.connect(dest)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()


def test_snapshot_database_uses_the_sqlite_backup_api_not_a_raw_file_copy(tmp_path, monkeypatch):
    """Mechanism-level guard: snapshot_database must take its copy through SQLite's online
    backup API (sqlite3.Connection.backup), and must never fall back to a raw file copy
    (shutil.copyfile or equivalent).

    This is a deliberate, deterministic proxy for the property that actually matters -- that the
    snapshot cannot be torn or stale -- rather than an attempt to trigger a live race. A live
    torn-write reproduction was attempted on this local filesystem across multiple approaches
    (an open uncommitted transaction of varying size, forced page-cache spill via tiny
    cache_size/cache_spill settings, overwriting already-committed pages mid-transaction) and none
    produced an observable inconsistency: SQLite's own locking either kept the on-disk bytes
    untouched until commit, or escalated to an EXCLUSIVE lock that made a correct
    sqlite3.Connection.backup() call block rather than return bad data. That is consistent with
    the real risk being specific to non-atomic write semantics on a networked filesystem
    (NFS/EFS), which cannot be reproduced locally -- not a gap that was overlooked. Asserting the
    correct API is actually the mechanism in use is the practical, environment-independent
    closure available here.
    """
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")
    make_db(src)

    # sqlite3.Connection is a C-extension type; its methods can't be monkeypatched directly
    # ("cannot set 'backup' attribute of immutable type 'sqlite3.Connection'"). Subclassing is
    # permitted, though, so route sqlite3.connect through a factory that returns instances of a
    # subclass overriding backup() to record calls while still doing the real work.
    backup_calls = []

    class SpyConnection(sqlite3.Connection):
        def backup(self, *args, **kwargs):
            backup_calls.append((self, args, kwargs))
            return super().backup(*args, **kwargs)

    original_connect = sqlite3.connect

    def spy_connect(*args, **kwargs):
        kwargs.setdefault("factory", SpyConnection)
        return original_connect(*args, **kwargs)

    # snapshot_database is not expected to call shutil.copyfile at all; this spy exists only to
    # record whether it does, so the assertion below fails loudly (not silently no-ops a real
    # copy) if a future change reintroduces one.
    copyfile_calls = []

    def spy_copyfile(*args, **kwargs):
        copyfile_calls.append((args, kwargs))

    monkeypatch.setattr(sqlite3, "connect", spy_connect)
    monkeypatch.setattr(shutil, "copyfile", spy_copyfile)

    index.snapshot_database(src, dest)

    assert len(backup_calls) == 1
    assert copyfile_calls == []


def test_snapshot_rejects_a_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        index.snapshot_database(str(tmp_path / "absent.sqlite3"), str(tmp_path / "out"))


def test_validate_snapshot_rejects_an_empty_database(tmp_path):
    """A zero-length file is a realistic EFS corruption/truncation symptom. It opens via
    sqlite3.connect without error and passes PRAGMA integrity_check (there is nothing to
    check), so only the schema-object count catches it. Without this check, handler would
    upload an empty database and report success.
    """
    empty = tmp_path / "empty.sqlite3"
    empty.write_bytes(b"")

    with pytest.raises(index.InvalidSnapshotError):
        index.validate_snapshot(str(empty))


def test_validate_snapshot_accepts_a_populated_database(tmp_path):
    populated = str(tmp_path / "db.sqlite3")
    make_db(populated)

    index.validate_snapshot(populated)  # must not raise


def test_compress_round_trips(tmp_path):
    src = tmp_path / "plain.bin"
    src.write_bytes(b"vaultwarden" * 5000)
    dest = str(tmp_path / "plain.bin.gz")

    size = index.compress(str(src), dest)

    assert size == os.path.getsize(dest)
    assert size < src.stat().st_size
    with gzip.open(dest, "rb") as fh:
        assert fh.read() == b"vaultwarden" * 5000


def test_backup_key_sorts_chronologically_as_a_string():
    early = index.backup_key(datetime(2026, 8, 4, 3, 0, 0, tzinfo=timezone.utc))
    later = index.backup_key(datetime(2026, 12, 4, 3, 0, 0, tzinfo=timezone.utc))

    assert early == "db/2026-08-04T03-00-00Z.sqlite3.gz"
    assert early < later


def test_snapshot_reads_through_wal_content_as_a_general_regression_guard(tmp_path):
    """NOT this deployment's production failure mode -- read this docstring before touching WAL.

    This deployment always runs SQLite in rollback-journal mode: ENABLE_DB_WAL is set to
    "false" in the CDK application construct, and it must stay false, because WAL mode requires
    readers to coordinate through an mmap'd shared-memory (-shm) file, and EFS (backed by NFS)
    does not support that -- Vaultwarden aborts on startup with "Failed to turn on WAL" if WAL is
    ever enabled over EFS. Production never exercises the scenario this test builds.

    This test exists purely as a general regression guard on snapshot_database's correctness,
    and as defence against future config drift: if WAL mode were ever (mistakenly) turned back
    on, a fully committed row can live only in the "-wal" sidecar file until the next checkpoint.
    A raw file copy (what AWS Backup on EFS would do) only sees the main .sqlite3 file and would
    silently drop that row -- no error, no failed integrity check, just quietly missing data.
    The online backup API reads through the WAL correctly and captures it. Verified to fail
    against shutil.copyfile; see the task report for how it was checked.
    """
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")

    conn = sqlite3.connect(src)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE ciphers (id INTEGER PRIMARY KEY, data TEXT)")
    conn.executemany("INSERT INTO ciphers (data) VALUES (?)", [(f"row-{i}",) for i in range(100)])
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # baseline 100 rows land in the main file
    conn.close()

    # This commit lands in the WAL file only; nothing forces a checkpoint afterward.
    writer = sqlite3.connect(src)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("INSERT INTO ciphers (data) VALUES ('committed-after-checkpoint')")
    writer.commit()

    index.snapshot_database(src, dest)
    writer.close()

    conn = sqlite3.connect(dest)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 101
    conn.close()


def test_handler_skips_when_the_database_does_not_exist_yet(tmp_path, monkeypatch):
    """The only thing preventing a crash on the first scheduled run before the user has ever
    logged in and Vaultwarden has created a database file. Needs no AWS mocking: the skip
    branch returns before `_s3` is ever touched.
    """
    monkeypatch.setattr(index, "DB_PATH", str(tmp_path / "absent.sqlite3"))

    result = index.handler({}, None)

    assert result == {"status": "skipped", "reason": "database does not exist yet"}
