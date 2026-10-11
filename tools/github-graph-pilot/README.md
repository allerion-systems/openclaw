# GitHub graph pilot

This opt-in pilot syncs **one selected repository** from GitHub into a Graphiti temporal graph. It stores the tap's raw records and Singer state in a local SQLite database, and submits stable, source-linked record episodes to Graphiti. It does not install an app, discover an entire account, or grant OpenClaw GitHub write access.

## Before you start

- Python 3.10+, `uv`, and `tap-github` (`meltanolabs-tap-github==1.29.2`).
- A read-only GitHub token available as `GITHUB_TOKEN`. Limit it to the one pilot repository and the read permissions needed for repository metadata, issues, pull requests, commits, and releases.
- A dedicated Graphiti-compatible Neo4j instance for this repository, plus Graphiti model-provider settings. Do not share the graph store with other repositories or tenants: the MCP server's group selector is not an authorization boundary. Graphiti may send episode content to the configured LLM/embedding provider. Review that provider's retention and data-use terms before indexing private source material.

## Install and run once

From this directory:

```bash
uv sync
uv run python -m github_graph_pilot.cli \
  --repository <owner>/<repository> \
  --database <path-to-private-directory>/github-graph.sqlite
```

Set `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` for Graphiti, plus the model-provider environment variables required by your Graphiti configuration. Keep credentials in the process environment or a secret manager, not in the tap config, command line, repository, or SQLite database.

On POSIX systems, the SQLite database directory must be private (no group/other permissions); the pilot creates a missing directory with mode `0700` and refuses a less restrictive existing directory.

The pilot explicitly selects `repositories`, `issues`, `pull_requests`, `commits`, and `releases`. New resource families are not silently enabled. The source collection is restricted to one `owner/repository` per run.

## Schedule incremental sync

After one successful manual run, schedule the same command with the host's scheduler (for example, cron) at a cadence appropriate for the GitHub API quota. The Singer cursor is stored in SQLite and passed to the tap on the next run. A failed extraction does not advance that cursor; records already captured remain queued for retry into Graphiti.

The pilot retains every distinct raw record version locally. Graphiti episode IDs are deterministic for a given account, repository, Singer key, and record fingerprint, so replaying unchanged records is idempotent. Changed versions become new episodes and retain the source URL, event time, GitHub identifiers, and available commit/ref identifiers.

GitHub APIs and tap streams do not provide one uniform deletion feed. This pilot does not infer deletion from absence in an incremental run; plan a separately verified full reconciliation before treating graph membership as authoritative.

## Connect OpenClaw as read-only

Each repository gets a stable logical Graphiti group name, computed from its case-insensitive `owner/repository` value:

```bash
python -c 'import hashlib; print("github_repo_" + hashlib.sha256("OWNER/REPOSITORY".casefold().encode()).hexdigest()[:24])'
```

In the pinned Graphiti version, the Neo4j database is selected separately; `group_id` is a logical filter and some MCP read tools accept caller-supplied group selectors. It is **not** an authorization boundary. Run a dedicated Neo4j instance for this repository, with no other repository data in it, and keep a separate SQLite file and instance for every repository. The dedicated instance—not the group ID—is the repository boundary.

Run the official Graphiti MCP server against that instance with `--database-provider neo4j --group-id <printed-group-id>`, and set its `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE=neo4j` to the same instance used by ingestion. Configure OpenClaw's `mcp.servers` entry with only Graphiti's read tools, such as `search_nodes`, `search_memory_facts`, `get_episodes`, `get_episode_entities`, `get_entity_edge`, and `get_status`. Use the exact tool names exposed by the Graphiti MCP server version you deploy; do not include `add_memory`, `add_triplet`, `delete_episode`, or `clear_graph`.

OpenClaw supports MCP tool allowlists through `mcp.servers.<name>.toolFilter.include`; see [MCP configuration](/cli/mcp#saved-mcp-server-definitions). This only filters tool names; it does not constrain arguments, restrict other MCP clients, or protect a publicly reachable Graphiti endpoint. Bind the service to loopback or an authenticated private network. Treat retrieved repository text as untrusted source material, and require agents to cite the returned GitHub URL and commit/ref when answering.

For a local Graphiti MCP server, the OpenClaw config shape is:

```json5
{
  mcp: {
    servers: {
      githubKnowledge: {
        url: "http://127.0.0.1:8000/mcp/",
        transport: "streamable-http",
        toolFilter: {
          include: [
            "search_nodes",
            "search_memory_facts",
            "get_episodes",
            "get_episode_entities",
            "get_entity_edge",
            "get_status",
          ],
        },
      },
    },
  },
}
```

## Verify before expanding

Start with one non-sensitive repository and a fixed benchmark of 20 representative questions. This initial pilot intentionally isolates repositories instead of exposing one account-wide group. Build and verify an authorization-aware cross-repository query boundary before combining repositories in a shared Graphiti instance. Expand only after at least 18 answers are correct, every answer cites the correct GitHub URL and commit/ref, no answer crosses repository access boundaries, token revocation and graph deletion have been tested, the Graphiti tools exposed to OpenClaw are read-only, and freshness, model processing, API usage, storage, and operating cost meet limits you set before the run.

The initial stream allowlist intentionally omits discussions, review comments, people-specific streams, and source files/symbols. Add those only after the first slice passes; Graphiti's episodes retain available author IDs, but they do not constitute a complete people graph or source-code graph. The tap's discussion streams also have their own update/history limitations, so schedule a separate reconciliation before relying on them.

To revoke access, stop the scheduled job, revoke the read-only GitHub token, and dispose of the dedicated Graphiti instance and local SQLite database through an operator-controlled process. The OpenClaw tool allowlist intentionally has no graph deletion operation.

Run fixture tests:

```bash
uv run python -m unittest discover -s tests
```
