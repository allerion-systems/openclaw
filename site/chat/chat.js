// Allerion Chat — minimal external client for the OpenClaw gateway WebSocket protocol.
// Protocol: connect.challenge event -> connect req (token + optional Ed25519 device auth)
// -> hello-ok res -> chat.send req -> streaming "chat" events (delta/final/error/aborted).

const SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
const CLIENT = {
  id: "openclaw-control-ui",
  version: "allerion-chat",
  platform: "web",
  mode: "webchat",
};
const SETTINGS_KEY = "allerion-chat-settings-v1";
const IDENTITY_KEY = "allerion-device-identity-v1";
const DEVICE_TOKEN_KEY = "allerion-device-token-v1";

const $ = (id) => document.getElementById(id);
const log = $("log"),
  input = $("input"),
  sendBtn = $("send"),
  wrap = $("wrap");
const statusPill = $("status"),
  statusText = $("statustext");

// ---------- base64url / hashing ----------
const b64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
const unb64u = (s) => {
  const n = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(n + "=".repeat((4 - (n.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const sha256hex = async (bytes) => {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ---------- settings ----------
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function defaultGatewayUrl() {
  // Same-origin default: when this page is served by the gateway itself.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (location.host) return `${proto}://${location.host}`;
  return "ws://127.0.0.1:18789";
}

// ---------- Ed25519 device identity (WebCrypto; optional if unsupported) ----------
async function loadOrCreateIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.publicKey && p?.privateKeyPkcs8) {
        const deviceId = await sha256hex(unb64u(p.publicKey));
        return { deviceId, publicKey: p.publicKey, privateKeyPkcs8: p.privateKeyPkcs8 };
      }
    }
  } catch {
    /* regenerate below */
  }
  try {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const identity = { publicKey: b64u(rawPub), privateKeyPkcs8: b64u(pkcs8) };
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    return { deviceId: await sha256hex(rawPub), ...identity };
  } catch {
    return null; // Ed25519 unsupported -> token-only auth (fine on loopback / token gateways)
  }
}
async function signPayload(identity, payload) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    unb64u(identity.privateKeyPkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(payload));
  return b64u(sig);
}
// v2 device-auth payload: v2|deviceId|clientId|clientMode|role|scopes,csv|signedAtMs|token|nonce
function deviceAuthPayloadV2(p) {
  return [
    "v2",
    p.deviceId,
    CLIENT.id,
    CLIENT.mode,
    "operator",
    SCOPES.join(","),
    String(p.signedAtMs),
    p.token ?? "",
    p.nonce,
  ].join("|");
}

// ---------- UI helpers ----------
function sys(text) {
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function bubble(role, text) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  msg.appendChild(b);
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
  return b;
}
function setStatus(kind, text) {
  statusPill.className = `pill ${kind}`;
  statusText.textContent = text;
  const connected = kind === "ok";
  sendBtn.disabled = !connected;
  wrap.classList.toggle("idle", !connected);
}

// ---------- gateway client ----------
let ws = null,
  seq = 0,
  backoff = 800,
  wantOpen = false;
let mainSessionKey = "agent:main:main";
let pending = new Map(); // req id -> {resolve,reject}
let runs = new Map(); // runId -> {bubble, text, caret}
let settings = loadSettings();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function buildConnectParams(nonce) {
  const auth = {};
  const deviceToken = localStorage.getItem(`${DEVICE_TOKEN_KEY}:${settings.url}`);
  if (settings.token) auth.token = settings.token;
  else if (deviceToken) auth.deviceToken = deviceToken;
  const params = {
    minProtocol: 4,
    maxProtocol: 4,
    client: { ...CLIENT, instanceId: crypto.randomUUID() },
    role: "operator",
    scopes: SCOPES,
    caps: ["tool-events"],
    userAgent: navigator.userAgent,
    locale: navigator.language || "en-US",
  };
  if (auth.token || auth.deviceToken) params.auth = auth;
  const identity = await loadOrCreateIdentity();
  if (identity) {
    const signedAtMs = Date.now();
    const payload = deviceAuthPayloadV2({
      deviceId: identity.deviceId,
      signedAtMs,
      token: auth.token ?? auth.deviceToken ?? null,
      nonce: nonce ?? "",
    });
    params.device = {
      id: identity.deviceId,
      publicKey: identity.publicKey,
      signature: await signPayload(identity, payload),
      signedAt: signedAtMs,
      nonce: nonce ?? "",
    };
  }
  return params;
}

async function doConnect(nonce) {
  try {
    const hello = await rpc("connect", await buildConnectParams(nonce));
    backoff = 800;
    if (hello?.auth?.deviceToken) {
      localStorage.setItem(`${DEVICE_TOKEN_KEY}:${settings.url}`, hello.auth.deviceToken);
    }
    mainSessionKey =
      settings.session?.trim() ||
      hello?.snapshot?.sessionDefaults?.mainSessionKey ||
      "agent:main:main";
    setStatus("ok", "connected");
    sys(`connected · session ${mainSessionKey}`);
    input.focus();
  } catch (err) {
    const code = err?.details?.code || err?.code || "";
    if (String(code) === "PAIRING_REQUIRED" || /pairing/i.test(err?.message ?? "")) {
      sys(
        "This device needs approval on the gateway: run `openclaw devices approve` (or approve it in the Control UI), then reconnect.",
      );
    } else {
      sys(`connect failed: ${err?.message ?? err}`);
    }
    setStatus("", "auth failed");
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  }
}

function connect() {
  if (!settings.url) {
    setStatus("", "not configured");
    return;
  }
  wantOpen = true;
  setStatus("busy", "connecting…");
  let sawChallenge = false;
  try {
    ws = new WebSocket(settings.url);
  } catch (err) {
    setStatus("", "bad URL");
    sys(`cannot open socket: ${err?.message ?? err}`);
    return;
  }
  const fallback = setTimeout(() => {
    if (!sawChallenge && ws?.readyState === 1) doConnect(null);
  }, 800);

  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame.type === "res") {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      frame.ok ? p.resolve(frame.payload) : p.reject(frame.error ?? new Error("request failed"));
      return;
    }
    if (frame.type !== "event") return;
    if (frame.event === "connect.challenge") {
      sawChallenge = true;
      clearTimeout(fallback);
      doConnect(frame.payload?.nonce ?? null);
      return;
    }
    if (frame.event === "chat") handleChatEvent(frame.payload);
  };
  ws.onclose = (ev) => {
    clearTimeout(fallback);
    pending.forEach((p) => p.reject(new Error("connection closed")));
    pending.clear();
    for (const run of runs.values()) run.caret?.remove();
    runs.clear();
    if (!wantOpen) {
      setStatus("", "disconnected");
      return;
    }
    setStatus("busy", `reconnecting…`);
    if (ev.code === 1008) sys(`gateway refused the connection (${ev.reason || "policy"}).`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
  ws.onerror = () => {
    /* onclose handles retry */
  };
}

function handleChatEvent(p) {
  if (!p?.runId) return;
  let run = runs.get(p.runId);
  if (p.state === "delta") {
    if (!run) {
      const b = bubble("bot", "");
      const caret = document.createElement("span");
      caret.className = "caret";
      b.appendChild(caret);
      run = { bubble: b, text: "", caret };
      runs.set(p.runId, run);
    }
    if (typeof p.deltaText === "string") {
      run.text = p.replace ? p.deltaText : run.text + p.deltaText;
      run.bubble.textContent = run.text;
      run.bubble.appendChild(run.caret);
      log.scrollTop = log.scrollHeight;
    }
    return;
  }
  if (p.state === "final" || p.state === "aborted" || p.state === "error") {
    if (run) {
      run.caret.remove();
      const finalText = p.message?.text ?? p.message?.content;
      if (typeof finalText === "string" && finalText.length >= run.text.length) {
        run.bubble.textContent = finalText;
      }
      runs.delete(p.runId);
    } else if (p.state === "final") {
      const finalText = p.message?.text ?? p.message?.content;
      if (typeof finalText === "string" && finalText) bubble("bot", finalText);
    }
    if (p.state === "error") sys(`agent error: ${p.errorMessage ?? p.errorKind ?? "unknown"}`);
    if (p.state === "aborted") sys("run aborted");
  }
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  input.value = "";
  input.style.height = "auto";
  bubble("you", text);
  try {
    await rpc("chat.send", {
      sessionKey: mainSessionKey,
      message: text,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (err) {
    sys(`send failed: ${err?.message ?? err}`);
  }
}

// ---------- wiring ----------
sendBtn.onclick = sendMessage;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});

const dlg = $("settings");
$("gear").onclick = () => {
  $("s-url").value = settings.url ?? defaultGatewayUrl();
  $("s-token").value = settings.token ?? "";
  $("s-session").value = settings.session ?? "";
  dlg.showModal();
};
$("s-cancel").onclick = () => dlg.close();
$("s-save").onclick = () => {
  settings = {
    url: $("s-url")
      .value.trim()
      .replace(/^http(s?):/, "ws$1:"),
    token: $("s-token").value.trim(),
    session: $("s-session").value.trim(),
  };
  saveSettings(settings);
  dlg.close();
  wantOpen = false;
  try {
    ws?.close();
  } catch {
    /* not open */
  }
  setTimeout(connect, 50);
};

// URL fragment token support like the Control UI: #token=... (never sent to server in URL)
if (location.hash.startsWith("#token=")) {
  settings.token = decodeURIComponent(location.hash.slice(7));
  settings.url ||= defaultGatewayUrl();
  saveSettings(settings);
  history.replaceState(null, "", location.pathname + location.search);
}

if (settings.url) connect();
else setStatus("", "not configured");
