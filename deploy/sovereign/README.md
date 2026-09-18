# Sovereign profile

Runs OpenClaw on a zero-cost model stack with a local-first fallback chain.
No Anthropic key, no OpenAI key, no per-token bill.

## What it does

`sovereign-up.mjs` probes three tiers, keeps the ones that actually answer, and
writes a single `agents.defaults.model` chain into `~/.openclaw/openclaw.json`.

| Tier         | Sovereignty                          | Cost | Requires                           |
| ------------ | ------------------------------------ | ---- | ---------------------------------- |
| `ollama`     | Full — weights local, no egress      | $0   | Ollama running with a model pulled |
| `nvidia`     | Hosted, free endpoints               | $0   | `NVIDIA_API_KEY`                   |
| `openrouter` | Hosted, models priced at literal 0/0 | $0   | `OPENROUTER_API_KEY`               |

Default order is `ollama` then `nvidia` then `openrouter`: the most sovereign
tier that works becomes primary, everything else becomes fallback. If the local
box is asleep or out of VRAM, OpenClaw's failover walks down the chain instead
of stopping (see `docs/concepts/model-failover.md`).

## Usage

```bash
# See what is reachable; writes nothing.
node deploy/sovereign/sovereign-up.mjs --check

# Write the chain into ~/.openclaw/openclaw.json (merges, does not clobber).
node deploy/sovereign/sovereign-up.mjs

# Prefer a hosted tier as primary (local stays in the chain as fallback).
node deploy/sovereign/sovereign-up.mjs --prefer=nvidia

# Emit the config patch to stdout for review or for your own merge tooling.
node deploy/sovereign/sovereign-up.mjs --print
```

Flags: `--check`, `--print`, `--prefer=local|nvidia|openrouter`, `--config=<path>`.
Config path resolution follows OpenClaw: `--config`, then `OPENCLAW_CONFIG_PATH`,
then `$OPENCLAW_HOME/.openclaw/openclaw.json`, then `~/.openclaw/openclaw.json`.

Exit code is `1` when no tier is reachable, so it is safe to gate a boot script
on it.

## Getting each tier up

**Ollama** — install from https://ollama.com, then pull anything:

```bash
ollama pull qwen3:8b && ollama serve
```

Set `OLLAMA_BASE_URL` if it is not on `http://127.0.0.1:11434`. The script uses
the models Ollama reports from `/api/tags`, so whatever you pulled is what gets
configured — no guessing at names that may not be on disk.

**NVIDIA** — key from https://build.nvidia.com/settings/api-keys:

```bash
export NVIDIA_API_KEY="nvapi-..."
```

The script probes `https://integrate.api.nvidia.com/v1/models` and intersects
the response with OpenClaw's bundled NVIDIA catalog, so a key that has been
revoked or rate-limited shows up at setup time rather than at 3am. See
`docs/providers/nvidia.md`.

**OpenRouter** — key from https://openrouter.ai/keys:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Free models are selected by reading live `pricing.prompt` and
`pricing.completion` and keeping only the literal `"0"` rows, ranked by context
window. The `:free` suffix is a naming convention and is deliberately not
trusted as the cost signal — pricing is the contract, the name is not. This also
means the chain re-derives itself when OpenRouter's free roster changes; re-run
the script instead of editing model IDs by hand.

## Secrets

Keys are never written into the config. OpenClaw's `apiKey` field holds an env
var name, not a value, so the generated `models.providers` block references
`NVIDIA_API_KEY` rather than embedding it. Keep the keys in your shell env or
`~/.openclaw/credentials/`. The config is written atomically at mode `0600`.

## Verifying

```bash
openclaw models list        # chain should show your tiers
openclaw onboard            # if this is a fresh install
```

## Known limits

- Free hosted tiers are rate-limited and the limits are not published as a
  stable contract. A chain that is entirely hosted will stall under sustained
  agent load. Local Ollama is the only tier with no throttle you do not control.
- Small local models are materially weaker at tool calling than frontier models.
  Expect to tune which local model sits at the head of the chain.
- The script configures model routing only. Channels, skills, and gateway setup
  still go through `openclaw onboard`.
