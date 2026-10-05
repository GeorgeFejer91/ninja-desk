import VDONinja from "@vdoninja/sdk";
import { invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import logoUrl from "../branding/ninja-desk.svg";
import { fingerprints } from "../src/fingerprints";
import { clipboardMessage, hexToBytes, hmacBytes, hmacHex, importHmacKey, isRecord, mouseMessage, nonce, parseAccessFragment, roomFromPassword, routePasswordForAccessLink, transcript } from "../src/protocol";
import { watchTextFit } from "../src/text-fit";
import { iceRoute } from "../src/route";
import { clampPan, followPoint, imageRect, relativePoint, screenPoint, zoomPan, type View } from "./view-geometry";
import { MouseMoveQueue } from "./mouse-queue";
import { startCliBridge, type CliResult, type RuntimeStatus } from "../src/cli-bridge";
import "./style.css";

const accessFragment = location.hash;
if (accessFragment.startsWith("#access=")) history.replaceState(null, "", location.pathname + location.search);
let initialAccessSecret: string | null = null;
let invalidAccessLink = false;
try { initialAccessSecret = parseAccessFragment(accessFragment)?.secret ?? null; }
catch { invalidAccessLink = true; }

const form = document.querySelector<HTMLFormElement>("#connect-form")!;
const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
const connectButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
const forgetTrustedButton = document.querySelector<HTMLButtonElement>("#forget-trusted");
const status = document.querySelector<HTMLElement>("#status")!;
const session = document.querySelector<HTMLElement>("#session")!;
const screenWrap = document.querySelector<HTMLElement>("#screen-wrap")!;
const video = document.querySelector<HTMLVideoElement>("#screen")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const viewOptions = document.querySelector<HTMLElement>("#view-options")!;
const displayButton = document.querySelector<HTMLButtonElement>("#display-options")!;
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const sessionStatus = document.querySelector<HTMLElement>("#session-status")!;
const routeStatus = document.querySelector<HTMLElement>("#route-status")!;
const clipboardPanel = document.querySelector<HTMLElement>("#clipboard")!;
const clipboardButton = document.querySelector<HTMLButtonElement>("#clipboard-toggle")!;
const remoteText = document.querySelector<HTMLTextAreaElement>("#remote-text")!;
const localText = document.querySelector<HTMLTextAreaElement>("#local-text")!;
const copyRemote = document.querySelector<HTMLButtonElement>("#copy-remote")!;
const pasteLocal = document.querySelector<HTMLButtonElement>("#paste-local")!;
const sendLocal = document.querySelector<HTMLButtonElement>("#send-local")!;
const pinControls = document.querySelector<HTMLButtonElement>("#pin-controls")!;
document.querySelector<HTMLImageElement>("#brand-mark")!.src = logoUrl;
document.querySelector<HTMLLinkElement>("#favicon")!.href = logoUrl;

let sdk: VDONinja | null = null;
let mediaSdk: VDONinja | null = null;
let hostUuid: string | null = null;
let clientUuid: string | null = null;
let room = "";
let passwordBytes: Uint8Array | null = null;
let sessionKey: Uint8Array | null = null;
let sessionSigner: CryptoKey | null = null;
let generation = "";
let clientNonce = "";
let helloSent = false;
let authTranscript = "";
let seq = 0;
let commandQueue: Promise<void> = Promise.resolve();
let lastPosition = { x: 32768, y: 32768 };
let inputMode: "mouse" | "touch" = "mouse";
let touchStart: { x: number; y: number; time: number; secondTap: boolean; consumed: boolean; directValid: boolean } | null = null;
let touchHold: number | null = null;
let lastTap: { x: number; y: number; time: number } | null = null;
const touches = new Map<number, { x: number; y: number }>();
let multi: { time: number; x: number; y: number; distance: number; scale: number; panX: number; panY: number; moved: boolean; directValid: boolean } | null = null;
let threeY: number | null = null;
let suppressTouch = false;
let leftHeld = false;
let viewScale = 1;
let panX = 0;
let panY = 0;
let connectionTimer: number | null = null;
let routeTimer: number | null = null;
let usingAccessLink = false;
type TrustedController = { id: string; secret: string; hostId: string };
let storedTrust: TrustedController | null = null;
let usingTrusted = false;
let manualDisconnect = false;
let retryTimer: number | null = null;
let retryDelay = 1000;
let connectionGeneration = 0;
let automationMode = isTauri() && new URLSearchParams(location.search).get("background") === "1";
let runtimePhase: RuntimeStatus["phase"] = "offline";
let mediaPeer: string | null = null;
let decodedFrames = 0;
let lastDecodedAt: number | null = null;
const pendingAcks = new Map<number, { resolve: () => void; reject: () => void; timer: number }>();
let immersiveFallback = false;
let nativeFullscreen = false;
let fullscreenBusy = false;
let controlsTimer: number | null = null;
const maxZoom = 32;

function setStatus(message: string) {
  status.textContent = message;
  sessionStatus.textContent = message;
  console.info(`[client] ${message}`);
}

function safeError(error: unknown): string {
  return String(error).replace(/[0-9a-f]{32,64}/gi, "[redacted]").slice(0, 160);
}

function resetConnection(message: string) {
  connectionGeneration++;
  const retry = usingTrusted && !!storedTrust && !manualDisconnect;
  runtimePhase = retry ? "reconnecting" : manualDisconnect ? "stopped" : "error";
  for (const pending of pendingAcks.values()) { clearTimeout(pending.timer); pending.reject(); }
  pendingAcks.clear();
  mediaPeer = null;
  decodedFrames = 0;
  lastDecodedAt = null;
  cancelTouch();
  moveQueue.reset();
  commandQueue = Promise.resolve();
  if (document.fullscreenElement === session) void document.exitFullscreen().catch(() => {});
  immersiveFallback = false;
  syncFullscreen();
  if (connectionTimer !== null) clearTimeout(connectionTimer);
  connectionTimer = null;
  if (routeTimer !== null) clearInterval(routeTimer);
  routeTimer = null;
  routeStatus.textContent = "";
  const previous = sdk;
  const previousMedia = mediaSdk;
  sdk = null;
  mediaSdk = null;
  hostUuid = null;
  clientUuid = null;
  passwordBytes = null;
  usingAccessLink = false;
  passwordInput.value = "";
  sessionKey = null;
  sessionSigner = null;
  helloSent = false;
  seq = 0;
  video.srcObject = null;
  viewScale = 1;
  panX = 0;
  panY = 0;
  applyView();
  remoteText.value = "";
  localText.value = "";
  viewOptions.hidden = true;
  clipboardPanel.hidden = true;
  displayButton.setAttribute("aria-expanded", "false");
  clipboardButton.setAttribute("aria-expanded", "false");
  session.hidden = true;
  document.body.classList.remove("in-session");
  form.hidden = false;
  connectButton.disabled = false;
  setStatus(message);
  void previous?.disconnect().catch(() => {});
  void previousMedia?.disconnect().catch(() => {});
  if (retry && retryTimer === null) {
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      const trust = storedTrust;
      if (trust && !manualDisconnect) void connect(trust.secret, false, trust.id);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
}

async function startMedia(password: string, control: VDONinja) {
  const mediaRoom = await roomFromPassword(password);
  if (sdk !== control) return;
  const candidate = new VDONinja({ password, salt: "vdo.ninja" });
  mediaSdk = candidate;
  try {
    candidate.on("track", (received) => {
      if (mediaSdk !== candidate || received.detail.track.kind !== "video") return;
      console.info("[client] desktop video track received");
      video.srcObject = new MediaStream([received.detail.track]);
      if (connectionTimer !== null) clearTimeout(connectionTimer);
      connectionTimer = null;
      connectButton.disabled = false;
      form.hidden = true;
      session.hidden = false;
      document.body.classList.add("in-session");
      setStatus("Connected");
      retryDelay = 1000;
      const mediaPeer = received.detail.uuid;
      runtimePhase = "media_ready";
      rememberMediaPeer(mediaPeer);
      const updateRoute = async () => {
        if (mediaSdk !== candidate) return;
        const entries = (await candidate.getStats(mediaPeer))[mediaPeer] ?? [];
        routeStatus.textContent = iceRoute(entries, "viewer");
      };
      if (routeTimer !== null) clearInterval(routeTimer);
      routeStatus.textContent = "Route unknown";
      routeTimer = window.setInterval(() => { void updateRoute().catch(() => {}); }, 5000);
      void updateRoute().catch(() => {});
      void video.play().catch(() => setStatus("Tap the screen to start video"));
    });
    candidate.on("peerDisconnected", () => {
      if (mediaSdk === candidate) resetConnection("Remote PC disconnected");
    });
    candidate.on("reconnectFailed", () => {
      if (mediaSdk === candidate) resetConnection("Screen connection interrupted. Reconnecting…");
    });
    await candidate.connect();
    if (mediaSdk !== candidate) return;
    await candidate.joinRoom({ room: mediaRoom, password });
    if (mediaSdk !== candidate) return;
    await candidate.view(`host_${mediaRoom}`, { audio: false, video: true });
  } catch (error) {
    if (mediaSdk === candidate) mediaSdk = null;
    await candidate.disconnect().catch(() => {});
    throw error;
  }
}

function send(data: object) {
  if (!sdk || !hostUuid || !sdk.sendData(data, { uuid: hostUuid, allowFallback: false })) {
    throw new Error("Connection closed");
  }
}

function waitForAck(next: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Remote action was not acknowledged"));
    const timer = window.setTimeout(() => { pendingAcks.delete(next); fail(); }, 7000);
    pendingAcks.set(next, { resolve, reject: fail, timer });
  });
}

function sendMouse(op: number, x: number, y: number, arg: number, acknowledge = false): Promise<number> {
  const key = sessionKey;
  const signer = sessionSigner;
  const target = hostUuid;
  const peer = clientUuid;
  const currentSdk = sdk;
  const currentGeneration = generation;
  const job = commandQueue.then(async () => {
    if (!key || !signer || !target || !peer || !currentSdk || sessionKey !== key || sdk !== currentSdk) throw new Error("Connection closed");
    const next = ++seq;
    const mac = await hmacHex(signer, mouseMessage(currentGeneration, peer, next, op, x, y, arg));
    if (sessionKey !== key || sdk !== currentSdk || !currentSdk.sendData({ type: "mouse", seq: next, op, x, y, arg, mac }, { uuid: target, allowFallback: false })) throw new Error("Connection closed");
    if (acknowledge) await waitForAck(next);
    return next;
  });
  commandQueue = job.then(() => {}, () => { if (sdk === currentSdk) setStatus("Connection interrupted"); });
  return job;
}

const moveQueue = new MouseMoveQueue(({ x, y }) => sendMouse(1, x, y, 0));

function queueMouse(op: number, x = lastPosition.x, y = lastPosition.y, arg = 0) {
  if (!sessionKey || !hostUuid || !clientUuid || !sdk) return;
  if (op === 1) { moveQueue.move(x, y); return; }
  moveQueue.cancelPending();
  void sendMouse(op, x, y, arg).catch(() => {});
}

function sendClipboard(text: string, acknowledge = false): Promise<number> {
  if (!sessionKey || !hostUuid || !clientUuid || !sdk) return Promise.reject(new Error("Connection closed"));
  if (new TextEncoder().encode(text).length > 256 * 1024) {
    setStatus("Clipboard text is too large");
    return Promise.reject(new Error("Clipboard too large"));
  }
  const key = sessionKey;
  const signer = sessionSigner;
  const target = hostUuid;
  const peer = clientUuid;
  const currentSdk = sdk;
  const currentGeneration = generation;
  const job = commandQueue.then(async () => {
    if (!signer || sessionKey !== key || sdk !== currentSdk) throw new Error("Connection closed");
    const next = ++seq;
    const mac = await hmacHex(signer, await clipboardMessage(currentGeneration, peer, next, text));
    if (sessionKey !== key || sdk !== currentSdk || !currentSdk.sendData({ type: "clipboard", seq: next, text, mac }, { uuid: target, allowFallback: false })) throw new Error("Connection closed");
    if (acknowledge) await waitForAck(next);
    return next;
  });
  commandQueue = job.then(() => {}, () => { if (sdk === currentSdk) setStatus("Connection interrupted"); });
  return job;
}

function queueClipboard(text: string) { void sendClipboard(text).catch(() => {}); }

function view(): View {
  return { width: screenWrap.clientWidth, height: screenWrap.clientHeight, videoWidth: video.videoWidth, videoHeight: video.videoHeight, scale: viewScale, panX, panY };
}

function localPoint(event: PointerEvent | WheelEvent) {
  const rect = screenWrap.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function point(event: PointerEvent | WheelEvent, allowOutside = false): { x: number; y: number } | null {
  const local = localPoint(event);
  return screenPoint(view(), local.x, local.y, allowOutside);
}

async function handleData(transport: VDONinja, uuid: string, data: unknown) {
  if (sdk !== transport || !isRecord(data) || uuid !== hostUuid) return;
  try {
    if (data.type === "auth_challenge" && typeof data.nonce === "string" && typeof data.generation === "string" && typeof data.hostCert === "string" && typeof data.clientCert === "string" && typeof data.peer === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.peer) && passwordBytes && sdk) {
      console.info("[client] checking certificate fingerprints");
      runtimePhase = "authenticating";
      const password = passwordBytes;
      const pair = await fingerprints(transport, uuid, "viewer");
      if (sdk !== transport || passwordBytes !== password) return;
      console.info("[client] certificate fingerprints ready");
      if (pair.remote !== data.hostCert || pair.local !== data.clientCert) throw new Error("WebRTC peer mismatch");
      generation = data.generation;
      clientUuid = data.peer;
      authTranscript = transcript(room, generation, clientUuid, data.nonce, clientNonce, data.hostCert, data.clientCert);
      const proof = await hmacHex(password, `client|${authTranscript}`);
      if (sdk !== transport || passwordBytes !== password) return;
      send({ type: "auth_proof", clientNonce, proof });
      console.info("[client] proof sent");
      return;
    }
    if (data.type === "auth_challenge") {
      console.warn(`[client] incomplete challenge: fields=${typeof data.nonce}/${typeof data.generation}/${typeof data.hostCert}/${typeof data.clientCert}/${typeof data.peer}`);
    }
    if (data.type === "auth_ok" && typeof data.proof === "string" && typeof data.mediaPassword === "string" && passwordBytes) {
      const password = passwordBytes;
      const currentTranscript = authTranscript;
      const expected = await hmacHex(password, `host|${currentTranscript}`);
      if (sdk !== transport || passwordBytes !== password) return;
      if (data.proof !== expected) throw new Error("Host proof failed");
      if (usingTrusted && storedTrust && data.hostId !== storedTrust.hostId) {
        manualDisconnect = true;
        throw new Error("Trusted host identity changed");
      }
      if (!/^[0-9a-f]{64}$/.test(data.mediaPassword)) throw new Error("Invalid media grant");
      const key = await hmacBytes(password, `session|${currentTranscript}`);
      const mediaPassword = await hmacHex(key, "media|v1");
      const signer = await importHmacKey(key);
      if (sdk !== transport || passwordBytes !== password) return;
      if (data.mediaPassword !== mediaPassword) throw new Error("Media grant mismatch");
      sessionKey = key;
      sessionSigner = signer;
      runtimePhase = "control_ready";
      if (typeof data.width === "number" && typeof data.height === "number" && typeof data.cursorX === "number" && typeof data.cursorY === "number" && Number.isFinite(data.width) && Number.isFinite(data.height) && Number.isFinite(data.cursorX) && Number.isFinite(data.cursorY) && data.width > 1 && data.height > 1) {
        lastPosition = {
          x: clamp(Math.round(data.cursorX * 65535 / (data.width - 1)), 0, 65535),
          y: clamp(Math.round(data.cursorY * 65535 / (data.height - 1)), 0, 65535),
        };
      }
      passwordInput.value = "";
      setStatus("Connecting screen…");
      try {
        await startMedia(data.mediaPassword, transport);
      } catch (error) {
        if (sdk !== transport) return;
        console.warn(`[client] screen connection failed: ${safeError(error)}`);
        resetConnection("Could not start screen");
      }
      return;
    }
    if (data.type === "auth_error") {
      if (usingTrusted && data.reason === "trust_rejected") {
        manualDisconnect = true;
        resetConnection("Trusted access was rejected. Pair this PC again.");
        runtimePhase = "revoked";
        return;
      }
      resetConnection(usingAccessLink ? "Link unavailable. Use the password or create a new link." : "Access denied or host busy");
      return;
    }
    if (data.type === "trusted_revoked" && usingTrusted) {
      manualDisconnect = true;
      resetConnection("The remote PC revoked access. Enter its password to pair again.");
      runtimePhase = "revoked";
      return;
    }
    if (data.type === "session_expired") {
      resetConnection("Session expired. Reconnecting…");
      return;
    }
    if (!sessionKey) return;
    if (data.type === "trusted_grant" && isTauri() &&
        typeof data.id === "string" && /^[0-9a-f]{32}$/.test(data.id) &&
        typeof data.secret === "string" && /^[0-9a-f]{64}$/.test(data.secret) &&
        typeof data.hostId === "string" && /^[0-9a-f]{32}$/.test(data.hostId) &&
        typeof data.mac === "string" && /^[0-9a-f]{64}$/.test(data.mac)) {
      const key = sessionKey;
      const expected = await hmacHex(key, `trusted|${data.hostId}|${data.id}|${data.secret}|${generation}|${clientUuid}`);
      if (sdk !== transport || sessionKey !== key) return;
      if (data.mac !== expected) throw new Error("Invalid trust grant");
      const trust = { id: data.id, secret: data.secret, hostId: data.hostId };
      await nativeInvoke("save_trusted_controller", { trust });
      storedTrust = trust;
      if (sdk !== transport || sessionKey !== key) return;
      usingTrusted = true;
      manualDisconnect = false;
      if (forgetTrustedButton) forgetTrustedButton.hidden = false;
      setStatus("This PC will reconnect automatically");
      return;
    }
    if (data.type === "clipboard" && typeof data.text === "string" && data.text.length <= 256 * 1024) {
      remoteText.value = data.text;
      if (!automationMode) {
        try { await navigator.clipboard.writeText(data.text); } catch { /* Copy button remains available. */ }
      }
      return;
    }
    if (data.type === "ack" && typeof data.seq === "number") {
      moveQueue.ack(data.seq);
      const pending = pendingAcks.get(data.seq);
      if (pending) {
        pendingAcks.delete(data.seq);
        clearTimeout(pending.timer);
        if (data.ok === true) pending.resolve(); else pending.reject();
      }
      if (data.ok === false) setStatus(`Action rejected: ${String(data.reason ?? "unknown")}`);
    }
  } catch (error) {
    if (sdk !== transport) return;
    console.warn(`[client] authentication failed: ${safeError(error)}`);
    resetConnection("Authentication failed");
  }
}

async function connect(password: string, viaLink = false, trustedId?: string) {
  if (connectButton.disabled) return;
  const attemptGeneration = ++connectionGeneration;
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  connectButton.disabled = true;
  runtimePhase = "connecting";
  usingAccessLink = viaLink;
  usingTrusted = !!trustedId;
  manualDisconnect = false;
  try {
    const routePassword = viaLink || trustedId ? await routePasswordForAccessLink(password) : password;
    const nextRoom = await roomFromPassword(routePassword);
    if (connectionGeneration !== attemptGeneration) return;
    room = nextRoom;
    passwordBytes = hexToBytes(password);
    clientNonce = nonce();
    clientUuid = null;
    helloSent = false;
    sdk = new VDONinja({ password: routePassword, salt: "vdo.ninja" });
    const attempt = sdk;
    connectionTimer = window.setTimeout(() => {
      if (sdk === attempt && session.hidden) resetConnection(viaLink ? "Link unavailable. Use the password or create a new link." : "Could not connect. Check the password and host app.");
    }, 30000);
    sdk.on("peerConnected", () => console.info("[client] peer connected"));
    sdk.on("dataChannelOpen", (opened) => {
      console.info(`[client] data channel open: ${opened.detail.type}`);
      if (sdk === attempt && opened.detail.uuid === hostUuid && sessionKey) resetConnection("Reauthenticating…");
    });
    sdk.on("reconnecting", () => console.info("[client] reconnecting"));
    sdk.on("disconnected", () => console.info("[client] signaling disconnected"));
    sdk.on("reconnectFailed", () => {
      if (sdk === attempt) resetConnection("Connection interrupted. Reconnecting…");
    });
    sdk.on("dataChannelOpen", (opened) => {
      if (sdk !== attempt) return;
      if (opened.detail.uuid === hostUuid || hostUuid === null) {
        if (helloSent) return;
        hostUuid = opened.detail.uuid;
        try {
          send({ type: "auth_hello", clientNonce, trustedId, desktop: isTauri() });
          helloSent = true;
          console.info("[client] hello sent");
        } catch (error) {
          hostUuid = null;
          console.warn(`[client] hello failed: ${safeError(error)}`);
        }
      }
    });
    sdk.on("dataReceived", (received) => {
      if (sdk !== attempt) return;
      if (isRecord(received.detail.data) && typeof received.detail.data.type === "string") {
        console.info(`[client] message: ${received.detail.data.type}`);
      }
      if (!received.detail.fallback) void handleData(attempt, received.detail.uuid, received.detail.data);
    });
    sdk.on("track", (received) => {
      if (sdk !== attempt) return;
      if (received.detail.track.kind === "video") console.info("[client] control track received");
    });
    sdk.on("peerDisconnected", (lost) => {
      if (sdk !== attempt) return;
      if (lost.detail.uuid === hostUuid) {
        resetConnection("Remote PC disconnected");
      }
    });
    setStatus(viaLink ? "Connecting with access link…" : "Connecting…");
    await attempt.connect();
    if (sdk !== attempt) return;
    await attempt.joinRoom({ room, password: routePassword });
    if (sdk !== attempt) return;
    await attempt.view(`host_${room}`, { audio: false, video: true });
    if (sdk === attempt && !sessionKey) setStatus("Checking access…");
  } catch (error) {
    if (connectionGeneration !== attemptGeneration) return;
    console.warn(`[client] connection failed: ${safeError(error)}`);
    resetConnection(viaLink ? "Link unavailable. Use the password or create a new link." : "Could not connect. Check the password and host app.");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  usingTrusted = false;
  automationMode = false;
  void connect(passwordInput.value.trim().toLowerCase());
});

if (initialAccessSecret) void connect(initialAccessSecret, true);
else if (invalidAccessLink) setStatus("Invalid access link. Enter the host password instead.");
else if (isTauri()) {
  const startupGeneration = connectionGeneration;
  void nativeInvoke<TrustedController | null>("load_trusted_controller").then((trust) => {
    if (connectionGeneration !== startupGeneration) return;
    storedTrust = trust;
    if (forgetTrustedButton) forgetTrustedButton.hidden = !trust;
    if (trust) void connect(trust.secret, false, trust.id);
  }).catch(() => setStatus("Saved PC unavailable. Enter its password."));
}

async function forgetTrustedPc() {
  manualDisconnect = true;
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  resetConnection("Saved PC forgotten");
  try {
    await nativeInvoke("forget_trusted_controller");
    storedTrust = null;
    usingTrusted = false;
    if (forgetTrustedButton) forgetTrustedButton.hidden = true;
  } catch { setStatus("Could not forget saved PC"); throw new Error("Could not forget saved PC"); }
}
forgetTrustedButton?.addEventListener("click", () => { void forgetTrustedPc().catch(() => {}); });

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function applyView() {
  const pan = clampPan(view());
  panX = pan.x;
  panY = pan.y;
  video.style.transform = `translate(${panX}px, ${panY}px) scale(${viewScale})`;
  document.querySelector<HTMLOutputElement>("#zoom-level")!.value = `${Math.round(viewScale * 100)}%`;
  document.querySelector<HTMLButtonElement>("#fit-view")!.setAttribute("aria-pressed", String(viewScale === 1 && panX === 0 && panY === 0));
}

function zoomAt(scale: number, x = screenWrap.clientWidth / 2, y = screenWrap.clientHeight / 2) {
  const pan = zoomPan(view(), clamp(scale, 1, maxZoom), x, y);
  viewScale = clamp(scale, 1, maxZoom);
  panX = pan.x;
  panY = pan.y;
  applyView();
}

function syncFullscreen() {
  const active = document.fullscreenElement === session || immersiveFallback || nativeFullscreen;
  session.classList.toggle("immersive-fallback", immersiveFallback);
  session.classList.toggle("native-fullscreen", nativeFullscreen);
  document.body.classList.toggle("immersive", immersiveFallback || nativeFullscreen);
  const label = active ? "Exit full screen" : "Full screen";
  fullscreenButton.querySelector<HTMLElement>(".desktop-label")!.textContent = label;
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.title = `${label} (Alt+F)`;
  fullscreenButton.setAttribute("aria-pressed", String(active));
  requestAnimationFrame(applyView);
}

async function toggleFullscreen() {
  if (fullscreenBusy) return;
  fullscreenBusy = true;
  try {
  if (isTauri()) {
    const active = await nativeInvoke<boolean>("get_window_fullscreen");
    nativeFullscreen = await nativeInvoke<boolean>("set_window_fullscreen", { enabled: !active });
  } else
  if (document.fullscreenElement === session) {
    await document.exitFullscreen().catch(() => {});
  } else if (immersiveFallback) {
    immersiveFallback = false;
  } else {
    try {
      if (!session.requestFullscreen) throw new Error("Fullscreen unavailable");
      await session.requestFullscreen();
    } catch {
      immersiveFallback = true;
    }
  }
  syncFullscreen();
  revealControls();
  } catch { setStatus("Could not change full screen"); }
  finally { fullscreenBusy = false; }
}
fullscreenButton.addEventListener("click", () => { void toggleFullscreen(); });
document.addEventListener("fullscreenchange", syncFullscreen);
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.code === "KeyF" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    if (!event.repeat && (!session.hidden || nativeFullscreen)) void toggleFullscreen();
  }
  if (event.key === "Escape" && nativeFullscreen) { event.preventDefault(); void toggleFullscreen(); }
  if (event.key === "Escape" && immersiveFallback) { immersiveFallback = false; syncFullscreen(); }
});

function revealControls() {
  session.classList.add("controls-visible");
  if (controlsTimer !== null) clearTimeout(controlsTimer);
  controlsTimer = window.setTimeout(() => { session.classList.remove("controls-visible"); controlsTimer = null; }, 1400);
}
session.addEventListener("pointermove", (event) => {
  const rect = session.getBoundingClientRect();
  if (event.clientY - rect.top < 10 || rect.bottom - event.clientY < 10) revealControls();
});
pinControls.addEventListener("click", () => {
  const pinned = session.classList.toggle("controls-pinned");
  pinControls.setAttribute("aria-pressed", String(pinned));
  pinControls.textContent = pinned ? "Unpin controls" : "Pin controls";
});
video.addEventListener("loadedmetadata", applyView);
new ResizeObserver(applyView).observe(screenWrap);

function clearHold() {
  if (touchHold !== null) clearTimeout(touchHold);
  touchHold = null;
}

function releaseLeft() {
  if (!leftHeld) return;
  leftHeld = false;
  queueMouse(3);
}

function cancelTouch() {
  clearHold();
  releaseLeft();
  touches.clear();
  touchStart = null;
  multi = null;
  threeY = null;
  suppressTouch = false;
}

function moveAbsolute(event: PointerEvent, allowOutside = false) {
  const position = point(event, allowOutside);
  if (position) { lastPosition = position; queueMouse(1, position.x, position.y); }
}

function moveRelative(dx: number, dy: number) {
  if (!imageRect(view()).width) return;
  lastPosition = relativePoint(view(), lastPosition.x, lastPosition.y, dx, dy);
  if (viewScale > 1) {
    const pan = followPoint(view(), lastPosition.x, lastPosition.y);
    panX = pan.x;
    panY = pan.y;
    applyView();
  }
  queueMouse(1, lastPosition.x, lastPosition.y);
}

function touchGeometry() {
  const values = [...touches.values()];
  const x = values.reduce((sum, touch) => sum + touch.x, 0) / values.length;
  const y = values.reduce((sum, touch) => sum + touch.y, 0) / values.length;
  const distance = values.length === 2 ? Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) : 0;
  return { x, y, distance };
}

screenWrap.addEventListener("contextmenu", (event) => event.preventDefault());
screenWrap.addEventListener("pointerdown", (event) => {
  if (!sessionKey) return;
  if (video.paused && video.srcObject) {
    event.preventDefault();
    void video.play().then(() => setStatus("Connected")).catch(() => setStatus("Could not start video"));
    return;
  }
  event.preventDefault();
  screenWrap.focus({ preventScroll: true });
  screenWrap.setPointerCapture(event.pointerId);
  if (event.pointerType !== "touch") {
    if (!point(event)) return;
    moveAbsolute(event);
    if (event.button === 0) { leftHeld = true; queueMouse(2); }
    else if (event.button === 1) queueMouse(6);
    else if (event.button === 2) queueMouse(5);
    return;
  }
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  clearHold();
  if (touches.size === 1) {
    const time = performance.now();
    const secondTap = !!lastTap && time - lastTap.time < 330 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 28;
    const directValid = inputMode !== "touch" || !!point(event);
    touchStart = { x: event.clientX, y: event.clientY, time, secondTap, consumed: false, directValid };
    if (inputMode === "touch" && directValid) moveAbsolute(event);
    touchHold = window.setTimeout(() => {
      if (!touchStart || !touchStart.directValid || touches.size !== 1 || suppressTouch) return;
      if (touchStart.secondTap) { touchStart.consumed = true; leftHeld = true; queueMouse(2); }
      else { touchStart.consumed = true; queueMouse(5); }
    }, secondTap ? 280 : 560);
    return;
  }
  releaseLeft();
  const directValid = touchStart?.directValid ?? false;
  touchStart = null;
  suppressTouch = true;
  if (touches.size === 2) {
    const geometry = touchGeometry();
    multi = { time: performance.now(), ...geometry, scale: viewScale, panX, panY, moved: false, directValid };
  } else {
    multi = null;
    if (touches.size === 3) threeY = touchGeometry().y;
  }
});

screenWrap.addEventListener("pointermove", (event) => {
  if (!sessionKey) return;
  if (event.pointerType !== "touch") {
    const samples = event.getCoalescedEvents?.() ?? [];
    moveAbsolute(samples[samples.length - 1] ?? event, leftHeld);
    return;
  }
  const previous = touches.get(event.pointerId);
  if (!previous) return;
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touches.size === 3) {
    const y = touchGeometry().y;
    const delta = y - (threeY ?? y);
    if (Math.abs(delta) >= 22) {
      queueMouse(7, lastPosition.x, lastPosition.y, -Math.sign(delta));
      threeY = y;
    }
    return;
  }
  if (touches.size === 2 && multi) {
    const current = touchGeometry();
    if (Math.hypot(current.x - multi.x, current.y - multi.y) > 9 || Math.abs(current.distance - multi.distance) > 9) multi.moved = true;
    const rect = screenWrap.getBoundingClientRect();
    const startView = { ...view(), scale: multi.scale, panX: multi.panX, panY: multi.panY };
    viewScale = clamp(multi.scale * current.distance / Math.max(1, multi.distance), 1, maxZoom);
    const pan = zoomPan(startView, viewScale, multi.x - rect.left, multi.y - rect.top, current.x - rect.left, current.y - rect.top);
    panX = pan.x;
    panY = pan.y;
    applyView();
    return;
  }
  if (!touchStart || suppressTouch) return;
  const distance = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
  if (distance > 9) {
    clearHold();
    if (inputMode === "touch" && touchStart.directValid && !leftHeld) { leftHeld = true; queueMouse(2); }
    if (inputMode === "mouse" && touchStart.secondTap && !leftHeld) { leftHeld = true; queueMouse(2); }
    touchStart.consumed = true;
  }
  if (inputMode === "touch") {
    if (touchStart.directValid) moveAbsolute(event, true);
  } else moveRelative(event.clientX - previous.x, event.clientY - previous.y);
});

function finishPointer(event: PointerEvent) {
  if (event.pointerType !== "touch") { if (event.button === 0) releaseLeft(); return; }
  if (!touches.has(event.pointerId)) return;
  const count = touches.size;
  touches.delete(event.pointerId);
  clearHold();
  if (count === 2 && multi && (inputMode === "mouse" || multi.directValid) && !multi.moved && performance.now() - multi.time < 330 && event.type === "pointerup") queueMouse(5);
  if (count > 1) { multi = null; threeY = null; releaseLeft(); }
  if (touches.size) return;
  if (!suppressTouch && touchStart && event.type === "pointerup") {
    const distance = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
    if (!touchStart.consumed && distance < 12 && performance.now() - touchStart.time < 500) {
      if (inputMode === "touch" && touchStart.directValid) moveAbsolute(event, true);
      if (touchStart.directValid) {
        queueMouse(4);
        lastTap = { x: event.clientX, y: event.clientY, time: performance.now() };
      }
    }
  }
  releaseLeft();
  touchStart = null;
  suppressTouch = false;
}
screenWrap.addEventListener("pointerup", finishPointer);
screenWrap.addEventListener("pointercancel", finishPointer);
screenWrap.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const local = localPoint(event);
    zoomAt(viewScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), local.x, local.y);
    return;
  }
  const position = point(event);
  if (position) lastPosition = position;
  queueMouse(event.shiftKey ? 8 : 7, lastPosition.x, lastPosition.y, Math.sign(event.deltaY));
}, { passive: false });

document.addEventListener("visibilitychange", () => { if (document.hidden) cancelTouch(); });
function disconnectController() {
  manualDisconnect = true;
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  resetConnection("Disconnected");
}
document.querySelector("#disconnect")!.addEventListener("click", disconnectController);
modeButton.addEventListener("click", () => {
  cancelTouch();
  inputMode = inputMode === "mouse" ? "touch" : "mouse";
  modeButton.textContent = inputMode === "mouse" ? "Mouse mode" : "Touch mode";
  modeButton.dataset.mode = inputMode;
  modeButton.setAttribute("aria-label", `Input mode: ${inputMode}`);
});
displayButton.addEventListener("click", () => {
  clipboardPanel.hidden = true;
  clipboardButton.setAttribute("aria-expanded", "false");
  viewOptions.hidden = !viewOptions.hidden;
  displayButton.setAttribute("aria-expanded", String(!viewOptions.hidden));
});
clipboardButton.addEventListener("click", () => {
  viewOptions.hidden = true;
  displayButton.setAttribute("aria-expanded", "false");
  clipboardPanel.hidden = !clipboardPanel.hidden;
  clipboardButton.setAttribute("aria-expanded", String(!clipboardPanel.hidden));
});
document.querySelector("#fit-view")!.addEventListener("click", () => { viewScale = 1; panX = 0; panY = 0; applyView(); });
document.querySelector("#actual-view")!.addEventListener("click", () => {
  if (!video.videoWidth || !video.videoHeight) return;
  viewScale = clamp(Math.max(video.videoWidth / screenWrap.clientWidth, video.videoHeight / screenWrap.clientHeight), 1, maxZoom);
  panX = 0; panY = 0; applyView();
});
document.querySelector("#zoom-out")!.addEventListener("click", () => zoomAt(viewScale / 1.25));
document.querySelector("#zoom-in")!.addEventListener("click", () => zoomAt(viewScale * 1.25));
document.querySelector("#reset-view")!.addEventListener("click", () => { viewScale = 1; panX = 0; panY = 0; applyView(); });

document.querySelector("#right-click")!.addEventListener("click", () => queueMouse(5));
document.querySelector("#scroll-up")!.addEventListener("click", () => queueMouse(7, lastPosition.x, lastPosition.y, -1));
document.querySelector("#scroll-down")!.addEventListener("click", () => queueMouse(7, lastPosition.x, lastPosition.y, 1));
copyRemote.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(remoteText.value); setStatus("Copied to this device"); }
  catch { remoteText.select(); setStatus("Select and copy the text above"); }
});
pasteLocal.addEventListener("click", async () => {
  try { localText.value = await navigator.clipboard.readText(); queueClipboard(localText.value); setStatus("Sent to remote PC"); }
  catch { localText.focus(); setStatus("Paste into the text box, then send"); }
});
sendLocal.addEventListener("click", () => { queueClipboard(localText.value); setStatus("Sent to remote PC"); });
localText.addEventListener("paste", () => { setTimeout(() => queueClipboard(localText.value), 0); });

void watchTextFit();

function rememberMediaPeer(peer: string) { mediaPeer = peer; }

async function controllerRuntime(): Promise<RuntimeStatus> {
  const current = mediaSdk;
  const peer = mediaPeer;
  let frames = video.getVideoPlaybackQuality().totalVideoFrames;
  if (current && peer) {
    try {
      const stats = (await current.getStats(peer))[peer] ?? [];
      if (mediaSdk === current) {
        for (const entry of stats) {
          if (entry.type === "inbound-rtp" && (entry.kind === "video" || entry.mediaType === "video") && typeof entry.framesDecoded === "number") frames = Math.max(frames, entry.framesDecoded);
        }
      }
    } catch { /* Missing stats are reported as unknown, never as ready frames. */ }
  }
  if (frames > decodedFrames) { decodedFrames = frames; lastDecodedAt = performance.now(); }
  const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  return {
    phase: runtimePhase,
    authenticated: !!sessionKey,
    remembered: !!storedTrust,
    retryScheduled: retryTimer !== null,
    mediaActive: !!mediaSdk && track?.readyState === "live",
    frames: decodedFrames,
    lastFrameAgeMs: lastDecodedAt === null ? null : Math.round(performance.now() - lastDecodedAt),
    route: routeStatus.textContent === "Direct" ? "direct" : routeStatus.textContent === "Relayed" ? "relayed" : "unknown",
  };
}

void startCliBridge(controllerRuntime, async (action): Promise<CliResult> => {
  automationMode = true;
  switch (action.type) {
    case "controller_connect": {
      if (action.password !== undefined && !/^[0-9a-f]{64}$/.test(action.password)) return { ok: false, code: "invalid_password" };
      disconnectController();
      if (action.password !== undefined) {
        void connect(action.password);
      } else {
        const trust = await nativeInvoke<TrustedController | null>("load_trusted_controller", { hostId: action.hostId });
        storedTrust = trust;
        if (!trust) return { ok: false, code: "not_paired" };
        void connect(trust.secret, false, trust.id);
      }
      return { ok: true, data: { accepted: true } };
    }
    case "controller_disconnect": disconnectController(); return { ok: true };
    case "controller_forget": await forgetTrustedPc(); return { ok: true };
    case "controller_probe": {
      if (!sessionKey) return { ok: false, code: "not_connected" };
      const startedAt = performance.now();
      await sendMouse(1, lastPosition.x, lastPosition.y, 0, true);
      return { ok: true, data: { acknowledged: true, roundTripMs: Math.round(performance.now() - startedAt) } };
    }
    case "controller_clipboard_send":
      await sendClipboard(action.text, true);
      return { ok: true, data: { acknowledged: true } };
    default: return { ok: false, code: "wrong_window" };
  }
}).catch(() => {});
