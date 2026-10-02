import VDONinja from "@vdoninja/sdk";
import { fingerprints } from "../src/fingerprints";
import { clipboardMessage, hexToBytes, hmacBytes, hmacHex, isRecord, mouseMessage, nonce, roomFromPassword, transcript } from "../src/protocol";
import { watchTextFit } from "../src/text-fit";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#connect-form")!;
const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
const connectButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
const status = document.querySelector<HTMLElement>("#status")!;
const session = document.querySelector<HTMLElement>("#session")!;
const screenWrap = document.querySelector<HTMLElement>("#screen-wrap")!;
const video = document.querySelector<HTMLVideoElement>("#screen")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const viewOptions = document.querySelector<HTMLElement>("#view-options")!;
const displayButton = document.querySelector<HTMLButtonElement>("#display-options")!;
const clipboardPanel = document.querySelector<HTMLElement>("#clipboard")!;
const clipboardButton = document.querySelector<HTMLButtonElement>("#clipboard-toggle")!;
const remoteText = document.querySelector<HTMLTextAreaElement>("#remote-text")!;
const localText = document.querySelector<HTMLTextAreaElement>("#local-text")!;
const copyRemote = document.querySelector<HTMLButtonElement>("#copy-remote")!;
const pasteLocal = document.querySelector<HTMLButtonElement>("#paste-local")!;
const sendLocal = document.querySelector<HTMLButtonElement>("#send-local")!;

let sdk: VDONinja | null = null;
let mediaSdk: VDONinja | null = null;
let hostUuid: string | null = null;
let clientUuid: string | null = null;
let room = "";
let passwordBytes: Uint8Array | null = null;
let sessionKey: Uint8Array | null = null;
let generation = "";
let clientNonce = "";
let helloSent = false;
let authTranscript = "";
let seq = 0;
let queuedMoves = 0;
let commandQueue: Promise<void> = Promise.resolve();
let lastPosition = { x: 32768, y: 32768 };
let inputMode: "mouse" | "touch" = "mouse";
let touchStart: { x: number; y: number; time: number; secondTap: boolean; consumed: boolean } | null = null;
let touchHold: number | null = null;
let lastTap: { x: number; y: number; time: number } | null = null;
const touches = new Map<number, { x: number; y: number }>();
let multi: { time: number; x: number; y: number; distance: number; scale: number; panX: number; panY: number; moved: boolean } | null = null;
let threeY: number | null = null;
let suppressTouch = false;
let leftHeld = false;
let viewScale = 1;
let panX = 0;
let panY = 0;
let connectionTimer: number | null = null;

function setStatus(message: string) {
  status.textContent = message;
  console.info(`[client] ${message}`);
}

function safeError(error: unknown): string {
  return String(error).replace(/[0-9a-f]{32,64}/gi, "[redacted]").slice(0, 160);
}

function resetConnection(message: string) {
  cancelTouch();
  if (connectionTimer !== null) clearTimeout(connectionTimer);
  connectionTimer = null;
  const previous = sdk;
  const previousMedia = mediaSdk;
  sdk = null;
  mediaSdk = null;
  hostUuid = null;
  clientUuid = null;
  passwordBytes = null;
  sessionKey = null;
  helloSent = false;
  seq = 0;
  video.srcObject = null;
  viewScale = 1;
  panX = 0;
  panY = 0;
  applyView();
  remoteText.value = "";
  session.hidden = true;
  form.hidden = false;
  connectButton.disabled = false;
  setStatus(message);
  void previous?.disconnect().catch(() => {});
  void previousMedia?.disconnect().catch(() => {});
}

async function startMedia(password: string) {
  const mediaRoom = await roomFromPassword(password);
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
      setStatus("Connected");
      void video.play().catch(() => setStatus("Tap the screen to start video"));
    });
    candidate.on("peerDisconnected", () => {
      if (mediaSdk === candidate) resetConnection("Laptop disconnected");
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

function queueMouse(op: number, x = lastPosition.x, y = lastPosition.y, arg = 0) {
  if (!sessionKey || !hostUuid || !clientUuid || !sdk) return;
  if (op === 1 && queuedMoves >= 2) return;
  if (op === 1) queuedMoves++;
  commandQueue = commandQueue.then(async () => {
    if (!sessionKey || !sdk || !hostUuid || !clientUuid) return;
    const next = ++seq;
    const mac = await hmacHex(sessionKey, mouseMessage(generation, clientUuid, next, op, x, y, arg));
    send({ type: "mouse", seq: next, op, x, y, arg, mac });
  }).catch(() => setStatus("Connection interrupted")).finally(() => {
    if (op === 1) queuedMoves--;
  });
}

function queueClipboard(text: string) {
  if (!sessionKey || !hostUuid || !clientUuid || !sdk) return;
  if (new TextEncoder().encode(text).length > 256 * 1024) {
    setStatus("Clipboard text is too large");
    return;
  }
  commandQueue = commandQueue.then(async () => {
    if (!sessionKey || !sdk || !hostUuid || !clientUuid) return;
    const next = ++seq;
    const mac = await hmacHex(sessionKey, await clipboardMessage(generation, clientUuid, next, text));
    send({ type: "clipboard", seq: next, text, mac });
  }).catch(() => setStatus("Connection interrupted"));
}

function point(event: PointerEvent | WheelEvent): { x: number; y: number } | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  const x = Math.max(0, Math.min(1, (event.clientX - left) / width));
  const y = Math.max(0, Math.min(1, (event.clientY - top) / height));
  return { x: Math.round(x * 65535), y: Math.round(y * 65535) };
}

async function handleData(uuid: string, data: unknown) {
  if (!isRecord(data) || uuid !== hostUuid) return;
  try {
    if (data.type === "auth_challenge" && typeof data.nonce === "string" && typeof data.generation === "string" && typeof data.hostCert === "string" && typeof data.clientCert === "string" && typeof data.peer === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.peer) && passwordBytes && sdk) {
      console.info("[client] checking certificate fingerprints");
      const pair = await fingerprints(sdk, uuid, "viewer");
      console.info("[client] certificate fingerprints ready");
      if (pair.remote !== data.hostCert || pair.local !== data.clientCert) throw new Error("WebRTC peer mismatch");
      generation = data.generation;
      clientUuid = data.peer;
      authTranscript = transcript(room, generation, clientUuid, data.nonce, clientNonce, data.hostCert, data.clientCert);
      send({ type: "auth_proof", clientNonce, proof: await hmacHex(passwordBytes, `client|${authTranscript}`) });
      console.info("[client] proof sent");
      return;
    }
    if (data.type === "auth_challenge") {
      console.warn(`[client] incomplete challenge: fields=${typeof data.nonce}/${typeof data.generation}/${typeof data.hostCert}/${typeof data.clientCert}/${typeof data.peer}`);
    }
    if (data.type === "auth_ok" && typeof data.proof === "string" && typeof data.mediaPassword === "string" && passwordBytes) {
      const expected = await hmacHex(passwordBytes, `host|${authTranscript}`);
      if (data.proof !== expected) throw new Error("Host proof failed");
      if (!/^[0-9a-f]{64}$/.test(data.mediaPassword)) throw new Error("Invalid media grant");
      sessionKey = await hmacBytes(passwordBytes, `session|${authTranscript}`);
      if (data.mediaPassword !== await hmacHex(sessionKey, "media|v1")) throw new Error("Media grant mismatch");
      if (typeof data.width === "number" && typeof data.height === "number" && typeof data.cursorX === "number" && typeof data.cursorY === "number" && Number.isFinite(data.width) && Number.isFinite(data.height) && Number.isFinite(data.cursorX) && Number.isFinite(data.cursorY) && data.width > 1 && data.height > 1) {
        lastPosition = {
          x: clamp(Math.round(data.cursorX * 65535 / (data.width - 1)), 0, 65535),
          y: clamp(Math.round(data.cursorY * 65535 / (data.height - 1)), 0, 65535),
        };
      }
      passwordInput.value = "";
      setStatus("Connecting screen…");
      try {
        await startMedia(data.mediaPassword);
      } catch (error) {
        console.warn(`[client] screen connection failed: ${safeError(error)}`);
        resetConnection("Could not start screen");
      }
      return;
    }
    if (data.type === "auth_error") {
      resetConnection("Access denied or host busy");
      return;
    }
    if (!sessionKey) return;
    if (data.type === "clipboard" && typeof data.text === "string" && data.text.length <= 256 * 1024) {
      remoteText.value = data.text;
      try { await navigator.clipboard.writeText(data.text); } catch { /* Copy button remains available. */ }
      return;
    }
    if (data.type === "ack" && data.ok === false) setStatus(`Action rejected: ${String(data.reason ?? "unknown")}`);
  } catch (error) {
    console.warn(`[client] authentication failed: ${safeError(error)}`);
    resetConnection("Authentication failed");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (connectButton.disabled) return;
  connectButton.disabled = true;
  try {
    const password = passwordInput.value.trim().toLowerCase();
    room = await roomFromPassword(password);
    passwordBytes = hexToBytes(password);
    clientNonce = nonce();
    clientUuid = null;
    helloSent = false;
    sdk = new VDONinja({ password, salt: "vdo.ninja" });
    const attempt = sdk;
    connectionTimer = window.setTimeout(() => {
      if (sdk === attempt && session.hidden) resetConnection("Could not connect. Check the password and host app.");
    }, 30000);
    sdk.on("peerConnected", () => console.info("[client] peer connected"));
    sdk.on("dataChannelOpen", (opened) => console.info(`[client] data channel open: ${opened.detail.type}`));
    sdk.on("reconnecting", () => console.info("[client] reconnecting"));
    sdk.on("disconnected", () => console.info("[client] signaling disconnected"));
    sdk.on("dataChannelOpen", (opened) => {
      if (sdk !== attempt) return;
      if (opened.detail.uuid === hostUuid || hostUuid === null) {
        if (helloSent) return;
        hostUuid = opened.detail.uuid;
        try {
          send({ type: "auth_hello", clientNonce });
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
      if (!received.detail.fallback) void handleData(received.detail.uuid, received.detail.data);
    });
    sdk.on("track", (received) => {
      if (sdk !== attempt) return;
      if (received.detail.track.kind === "video") console.info("[client] control track received");
    });
    sdk.on("peerDisconnected", (lost) => {
      if (sdk !== attempt) return;
      if (lost.detail.uuid === hostUuid) {
        resetConnection("Laptop disconnected");
      }
    });
    setStatus("Connecting…");
    await attempt.connect();
    if (sdk !== attempt) return;
    await attempt.joinRoom({ room, password });
    if (sdk !== attempt) return;
    await attempt.view(`host_${room}`, { audio: false, video: true });
    if (sdk === attempt && !sessionKey) setStatus("Checking access…");
  } catch (error) {
    console.warn(`[client] connection failed: ${safeError(error)}`);
    resetConnection("Could not connect. Check the password and host app.");
  }
});

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function applyView() {
  const width = screenWrap.clientWidth;
  const height = screenWrap.clientHeight;
  panX = clamp(panX, -(viewScale - 1) * width / 2, (viewScale - 1) * width / 2);
  panY = clamp(panY, -(viewScale - 1) * height / 2, (viewScale - 1) * height / 2);
  video.style.transform = `translate(${panX}px, ${panY}px) scale(${viewScale})`;
  document.querySelector<HTMLOutputElement>("#zoom-level")!.value = `${Math.round(viewScale * 100)}%`;
}

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

function moveAbsolute(event: PointerEvent) {
  const position = point(event);
  if (position) { lastPosition = position; queueMouse(1, position.x, position.y); }
}

function moveRelative(dx: number, dy: number) {
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  lastPosition = {
    x: clamp(Math.round(lastPosition.x + dx * 65535 / rect.width), 0, 65535),
    y: clamp(Math.round(lastPosition.y + dy * 65535 / rect.height), 0, 65535),
  };
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
  event.preventDefault();
  screenWrap.setPointerCapture(event.pointerId);
  if (event.pointerType !== "touch") {
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
    touchStart = { x: event.clientX, y: event.clientY, time, secondTap, consumed: false };
    if (inputMode === "touch") moveAbsolute(event);
    touchHold = window.setTimeout(() => {
      if (!touchStart || touches.size !== 1 || suppressTouch) return;
      if (touchStart.secondTap) { touchStart.consumed = true; leftHeld = true; queueMouse(2); }
      else { touchStart.consumed = true; queueMouse(5); }
    }, secondTap ? 280 : 560);
    return;
  }
  releaseLeft();
  touchStart = null;
  suppressTouch = true;
  if (touches.size === 2) {
    const geometry = touchGeometry();
    multi = { time: performance.now(), ...geometry, scale: viewScale, panX, panY, moved: false };
  } else {
    multi = null;
    if (touches.size === 3) threeY = touchGeometry().y;
  }
});

screenWrap.addEventListener("pointermove", (event) => {
  if (!sessionKey) return;
  if (event.pointerType !== "touch") { moveAbsolute(event); return; }
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
    viewScale = clamp(multi.scale * current.distance / Math.max(1, multi.distance), 1, 4);
    panX = multi.panX + current.x - multi.x;
    panY = multi.panY + current.y - multi.y;
    applyView();
    return;
  }
  if (!touchStart || suppressTouch) return;
  const distance = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
  if (distance > 9) {
    clearHold();
    if (inputMode === "touch" && !leftHeld) { leftHeld = true; queueMouse(2); }
    if (inputMode === "mouse" && touchStart.secondTap && !leftHeld) { leftHeld = true; queueMouse(2); }
    touchStart.consumed = true;
  }
  if (inputMode === "touch") moveAbsolute(event);
  else moveRelative(event.clientX - previous.x, event.clientY - previous.y);
});

function finishPointer(event: PointerEvent) {
  if (event.pointerType !== "touch") { if (event.button === 0) releaseLeft(); return; }
  if (!touches.has(event.pointerId)) return;
  const count = touches.size;
  touches.delete(event.pointerId);
  clearHold();
  if (count === 2 && multi && !multi.moved && performance.now() - multi.time < 330 && event.type === "pointerup") queueMouse(5);
  if (count > 1) { multi = null; threeY = null; releaseLeft(); }
  if (touches.size) return;
  if (!suppressTouch && touchStart && event.type === "pointerup") {
    const distance = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
    if (!touchStart.consumed && distance < 12 && performance.now() - touchStart.time < 500) {
      if (inputMode === "touch") moveAbsolute(event);
      queueMouse(4);
      lastTap = { x: event.clientX, y: event.clientY, time: performance.now() };
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
  const position = point(event);
  if (position) lastPosition = position;
  queueMouse(event.shiftKey ? 8 : 7, lastPosition.x, lastPosition.y, Math.sign(event.deltaY));
}, { passive: false });

document.addEventListener("visibilitychange", () => { if (document.hidden) cancelTouch(); });
document.querySelector("#disconnect")!.addEventListener("click", () => resetConnection("Disconnected"));
modeButton.addEventListener("click", () => {
  cancelTouch();
  inputMode = inputMode === "mouse" ? "touch" : "mouse";
  modeButton.textContent = inputMode === "mouse" ? "Mouse mode" : "Touch mode";
  modeButton.dataset.mode = inputMode;
  modeButton.setAttribute("aria-label", `Input mode: ${inputMode}`);
});
displayButton.addEventListener("click", () => {
  viewOptions.hidden = !viewOptions.hidden;
  displayButton.setAttribute("aria-expanded", String(!viewOptions.hidden));
});
clipboardButton.addEventListener("click", () => {
  clipboardPanel.hidden = !clipboardPanel.hidden;
  clipboardButton.setAttribute("aria-expanded", String(!clipboardPanel.hidden));
});
document.querySelector("#fit-view")!.addEventListener("click", () => { viewScale = 1; panX = 0; panY = 0; applyView(); });
document.querySelector("#actual-view")!.addEventListener("click", () => {
  if (!video.videoWidth || !video.videoHeight) return;
  viewScale = clamp(Math.max(video.videoWidth / screenWrap.clientWidth, video.videoHeight / screenWrap.clientHeight), 1, 4);
  panX = 0; panY = 0; applyView();
});
document.querySelector("#zoom-out")!.addEventListener("click", () => { viewScale = clamp(viewScale / 1.25, 1, 4); applyView(); });
document.querySelector("#zoom-in")!.addEventListener("click", () => { viewScale = clamp(viewScale * 1.25, 1, 4); applyView(); });
document.querySelector("#reset-view")!.addEventListener("click", () => { viewScale = 1; panX = 0; panY = 0; applyView(); });

document.querySelector("#right-click")!.addEventListener("click", () => queueMouse(5));
document.querySelector("#scroll-up")!.addEventListener("click", () => queueMouse(7, lastPosition.x, lastPosition.y, -1));
document.querySelector("#scroll-down")!.addEventListener("click", () => queueMouse(7, lastPosition.x, lastPosition.y, 1));
copyRemote.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(remoteText.value); setStatus("Copied to this device"); }
  catch { remoteText.select(); setStatus("Select and copy the text above"); }
});
pasteLocal.addEventListener("click", async () => {
  try { localText.value = await navigator.clipboard.readText(); queueClipboard(localText.value); setStatus("Sent to laptop"); }
  catch { localText.focus(); setStatus("Paste into the text box, then send"); }
});
sendLocal.addEventListener("click", () => { queueClipboard(localText.value); setStatus("Sent to laptop"); });
localText.addEventListener("paste", () => { setTimeout(() => queueClipboard(localText.value), 0); });

void watchTextFit();
