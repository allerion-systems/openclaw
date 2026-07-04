# _/O.S\_ Second Brain

Allerion-owned app. Telegraph style. This folder is Allerion product code, not
upstream OpenClaw — keep it self-contained; never import from `src/**`.

## What this is

- `second-brain.html`: the full 2D/3D knowledge-graph app (force-graph over
  `#brainData` JSON), shipped with a starter dataset only. This file is the
  CODE and is safe to commit.
- `build.mjs`: splices a real graph JSON into the shell and emits the
  self-contained artifact (`Allerion-Brain.html`) that lives in Google Drive.

## Hard rules

- PRIVACY: never commit a real brain graph. Personal `brainData` (contacts,
  finances, client detail) stays out of git — Drive/local only. The shell in
  git carries only `brain-core`, category hubs, and one sample node.
- Never commit secrets: the vault rule applies — no passwords, keys, tokens,
  SSNs/EINs, bank data, payroll detail in any node body.
- Edit the app by editing `second-brain.html` (single file, no build step for
  the code itself). Keep it dependency-light: pinned CDN force-graph libs only.

## Graph schema

- node: `{ id, label, detail, category, group, val }`; optional `path` points
  at the source memory/vault file on the owner's machine.
- link: `{ source, target }`; both must resolve to node ids (build.mjs checks).
- categories map to hubs (`hub-<Category>`); new nodes should link to their hub.

## Update flow

1. Edit or generate the graph JSON (canonical source: memory `*.md` files +
   `os/brain/graph` on the owner's Mac; Drive artifact is a snapshot).
2. `node build.mjs graph.json Allerion-Brain.html`
3. Upload the artifact to Drive, replacing the previous snapshot.
