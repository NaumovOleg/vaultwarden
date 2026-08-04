import gzip
import os
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
    """The whole reason for using the online backup API instead of copying the file."""
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


def test_snapshot_rejects_a_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        index.snapshot_database(str(tmp_path / "absent.sqlite3"), str(tmp_path / "out"))


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


def test_snapshot_captures_committed_writes_still_pending_in_the_wal(tmp_path):
    """A raw file copy (what AWS Backup on EFS would do) only sees the main .sqlite3
    file. Vaultwarden's SQLite connection runs in WAL mode, so a row can be fully
    committed yet live only in the "-wal" sidecar file until the next checkpoint. A
    naive copy of the main file alone silently drops that row -- no error, no failed
    integrity check, just quietly missing data. The online backup API reads through
    the WAL correctly and captures it. This is verified to fail against
    shutil.copyfile: see the task report for how it was checked.
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
