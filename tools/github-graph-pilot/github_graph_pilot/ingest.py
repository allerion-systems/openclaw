from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ALLOWED_STREAMS = {
    "commits",
    "issues",
    "pull_requests",
    "releases",
    "repositories",
}
GRAPHITI_NAMESPACE = uuid.UUID("8a6be10c-37d0-5b8b-ae43-20dd48bd5192")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def source_identity(stream: str, record: dict[str, Any], key_properties: list[str]) -> str:
    if stream not in ALLOWED_STREAMS:
        raise ValueError(f"Unsupported GitHub stream: {stream}")
    if not key_properties:
        raise ValueError(f"Missing Singer key properties for {stream}")
    keys = {key: record.get(key) for key in key_properties}
    if any(value is None for value in keys.values()):
        raise ValueError(f"Missing Singer primary key for {stream}")
    return canonical_json(keys)


def record_fingerprint(record: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(record).encode("utf-8")).hexdigest()


def graph_episode_id(account: str, repository: str, stream: str, identity: str, fingerprint: str) -> str:
    return str(
        uuid.uuid5(
            GRAPHITI_NAMESPACE,
            "\0".join((account.casefold(), repository.casefold(), stream, identity, fingerprint)),
        )
    )


def graph_group_id(repository: str) -> str:
    repository_key = hashlib.sha256(repository.casefold().encode("utf-8")).hexdigest()[:24]
    return f"github_repo_{repository_key}"


def record_reference_time(record: dict[str, Any]) -> datetime:
    for field in ("updated_at", "created_at", "commit_timestamp", "published_at", "merged_at"):
        value = record.get(field)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc)
            except ValueError:
                continue
    return datetime.now(timezone.utc)


def source_url(record: dict[str, Any]) -> str | None:
    for field in ("html_url", "discussion_url"):
        value = record.get(field)
        if isinstance(value, str) and value.startswith("https://github.com/"):
            return value
    return None


def commit_refs(record: dict[str, Any]) -> dict[str, str]:
    refs: dict[str, str] = {}
    for field in ("sha", "ref", "merge_commit_sha"):
        value = record.get(field)
        if isinstance(value, str) and value:
            refs[field] = value
    for side in ("head", "base"):
        nested = record.get(side)
        if isinstance(nested, dict) and isinstance(nested.get("sha"), str):
            refs[f"{side}.sha"] = nested["sha"]
    commit = record.get("commit")
    if isinstance(commit, dict) and isinstance(commit.get("sha"), str):
        refs["commit.sha"] = commit["sha"]
    return refs


class RecordStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name == "posix" and path.parent.stat().st_mode & 0o077:
            raise PermissionError("SQLite database directory must not be accessible by group or others")
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS raw_records (
              stream TEXT NOT NULL,
              source_key TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              payload TEXT NOT NULL,
              source_url TEXT,
              reference_time TEXT NOT NULL,
              episode_uuid TEXT NOT NULL UNIQUE,
              synced_at TEXT,
              PRIMARY KEY (stream, source_key, fingerprint)
            );
            CREATE TABLE IF NOT EXISTS sync_state (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_scope (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              repository TEXT NOT NULL
            );
            """
        )
        self.connection.commit()
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def close(self) -> None:
        self.connection.close()

    def bind_repository(self, repository: str) -> None:
        row = self.connection.execute(
            "SELECT repository FROM sync_scope WHERE singleton = 1"
        ).fetchone()
        canonical_repository = repository.casefold()
        if row is not None and row[0] != canonical_repository:
            raise ValueError(
                f"Database is already bound to repository {row[0]}; use a separate database"
            )
        self.connection.execute(
            "INSERT OR IGNORE INTO sync_scope(singleton, repository) VALUES(1, ?)",
            (canonical_repository,),
        )
        self.connection.commit()

    def get_state(self) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT payload FROM sync_state WHERE singleton = 1").fetchone()
        return json.loads(row[0]) if row else None

    def save_state(self, state: dict[str, Any]) -> None:
        self.connection.execute(
            "INSERT INTO sync_state(singleton, payload) VALUES(1, ?) "
            "ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload",
            (canonical_json(state),),
        )
        self.connection.commit()

    def add_record(
        self,
        *,
        account: str,
        repository: str,
        stream: str,
        record: dict[str, Any],
        key_properties: list[str],
    ) -> None:
        identity = source_identity(stream, record, key_properties)
        fingerprint = record_fingerprint(record)
        self.connection.execute(
            """
            INSERT OR IGNORE INTO raw_records
              (stream, source_key, fingerprint, payload, source_url, reference_time, episode_uuid)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stream,
                identity,
                fingerprint,
                canonical_json(record),
                source_url(record),
                record_reference_time(record).isoformat(),
                graph_episode_id(account, repository, stream, identity, fingerprint),
            ),
        )
        self.connection.commit()

    def pending_records(self) -> list[tuple[str, str, str, str, str | None, str, str]]:
        return self.connection.execute(
            """
            SELECT stream, source_key, fingerprint, payload, source_url, reference_time, episode_uuid
            FROM raw_records
            WHERE synced_at IS NULL
            ORDER BY reference_time, stream, source_key
            """
        ).fetchall()

    def mark_synced(self, episode_uuid: str) -> None:
        self.connection.execute(
            "UPDATE raw_records SET synced_at = ? WHERE episode_uuid = ?",
            (datetime.now(timezone.utc).isoformat(), episode_uuid),
        )
        self.connection.commit()


async def sync_pending_records(
    store: RecordStore, graphiti: Any, *, account: str, repository: str
) -> None:
    from graphiti_core.nodes import EpisodeType

    for (
        stream,
        source_key,
        fingerprint,
        payload,
        url,
        reference_time,
        episode_uuid,
    ) in store.pending_records():
        record = json.loads(payload)
        episode = {
            "account": account,
            "repository": repository,
            "stream": stream,
            "source_id": source_key,
            "source_url": url,
            "record_sha256": fingerprint,
            "commit_refs": commit_refs(record),
            "record": record,
        }
        await graphiti.add_episode(
            name=f"github:{account}/{repository}:{stream}:{source_key}",
            episode_body=canonical_json(episode),
            source=EpisodeType.json,
            source_description=f"GitHub {stream} record; source={url or 'URL unavailable'}",
            reference_time=datetime.fromisoformat(reference_time),
            # Group IDs are searchable selectors, not access controls; the dedicated
            # Neo4j instance is the repository boundary.
            group_id=graph_group_id(repository),
            uuid=episode_uuid,
        )
        store.mark_synced(episode_uuid)
