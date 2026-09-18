#!/usr/bin/env node
// Sovereign profile generator: probes zero-cost model tiers and writes an
// OpenClaw model/fallback chain from what is actually reachable right now.
//
// Tiers, in default preference order:
//   1. ollama     - local weights, no network egress, no account
//   2. nvidia     - build.nvidia.com free hosted endpoints
//   3. openrouter - models whose live pricing is literally 0/0
//
// API keys are never written to the config. The generated config references
// env var NAMES (OpenClaw's `apiKey` field is a name, not a secret), so the
// config file stays safe to commit or sync.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PROBE_TIMEOUT_MS = 20_000;
const MAX_FALLBACKS_PER_TIER = 3;

// Bundled NVIDIA catalog order, mirrored from extensions/nvidia/openclaw.plugin.json.
// Used only when the live /models probe cannot be reached.
const NVIDIA_STATIC_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3-super-120b-a12b",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-5.1",
];

const args = new Set(process.argv.slice(2));
const flagValue = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const CHECK_ONLY = args.has("--check");
const PRINT_ONLY = args.has("--print");
const PREFER = flagValue("prefer") ?? "local";
const CONFIG_PATH =
  flagValue("config") ??
  process.env.OPENCLAW_CONFIG_PATH ??
  join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw", "openclaw.json");

const log = (...m) => console.error(...m);

async function fetchJson(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    return { data: await res.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// --- Tier probes -----------------------------------------------------------
// Each probe returns { id, available, reason?, modelRefs: string[], provider? }.

async function probeOllama() {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL;
  const { data, error } = await fetchJson(`${baseUrl}/api/tags`);
  if (error) {
    return {
      id: "ollama",
      available: false,
      reason: `${baseUrl} unreachable (${error})`,
      modelRefs: [],
    };
  }
  const names = (data?.models ?? [])
    .map((m) => (typeof m?.name === "string" ? m.name : undefined))
    .filter(Boolean);
  if (names.length === 0) {
    return {
      id: "ollama",
      available: false,
      reason: `${baseUrl} is up but has no models pulled`,
      modelRefs: [],
    };
  }
  // Largest-first is a poor proxy for capability, so keep Ollama's own order
  // (most recently modified first) and let the operator reorder if needed.
  return {
    id: "ollama",
    available: true,
    reason: `${names.length} local model(s) at ${baseUrl}`,
    modelRefs: names.map((n) => `ollama/${n}`),
    provider: { baseUrl, api: "openai-completions" },
  };
}

async function probeNvidia() {
  const key = process.env.NVIDIA_API_KEY?.trim();
  if (!key) {
    return { id: "nvidia", available: false, reason: "NVIDIA_API_KEY not set", modelRefs: [] };
  }
  const { data, error } = await fetchJson(`${NVIDIA_BASE_URL}/models`, {
    Authorization: `Bearer ${key}`,
  });
  let ids = NVIDIA_STATIC_MODELS;
  let reason = `live catalog unavailable (${error}); using bundled catalog`;
  if (!error) {
    const live = (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string");
    // Keep bundled ordering for models the live catalog confirms, then append
    // anything new NVIDIA is serving that the bundled list predates.
    const confirmed = NVIDIA_STATIC_MODELS.filter((id) => live.includes(id));
    ids = confirmed.length > 0 ? confirmed : live;
    reason = `${live.length} model(s) served, key accepted`;
  }
  return {
    id: "nvidia",
    available: ids.length > 0,
    reason,
    modelRefs: ids.map((id) => `nvidia/${id}`),
    provider: { baseUrl: NVIDIA_BASE_URL, api: "openai-completions", apiKey: "NVIDIA_API_KEY" },
  };
}

async function probeOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return {
      id: "openrouter",
      available: false,
      reason: "OPENROUTER_API_KEY not set",
      modelRefs: [],
    };
  }
  const { data, error } = await fetchJson(OPENROUTER_MODELS_URL);
  if (error) {
    return {
      id: "openrouter",
      available: false,
      reason: `catalog unreachable (${error})`,
      modelRefs: [],
    };
  }
  // "Free" is asserted by live pricing, never by the ":free" name suffix —
  // the suffix is a naming convention, the pricing fields are the contract.
  const free = (data?.data ?? [])
    .filter((m) => m?.pricing?.prompt === "0" && m?.pricing?.completion === "0")
    .toSorted((a, b) => (b?.context_length ?? 0) - (a?.context_length ?? 0))
    .map((m) => m.id)
    .filter((id) => typeof id === "string");
  if (free.length === 0) {
    return {
      id: "openrouter",
      available: false,
      reason: "no 0-cost models in live catalog",
      modelRefs: [],
    };
  }
  return {
    id: "openrouter",
    available: true,
    reason: `${free.length} zero-cost model(s) in live catalog`,
    modelRefs: free.map((id) => `openrouter/${id}`),
  };
}

// --- Config assembly -------------------------------------------------------

function orderTiers(tiers, prefer) {
  const order =
    prefer === "nvidia"
      ? ["nvidia", "ollama", "openrouter"]
      : prefer === "openrouter"
        ? ["openrouter", "nvidia", "ollama"]
        : ["ollama", "nvidia", "openrouter"];
  return order.map((id) => tiers.find((t) => t.id === id)).filter(Boolean);
}

function buildModelChain(ordered) {
  const chain = [];
  for (const tier of ordered.filter((t) => t.available)) {
    chain.push(...tier.modelRefs.slice(0, MAX_FALLBACKS_PER_TIER));
  }
  return { primary: chain[0], fallbacks: chain.slice(1) };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deep merge that lets the generated sovereign keys win while leaving every
// unrelated branch of the operator's existing config untouched.
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

function buildConfigPatch(ordered, chain) {
  const providers = {};
  for (const tier of ordered) {
    if (tier.available && tier.provider) {
      providers[tier.id] = tier.provider;
    }
  }
  const patch = {
    agents: { defaults: { model: { primary: chain.primary, fallbacks: chain.fallbacks } } },
  };
  if (Object.keys(providers).length > 0) {
    patch.models = { providers };
  }
  return patch;
}

async function readExistingConfig(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {};
    }
    throw new Error(`existing config at ${path} is not readable JSON: ${err.message}`, {
      cause: err,
    });
  }
}

async function writeConfigAtomic(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.sovereign.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// --- Main ------------------------------------------------------------------

async function main() {
  const tiers = await Promise.all([probeOllama(), probeNvidia(), probeOpenRouter()]);
  const ordered = orderTiers(tiers, PREFER);

  log(`Sovereign preflight (prefer=${PREFER})`);
  for (const tier of ordered) {
    log(`  ${tier.available ? "OK  " : "SKIP"} ${tier.id.padEnd(11)} ${tier.reason}`);
  }

  const chain = buildModelChain(ordered);
  if (!chain.primary) {
    log("\nNo zero-cost tier is reachable. Fix at least one:");
    log("  ollama     : install from https://ollama.com, then `ollama pull <model>`");
    log("  nvidia     : export NVIDIA_API_KEY from https://build.nvidia.com/settings/api-keys");
    log("  openrouter : export OPENROUTER_API_KEY from https://openrouter.ai/keys");
    process.exit(1);
  }

  log(`\nPrimary  : ${chain.primary}`);
  for (const f of chain.fallbacks) {
    log(`Fallback : ${f}`);
  }

  const patch = buildConfigPatch(ordered, chain);
  if (PRINT_ONLY) {
    console.log(JSON.stringify(patch, null, 2));
    return;
  }
  if (CHECK_ONLY) {
    log("\n--check: no config written.");
    return;
  }

  const existing = await readExistingConfig(CONFIG_PATH);
  await writeConfigAtomic(CONFIG_PATH, mergeDeep(existing, patch));
  log(`\nWrote ${CONFIG_PATH}`);
  log("Verify with: openclaw models list");
}

try {
  await main();
} catch (err) {
  log(`sovereign-up failed: ${err?.message ?? err}`);
  process.exit(1);
}
