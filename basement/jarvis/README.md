# Project BASEMENT JARVIS

**Mission:** build a working Jarvis in 12 hours using an Xbox One, an SSB, an iPad,
a Windows Lenovo laptop, and a Mac with 24 GB of RAM. No Stark Industries budget.

**The trick:** you do not build Jarvis *inside* the Xbox. The Xbox One is a locked
console — it will not run arbitrary code without Dev Mode. But it has Microsoft Edge,
and OpenClaw's Gateway serves a full browser Control UI on port `18789`
(`docs/web/control-ui.md`). So the Mac becomes the **brain**, and the Xbox becomes
the **face on the big screen**. Cave, TV, glowing assistant. That's the movie shot.

## Device roles

| Device | Role | Why |
| --- | --- | --- |
| Mac (24 GB) | **Brain** — OpenClaw Gateway + model provider | Only box that can comfortably run the gateway plus a local model if the basement has no internet |
| Xbox One | **Face** — Edge browser → Control UI on the TV | Console is locked; the browser is the supported way in |
| iPad | **Voice** — OpenClaw iOS node: Talk mode + voice wake | `docs/nodes/talk.md`, `docs/nodes/voicewake.md`; the wake word list is gateway-owned and syncs to every node |
| Windows Lenovo | **Hands** — second node for browser automation / camera / overflow | `openclaw node run` (`docs/nodes/index.md`); nodes are peripherals, the gateway stays on the Mac |
| SSB | Morale. Smash Bros. between build phases | Non-negotiable |

## The 12 hours

| Hours | Phase |
| --- | --- |
| 0–1 | Mac: run `bootstrap-mac.sh` (installs OpenClaw, onboards, LAN-binds the gateway) |
| 1–2 | Pick the brain: Anthropic API key if the basement has internet; local model via a local provider if it doesn't. 24 GB fits a mid-size local model |
| 2–3 | Xbox: Edge → `http://<mac-lan-ip>:18789/` — approve the pairing request from the Mac (`openclaw devices approve <requestId>`) |
| 3–5 | iPad: install the OpenClaw iOS node, pair it, enable Talk mode |
| 5–6 | Set the wake word to `jarvis` in the Control UI voice settings (global list, gateway-owned, broadcasts to all nodes) |
| 6–8 | Lenovo: `openclaw node run` → pairs as a node, contributes browser automation and system commands |
| 8–10 | Personality pass: name the agent Jarvis, dry British wit in the system prompt, wire TTS (`docs/tools/tts.md`) so answers are spoken |
| 10–11 | Integration test: say "Jarvis" at the iPad, watch the reply render on the Xbox-driven TV while the Mac thinks and the Lenovo fetches |
| 11–12 | SSB. You've earned it |

## Wiring

```
        "Jarvis, run a diagnostic"
  iPad ── mic/talk ──┐
                     ▼
              Mac  ── Gateway :18789 ── brain (API or local model)
                     ▲         ▲
  Lenovo ── node ────┘         └── ws ── Xbox One ── Edge ── TV
```

## Security note (yes, even in a basement)

A LAN bind expands the attack surface (`docs/gateway/security/index.md`). The
bootstrap keeps gateway token auth on; every new device (Xbox Edge included) must be
approved with `openclaw devices approve`. Do not disable that to save five minutes.
