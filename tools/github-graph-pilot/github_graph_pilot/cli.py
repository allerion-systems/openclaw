from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .ingest import ALLOWED_STREAMS, RecordStore, sync_pending_records


def selected_catalog(discovered: dict[str, Any]) -> dict[str, Any]:
    catalog = json.loads(json.dumps(discovered))
    selected = {"repositories", "issues", "pull_requests", "commits", "releases"}
    for stream in catalog.get("streams", []):
        name = stream.get("tap_stream_id") or stream.get("stream")
        for item in stream.get("metadata", []):
            if item.get("breadcrumb") == []:
                item.setdefault("metadata", {})["selected"] = (
                    name in selected and name in ALLOWED_STREAMS
                )
    return catalog


def process_singer_messages(
    lines: Iterable[str], store: RecordStore, *, account: str, repository: str
) -> dict[str, Any] | None:
    schemas: dict[str, list[str]] = {}
    latest_state: dict[str, Any] | None = None
    for line in lines:
        if not line.strip():
            continue
        message = json.loads(line)
        kind = message.get("type")
        if kind == "SCHEMA":
            stream = message.get("stream")
            keys = message.get("key_properties")
            if not isinstance(stream, str) or not isinstance(keys, list):
                raise ValueError("Singer SCHEMA message is missing stream/key_properties")
            schemas[stream] = [key for key in keys if isinstance(key, str)]
        elif kind == "RECORD":
            stream = message.get("stream")
            record = message.get("record")
            if stream not in schemas or not isinstance(record, dict):
                raise ValueError("Singer RECORD arrived before a valid SCHEMA")
            store.add_record(
                account=account,
                repository=repository,
                stream=stream,
                record=record,
                key_properties=schemas[stream],
            )
        elif kind == "STATE":
            state = message.get("value")
            if isinstance(state, dict):
                latest_state = state
    return latest_state


def run_tap(repository: str, store: RecordStore) -> None:
    if "/" not in repository or repository.startswith("/") or repository.endswith("/"):
        raise ValueError("Repository must be a single owner/name value")
    if not os.environ.get("GITHUB_TOKEN"):
        raise ValueError("Set GITHUB_TOKEN to a read-only GitHub token")
    store.bind_repository(repository)

    tap_config = {"repositories": [repository]}
    state = store.get_state()
    with tempfile.TemporaryDirectory(prefix="github-graph-pilot-") as temp_dir:
        config_path = Path(temp_dir) / "config.json"
        catalog_path = Path(temp_dir) / "catalog.json"
        state_path = Path(temp_dir) / "state.json"
        config_path.write_text(json.dumps(tap_config), encoding="utf-8")

        discovery = subprocess.run(
            ["tap-github", "--config", str(config_path), "--discover"],
            check=True,
            capture_output=True,
            text=True,
        )
        catalog = selected_catalog(json.loads(discovery.stdout))
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        if state is not None:
            state_path.write_text(json.dumps(state), encoding="utf-8")
        command = ["tap-github", "--config", str(config_path), "--catalog", str(catalog_path)]
        if state is not None:
            command.extend(["--state", str(state_path)])
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=None, text=True)
        assert process.stdout is not None
        try:
            latest_state = process_singer_messages(
                process.stdout,
                store,
                account=repository.split("/", maxsplit=1)[0],
                repository=repository,
            )
        except Exception:
            process.terminate()
            process.wait()
            process.stdout.close()
            raise
        exit_code = process.wait()
        process.stdout.close()
        if exit_code != 0:
            raise subprocess.CalledProcessError(exit_code, command)
        if latest_state is not None:
            store.save_state(latest_state)


async def run_graphiti(store: RecordStore, repository: str) -> None:
    from graphiti_core import Graphiti

    account = repository.split("/", maxsplit=1)[0]
    graphiti = Graphiti(
        os.environ["NEO4J_URI"],
        os.environ["NEO4J_USERNAME"],
        os.environ["NEO4J_PASSWORD"],
    )
    try:
        await graphiti.build_indices_and_constraints()
        await sync_pending_records(store, graphiti, account=account, repository=repository)
    finally:
        await graphiti.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync one GitHub repository into Graphiti")
    parser.add_argument("--repository", required=True, help="Exactly one owner/repository")
    parser.add_argument("--database", required=True, type=Path, help="Local SQLite raw-record and tap-state database")
    args = parser.parse_args()

    store = RecordStore(args.database)
    try:
        run_tap(args.repository, store)
        asyncio.run(run_graphiti(store, args.repository))
    except Exception as error:
        print(f"GitHub graph sync failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    finally:
        store.close()


if __name__ == "__main__":
    main()
