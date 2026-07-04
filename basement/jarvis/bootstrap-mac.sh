#!/usr/bin/env bash
# Project BASEMENT JARVIS — Mac (brain) bootstrap.
# Installs OpenClaw, onboards, and starts the Gateway LAN-bound so the Xbox's
# Edge browser and the other basement devices can reach the Control UI.
set -euo pipefail

say() { printf '\n[jarvis] %s\n' "$*"; }

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Node 22+ required. Install it first (brew install node), then re-run."
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  say "Installing OpenClaw..."
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
fi

if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  say "First run — onboarding (pick your provider: Anthropic key if online, a local provider if the basement is offline)."
  openclaw onboard
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<mac-lan-ip>")

say "Starting Gateway LAN-bound on :18789 (token auth stays ON — every device must be paired)."
say "Xbox:   open Edge -> http://${LAN_IP}:18789/"
say "iPad:   OpenClaw iOS app -> gateway ws://${LAN_IP}:18789"
say "Lenovo: openclaw node run --gateway ws://${LAN_IP}:18789"
say "Approve each device from this Mac: openclaw devices list && openclaw devices approve <requestId>"

exec openclaw gateway --bind lan --port 18789
