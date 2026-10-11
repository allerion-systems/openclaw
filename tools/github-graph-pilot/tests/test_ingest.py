from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import tempfile
import unittest
from types import ModuleType, SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from github_graph_pilot.cli import process_singer_messages, run_tap, selected_catalog
from github_graph_pilot.ingest import (
    RecordStore,
    graph_episode_id,
    graph_group_id,
    sync_pending_records,
)


class IngestTests(unittest.TestCase):
    def test_catalog_selects_bounded_record_streams_only(self) -> None:
        catalog = {
            "streams": [
                {
                    "tap_stream_id": name,
                    "metadata": [{"breadcrumb": [], "metadata": {}}],
                }
                for name in (
                    "repositories",
                    "issues",
                    "pull_requests",
                    "discussions",
                    "events",
                    "traffic_clones",
                )
            ]
        }

        selected = selected_catalog(catalog)

        self.assertTrue(selected["streams"][0]["metadata"][0]["metadata"]["selected"])
        self.assertTrue(selected["streams"][1]["metadata"][0]["metadata"]["selected"])
        self.assertTrue(selected["streams"][2]["metadata"][0]["metadata"]["selected"])
        self.assertFalse(selected["streams"][3]["metadata"][0]["metadata"]["selected"])
        self.assertFalse(selected["streams"][4]["metadata"][0]["metadata"]["selected"])
        self.assertFalse(selected["streams"][5]["metadata"][0]["metadata"]["selected"])

    def test_raw_record_and_state_survive_graph_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RecordStore(Path(temp_dir) / "graph.sqlite")
            lines = [
                json.dumps(
                    {
                        "type": "SCHEMA",
                        "stream": "issues",
                        "key_properties": ["id"],
                    }
                ),
                json.dumps(
                    {
                        "type": "RECORD",
                        "stream": "issues",
                        "record": {
                            "id": 42,
                            "html_url": "https://github.com/acme/engine/issues/42",
                            "updated_at": "2026-10-10T12:00:00Z",
                            "title": "Failure evidence",
                        },
                    }
                ),
                json.dumps({"type": "STATE", "value": {"bookmarks": {"issues": "42"}}}),
            ]

            state = process_singer_messages(
                lines, store, account="acme", repository="acme/engine"
            )

            self.assertEqual(state, {"bookmarks": {"issues": "42"}})
            store.save_state(state)
            process_singer_messages(
                lines, store, account="acme", repository="acme/engine"
            )
            pending = store.pending_records()
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0][4], "https://github.com/acme/engine/issues/42")
            self.assertEqual(json.loads(pending[0][3])["title"], "Failure evidence")
            self.assertEqual(len(pending), 1)
            self.assertEqual(len(store.pending_records()), 1)
            store.close()

    def test_episode_identity_is_stable_per_source_revision(self) -> None:
        original = graph_episode_id("acme", "acme/engine", "issues", '{"id":42}', "sha-a")

        self.assertEqual(
            original,
            graph_episode_id("ACME", "ACME/ENGINE", "issues", '{"id":42}', "sha-a"),
        )
        self.assertNotEqual(
            original,
            graph_episode_id("acme", "acme/engine", "issues", '{"id":42}', "sha-b"),
        )

    def test_graph_group_is_stable_but_not_an_access_boundary(self) -> None:
        self.assertEqual(graph_group_id("acme/engine"), graph_group_id("ACME/ENGINE"))
        self.assertNotEqual(graph_group_id("acme/engine"), graph_group_id("acme/other"))

    def test_rejects_unselected_or_unsafe_streams(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RecordStore(Path(temp_dir) / "graph.sqlite")
            for stream in ("discussion_comments", "traffic_clones"):
                with self.subTest(stream=stream), self.assertRaisesRegex(
                    ValueError, "Unsupported GitHub stream"
                ):
                    store.add_record(
                        account="acme",
                        repository="acme/engine",
                        stream=stream,
                        record={"id": 1},
                        key_properties=["id"],
                    )
            store.close()

    def test_database_cannot_be_reused_for_a_different_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RecordStore(Path(temp_dir) / "graph.sqlite")
            store.bind_repository("acme/engine")
            store.bind_repository("ACME/ENGINE")

            with self.assertRaisesRegex(ValueError, "use a separate database"):
                store.bind_repository("acme/other")

            store.close()

    @unittest.skipUnless(os.name == "posix", "POSIX directory permissions only")
    def test_database_rejects_a_shared_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir) / "shared"
            directory.mkdir(mode=0o755)
            directory.chmod(0o755)

            with self.assertRaisesRegex(PermissionError, "must not be accessible"):
                RecordStore(directory / "graph.sqlite")

    def test_graph_failure_leaves_raw_record_pending_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RecordStore(Path(temp_dir) / "graph.sqlite")
            process_singer_messages(
                [
                    json.dumps(
                        {"type": "SCHEMA", "stream": "issues", "key_properties": ["id"]}
                    ),
                    json.dumps(
                        {
                            "type": "RECORD",
                            "stream": "issues",
                            "record": {"id": 7, "html_url": "https://github.com/a/b/issues/7"},
                        }
                    ),
                ],
                store,
                account="a",
                repository="a/b",
            )
            graphiti_nodes = ModuleType("graphiti_core.nodes")
            graphiti_nodes.EpisodeType = SimpleNamespace(json="json")
            graphiti_core = ModuleType("graphiti_core")
            graphiti_core.nodes = graphiti_nodes

            class GraphitiStub:
                def __init__(self, should_fail: bool):
                    self.should_fail = should_fail
                    self.episode_ids: list[str] = []
                    self.group_ids: list[str] = []

                async def add_episode(self, **kwargs: object) -> None:
                    self.episode_ids.append(str(kwargs["uuid"]))
                    self.group_ids.append(str(kwargs["group_id"]))
                    if self.should_fail:
                        raise RuntimeError("temporary graph failure")

            failing = GraphitiStub(should_fail=True)
            with patch.dict(
                sys.modules,
                {"graphiti_core": graphiti_core, "graphiti_core.nodes": graphiti_nodes},
            ):
                with self.assertRaisesRegex(RuntimeError, "temporary graph failure"):
                    asyncio.run(
                        sync_pending_records(
                            store, failing, account="a", repository="a/b"
                        )
                    )
                succeeding = GraphitiStub(should_fail=False)
                asyncio.run(
                    sync_pending_records(
                        store, succeeding, account="a", repository="a/b"
                    )
                )

            self.assertEqual(len(store.pending_records()), 0)
            self.assertEqual(failing.episode_ids, succeeding.episode_ids)
            self.assertEqual(succeeding.group_ids, [graph_group_id("a/b")])
            store.close()

    def test_run_tap_pins_one_repo_and_persists_only_successful_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            binary_dir = root / "bin"
            binary_dir.mkdir()
            tap = binary_dir / "tap-github"
            tap.write_text(
                """#!/usr/bin/env python3
import json
import sys

def arg(name):
    return sys.argv[sys.argv.index(name) + 1]

config = json.load(open(arg("--config"), encoding="utf-8"))
assert config == {"repositories": ["acme/engine"]}
assert "GITHUB_TOKEN" in __import__("os").environ
if "--discover" in sys.argv:
    print(json.dumps({"streams": [
        {"tap_stream_id": name, "metadata": [{"breadcrumb": [], "metadata": {}}]}
        for name in ("repositories", "issues", "pull_requests", "commits", "releases", "events")
    ]}))
else:
    catalog = json.load(open(arg("--catalog"), encoding="utf-8"))
    selected = {
        stream["tap_stream_id"]
        for stream in catalog["streams"]
        if stream["metadata"][0]["metadata"].get("selected")
    }
    assert selected == {"repositories", "issues", "pull_requests", "commits", "releases"}
    print(json.dumps({"type": "SCHEMA", "stream": "issues", "key_properties": ["id"]}))
    print(json.dumps({"type": "RECORD", "stream": "issues", "record": {"id": 11}}))
    print(json.dumps({"type": "STATE", "value": {"cursor": 11}}))
""",
                encoding="utf-8",
            )
            tap.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
            store = RecordStore(root / "state" / "raw.sqlite")
            store.save_state({"cursor": 10})
            previous_path = os.environ.get("PATH", "")
            previous_token = os.environ.get("GITHUB_TOKEN")
            try:
                os.environ["PATH"] = f"{binary_dir}{os.pathsep}{previous_path}"
                os.environ["GITHUB_TOKEN"] = "not-a-real-token"
                run_tap("acme/engine", store)
            finally:
                os.environ["PATH"] = previous_path
                if previous_token is None:
                    os.environ.pop("GITHUB_TOKEN", None)
                else:
                    os.environ["GITHUB_TOKEN"] = previous_token

            self.assertEqual(store.get_state(), {"cursor": 11})
            self.assertEqual(len(store.pending_records()), 1)
            store.close()


if __name__ == "__main__":
    unittest.main()
