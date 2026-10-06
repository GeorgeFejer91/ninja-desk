import { invoke, listen } from "./bridge";
import VDONinja from "@vdoninja/sdk";
import logoUrl from "../branding/ninja-desk.svg";
import { fingerprints } from "./fingerprints";
import { isRecord, roomFromPassword, routePasswordForAccessLink } from "./protocol";
import { watchTextFit } from "./text-fit";
import { startCliBridge, type CliResult, type RuntimeStatus } from "./cli-bridge";
import { iceRoute } from "./route";

type TrustedRoute = { id: string; secret: string };
type Bootstrap = { room: string; streamId: string; password: string; generation: string; hostId: string; trusted: TrustedRoute | null };
type Challenge = { nonce: string; generation: string; hostCert: string; clientCert: string };
type AuthResult = { proof: string; width: number; height: number; cursorX: number; cursorY: number; mediaPassword: string; displayRevision: number };
type Frame = { jpegBase64: string; width: number; height: number; cursorX: number; cursorY: number; peer: string; displayRevision: number };
type MonitorResult = { displayRevision: number; monitorIndex: number; monitorCount: number; mediaPassword: string };
type AccessLink = { id: string; secret: string; expiresAtMs: number };
type TrustedGrant = TrustedRoute & { hostId: string; mac: string };

const status = document.querySelector<HTMLElement>("#status")!;
const passwordField = document.querySelector<HTMLInputElement>("#password")!;
const revealButton = document.querySelector<HTMLButtonElement>("#reveal")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const fastCaptureButton = document.querySelector<HTMLButtonElement>("#fast-capture")!;
const lowDataButton = document.querySelector<HTMLButtonElement>("#low-data")!;
const replacePasswordButton = document.querySelector<HTMLButtonElement>("#replace-password")!;
const controlButton = document.querySelector<HTMLButtonElement>("#control")!;
const trustButton = document.querySelector<HTMLButtonElement>("#trust-pc")!;
const revokeTrustButton = document.querySelector<HTMLButtonElement>("#revoke-trust")!;
const startLoginButton = document.querySelector<HTMLButtonElement>("#start-login")!;
const openHostButton = document.querySelector<HTMLButtonElement>("#open-host")!;
const createLinkButton = document.querySelector<HTMLButtonElement>("#create-link")!;
const linkDetails = document.querySelector<HTMLElement>("#link-details")!;
const linkField = document.querySelector<HTMLInputElement>("#access-link")!;
const linkExpiry = document.querySelector<HTMLElement>("#link-expiry")!;
const copyLinkButton = document.querySelector<HTMLButtonElement>("#copy-link")!;
const revokeLinkButton = document.querySelector<HTMLButtonElement>("#revoke-link")!;
document.querySelector<HTMLImageElement>("#brand-mark")!.src = logoUrl;
document.querySelector<HTMLLinkElement>("#favicon")!.href = logoUrl;
const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
const context = canvas.getContext("2d", { alpha: false })!;
const controlCanvas = document.createElement("canvas");
controlCanvas.width = 16;
controlCanvas.height = 16;
controlCanvas.getContext("2d")!.fillRect(0, 0, 16, 16);
function blankScreen() {
  context.fillStyle = "#141414";
  context.fillRect(0, 0, canvas.width, canvas.height);
}
blankScreen();

let sdk: VDONinja | null = null;
let inviteSdk: VDONinja | null = null;
let trustedSdk: VDONinja | null = null;
let mediaSdk: VDONinja | null = null;
let mediaTrack: CanvasCaptureMediaStreamTrack | null = null;
let publishedTrack: MediaStreamTrack | null = null;
let fastCapture: MediaStream | null = null;
let lowData = false;
let activePeer: string | null = null;
let activeDisplayRevision = 0;
let drawnDisplayRevision = -1;
let activeDesktop = false;
let currentTrusted: TrustedRoute | null = null;
const desktopPeers = new Set<string>();
let activeTransport: VDONinja | null = null;
let currentInvite: Pick<AccessLink, "id" | "expiresAtMs"> | null = null;
let stopped = false;
let startupStage = "bootstrap";
let primaryRetryTimer: number | null = null;
let trustedRetryTimer: number | null = null;
let primaryRetryDelay = 1000;
let trustedRetryDelay = 1000;
let incomingQueue: Promise<void> = Promise.resolve();
let incomingPending = 0;
let drawnFrames = 0;
let lastDrawnAt: number | null = null;
const LOW_DATA_MEDIA = { video: { maxBitrate: 350_000 } };

function safeError(error: unknown): string {
  return String(error).replace(/[0-9a-f]{32,64}/gi, "[redacted]").slice(0, 160);
}

function setStatus(message: string) {
  status.textContent = message;
  console.info(`[host] ${message}`);
}

function send(peer: string, data: object, transport = activeTransport ?? sdk): boolean {
  return transport?.sendData(data, { uuid: peer, allowFallback: false }) ?? false;
}

function closeMedia() {
  const previous = mediaSdk;
  mediaSdk = null;
  mediaTrack = null;
  publishedTrack = null;
  void previous?.disconnect().catch(() => {});
}

function canvasStream() {
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  if (typeof track.requestFrame !== "function") {
    stream.getTracks().forEach((item) => item.stop());
    stream = canvas.captureStream(30);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  } else {
    track.requestFrame();
  }
  return { stream, track };
}

function displayConstraints(): MediaTrackConstraints {
  return lowData
    ? { width: { max: 960 }, height: { max: 540 }, frameRate: { ideal: 10, max: 10 } }
    : { width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 60, max: 60 } };
}

lowDataButton.addEventListener("click", async () => {
  if (stopped) return;
  lowDataButton.disabled = true;
  try {
    const enabled = !lowData;
    await invoke("set_low_data_mode", { enabled });
    lowData = enabled;
    lowDataButton.textContent = `Low data mode: ${enabled ? "On" : "Off"}`;
    lowDataButton.setAttribute("aria-pressed", String(enabled));
    let limitsApplied = true;
    if (mediaSdk) {
      try { await mediaSdk.updatePublisherMedia(enabled ? { media: LOW_DATA_MEDIA } : { clear: true }); }
      catch { limitsApplied = false; }
    }
    const track = fastCapture?.getVideoTracks()[0];
    if (track?.readyState === "live") {
      try { await track.applyConstraints(displayConstraints()); }
      catch { limitsApplied = false; }
    }
    setStatus(limitsApplied ? (enabled ? "Low data mode on" : "Low data mode off") : "Mode changed; browser stream limits may be unavailable");
  } catch (error) {
    setStatus(`Stream limits may be unavailable: ${safeError(error)}`);
  } finally {
    lowDataButton.disabled = stopped;
  }
});

function stopFastCapture() {
  const stream = fastCapture;
  fastCapture = null;
  stream?.getTracks().forEach((track) => track.stop());
  fastCaptureButton.textContent = "Share primary display (fast)";
  fastCaptureButton.disabled = !!activePeer || stopped;
  void invoke("set_screen_capture_paused", { paused: false }).catch(() => {});
}

fastCaptureButton.addEventListener("click", async () => {
  if (fastCapture || activePeer || stopped) return;
  fastCaptureButton.disabled = true;
  try {
    // This call must run directly from the click; browsers require a user gesture.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track || (track.getSettings().displaySurface && track.getSettings().displaySurface !== "monitor")) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error("Select the primary display, not a window or tab");
    }
    track.contentHint = "motion";
    await track.applyConstraints(displayConstraints()).catch(() => {});
    if (activePeer || stopped) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error("Enable fast capture before the controller connects");
    }
    fastCapture = stream;
    track.addEventListener("ended", () => {
      if (fastCapture !== stream) return;
      stopFastCapture();
      setStatus("Fast capture ended; standard capture ready");
      const candidate = mediaSdk;
      if (candidate && activePeer && publishedTrack === track) {
        const fallback = canvasStream();
        void candidate.replaceTrack(track, fallback.track).then(() => {
          if (mediaSdk === candidate) {
            mediaTrack = fallback.track;
            publishedTrack = fallback.track;
            setStatus("Fast capture ended; using standard capture");
          }
        }).catch(() => {
          closeMedia();
          setStatus("Screen sharing stopped; reconnect the controller");
        });
      }
    }, { once: true });
    await invoke("set_screen_capture_paused", { paused: true });
    if (fastCapture !== stream) throw new Error("Screen sharing stopped");
    fastCaptureButton.textContent = "Fast capture on";
    setStatus("Fast capture ready; choose the primary display for accurate mouse control");
  } catch (error) {
    stopFastCapture();
    setStatus(`Fast capture unavailable: ${safeError(error)}`);
  } finally {
    fastCaptureButton.disabled = !!fastCapture || !!activePeer || stopped;
  }
});

function closeActive(transport: VDONinja) {
  if (activeTransport !== transport) return;
  if (activePeer) void invoke("disconnect", { peer: activePeer }).catch(() => {});
  activePeer = null;
  activeDesktop = false;
  trustButton.disabled = true;
  activeTransport = null;
  fastCaptureButton.disabled = !!fastCapture || stopped;
  closeMedia();
  blankScreen();
  if (!stopped) setStatus("Waiting for browser");
}

function clearInvite() {
  const previous = inviteSdk;
  inviteSdk = null;
  if (previous) closeActive(previous);
  currentInvite = null;
  linkField.value = "";
  linkDetails.hidden = true;
  createLinkButton.textContent = "Create access link";
  void previous?.disconnect().catch(() => {});
}

function bindControl(transport: VDONinja, inviteId?: string, trustedId?: string) {
  transport.on("dataReceived", (event) => {
    if (event.detail.fallback) return;
    if (incomingPending >= 64) {
      if (activePeer === event.detail.uuid && activeTransport === transport) {
        const peer = activePeer;
        closeActive(transport);
        send(peer, { type: "auth_error" }, transport);
      }
      return;
    }
    incomingPending++;
    incomingQueue = incomingQueue.then(() => handleData(transport, event.detail.uuid, event.detail.data, inviteId, trustedId))
      .catch((error) => console.warn(`[host] command failed: ${safeError(error)}`))
      .finally(() => { incomingPending--; });
  });
  transport.on("peerDisconnected", (event) => {
    desktopPeers.delete(event.detail.uuid);
    if (event.detail.uuid === activePeer) closeActive(transport);
  });
  transport.on("disconnected", () => {
    closeActive(transport);
    if (!stopped && transport === sdk) setStatus("Reconnecting…");
    if (!stopped && transport === inviteSdk) setStatus("Access link reconnecting…");
  });
  transport.on("reconnectFailed", () => {
    if (stopped) return;
    if (transport === sdk) void schedulePrimary();
    if (transport === trustedSdk) scheduleTrusted();
  });
}

let primaryConfig: Bootstrap | null = null;
function schedulePrimary() {
  if (stopped || !primaryConfig || primaryRetryTimer !== null) return;
  setStatus("Host reconnecting…");
  primaryRetryTimer = window.setTimeout(() => {
    primaryRetryTimer = null;
    if (primaryConfig) void startPrimary(primaryConfig);
  }, primaryRetryDelay);
  primaryRetryDelay = Math.min(primaryRetryDelay * 2, 30000);
}

async function startPrimary(config: Bootstrap) {
  const previous = sdk;
  sdk = null;
  if (previous) { closeActive(previous); await previous.disconnect().catch(() => {}); }
  if (stopped) return;
  const candidate = new VDONinja({ password: config.password, salt: "vdo.ninja" });
  sdk = candidate;
  bindControl(candidate);
  try {
    await candidate.connect();
    if (sdk !== candidate || stopped) return;
    await candidate.joinRoom({ room: config.room, password: config.password });
    if (sdk !== candidate || stopped) return;
    await candidate.publish(controlCanvas.captureStream(1), { streamID: config.streamId, label: "Control channel" });
    primaryRetryDelay = 1000;
    if (sdk === candidate && !stopped) setStatus("Waiting for controller");
  } catch {
    if (sdk === candidate) sdk = null;
    await candidate.disconnect().catch(() => {});
    schedulePrimary();
  }
}

function scheduleTrusted() {
  if (stopped || !currentTrusted || trustedRetryTimer !== null) return;
  trustedRetryTimer = window.setTimeout(() => {
    trustedRetryTimer = null;
    if (currentTrusted) void startTrusted(currentTrusted);
  }, trustedRetryDelay);
  trustedRetryDelay = Math.min(trustedRetryDelay * 2, 30000);
}

async function startMedia(password: string) {
  const peer = activePeer;
  const room = await roomFromPassword(password);
  if (stopped || !peer || activePeer !== peer) throw new Error("Media session canceled");
  const candidate = new VDONinja({ password, salt: "vdo.ninja" });
  mediaSdk = candidate;
  try {
    await candidate.connect();
    if (mediaSdk !== candidate || !activePeer) throw new Error("Media session canceled");
    await candidate.joinRoom({ room, password });
    if (mediaSdk !== candidate || !activePeer) throw new Error("Media session canceled");
    const fastTrack = fastCapture?.getVideoTracks()[0];
    const fallback = fastTrack?.readyState === "live" ? null : canvasStream();
    const stream = fallback?.stream ?? fastCapture!;
    const track = fallback?.track ?? fastTrack!;
    mediaTrack = fallback?.track ?? null;
    await candidate.publish(stream, {
      streamID: `host_${room}`,
      label: "Desktop",
      ...(lowData ? { media: LOW_DATA_MEDIA } : {}),
    });
    if (mediaSdk !== candidate || !activePeer) throw new Error("Media session canceled");
    publishedTrack = track;
  } catch (error) {
    if (mediaSdk === candidate) { mediaSdk = null; mediaTrack = null; publishedTrack = null; }
    await candidate.disconnect().catch(() => {});
    throw error;
  }
}

async function startTrusted(route: TrustedRoute) {
  const previous = trustedSdk;
  trustedSdk = null;
  if (previous) {
    closeActive(previous);
    await previous.disconnect().catch(() => {});
  }
  if (stopped || currentTrusted?.id !== route.id) return;
  const password = await routePasswordForAccessLink(route.secret);
  const room = await roomFromPassword(password);
  if (stopped || currentTrusted?.id !== route.id) return;
  const candidate = new VDONinja({ password, salt: "vdo.ninja" });
  trustedSdk = candidate;
  bindControl(candidate, undefined, route.id);
  try {
    await candidate.connect();
    if (trustedSdk !== candidate || stopped) return;
    await candidate.joinRoom({ room, password });
    if (trustedSdk !== candidate || stopped) return;
    await candidate.publish(controlCanvas.captureStream(1), { streamID: `host_${room}`, label: "Trusted PC" });
    trustedRetryDelay = 1000;
  } catch (error) {
    if (trustedSdk === candidate) trustedSdk = null;
    await candidate.disconnect().catch(() => {});
    scheduleTrusted();
    console.warn(`[host] trusted route reconnecting: ${safeError(error)}`);
  }
}

async function handleData(transport: VDONinja, peer: string, data: unknown, inviteId?: string, trustedId?: string) {
  if (!isRecord(data) || typeof data.type !== "string" || stopped || (transport !== sdk && transport !== inviteSdk && transport !== trustedSdk)) return;
  try {
    if (data.type === "auth_hello" && typeof data.clientNonce === "string") {
      if (data.desktop === true) desktopPeers.add(peer);
      const pair = await fingerprints(transport, peer, "publisher");
      if (transport !== sdk && transport !== inviteSdk && transport !== trustedSdk) return;
      const challenge = await invoke<Challenge>("begin_auth", { peer, hostCert: pair.local, clientCert: pair.remote, inviteId, trustedId });
      send(peer, { type: "auth_challenge", peer, ...challenge }, transport);
      return;
    }
    if (data.type === "auth_proof" && typeof data.clientNonce === "string" && typeof data.proof === "string") {
      const result = await invoke<AuthResult>("finish_auth", { peer, clientNonce: data.clientNonce, proof: data.proof, inviteId, trustedId });
      if (transport !== sdk && transport !== inviteSdk && transport !== trustedSdk) {
        await invoke("disconnect", { peer }).catch(() => {});
        return;
      }
      activePeer = peer;
      activeDisplayRevision = result.displayRevision;
      activeDesktop = desktopPeers.has(peer) && !trustedId;
      trustButton.disabled = !activeDesktop;
      fastCaptureButton.disabled = true;
      activeTransport = transport;
      try {
        await startMedia(result.mediaPassword);
        if (activePeer !== peer || activeTransport !== transport || !send(peer, { type: "auth_ok", ...result }, transport)) throw new Error("Controller disconnected");
      } catch (error) {
        closeActive(transport);
        throw error;
      }
      setStatus("Controller connected");
      return;
    }
    if (peer !== activePeer || transport !== activeTransport) return;
    if (data.type === "next_monitor") {
      let result: MonitorResult | null = null;
      try {
        const command = { peer, seq: data.seq, displayRevision: data.displayRevision, mac: data.mac };
        result = await invoke<MonitorResult>("next_monitor", { command });
        activeDisplayRevision = result.displayRevision;
        drawnDisplayRevision = -1;
        closeMedia();
        stopFastCapture();
        blankScreen();
        const deadline = performance.now() + 4000;
        while (drawnDisplayRevision !== result.displayRevision) {
          if (activePeer !== peer || activeTransport !== transport || stopped || performance.now() >= deadline) throw new Error("display_unavailable");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await startMedia(result.mediaPassword);
        if (activePeer !== peer || activeTransport !== transport) return;
        send(peer, { type: "monitor_changed", seq: data.seq, ...result }, transport);
      } catch (error) {
        if (result) {
          send(peer, { type: "session_expired" }, transport);
          closeActive(transport);
        } else {
          send(peer, { type: "monitor_error", seq: data.seq, reason: safeError(error) }, transport);
        }
      }
      return;
    }
    if (data.type === "mouse") {
      const command = { peer, seq: data.seq, op: data.op, x: data.x, y: data.y, arg: data.arg, mac: data.mac, displayRevision: data.displayRevision };
      try {
        await invoke("mouse", { command });
        send(peer, { type: "ack", seq: data.seq, ok: true }, transport);
      } catch (error) {
        send(peer, { type: "ack", seq: data.seq, ok: false, reason: String(error) }, transport);
      }
      return;
    }
    if (data.type === "clipboard" && typeof data.text === "string") {
      const command = { peer, seq: data.seq, text: data.text, mac: data.mac };
      try {
        await invoke("write_clipboard", { command });
        send(peer, { type: "ack", seq: data.seq, ok: true }, transport);
      } catch (error) {
        send(peer, { type: "ack", seq: data.seq, ok: false, reason: String(error) }, transport);
      }
    }
  } catch (error) {
    console.warn(`[host] message rejected: ${safeError(error)}`);
    const reason = trustedId && ["invalid_trust", "invalid_auth"].includes(String(error)) ? "trust_rejected" : undefined;
    send(peer, { type: "auth_error", reason }, transport);
  }
}

async function start() {
  void watchTextFit().catch(() => {});
  const config = await invoke<Bootstrap>("bootstrap");
  document.querySelector<HTMLInputElement>("#host-id")!.value = config.hostId;
  startupStage = "events";
  passwordField.value = config.password;
  currentTrusted = config.trusted;
  revokeTrustButton.hidden = !currentTrusted;
  const transportMode = await invoke<string>("transport_mode");
  if (transportMode === "external" || transportMode === "browser") useBrowserConnections();
  if (transportMode === "external") {
    openHostButton.hidden = false;
    document.querySelector(".desktop-pairing")!.prepend(openHostButton);
    fastCaptureButton.hidden = true;
    lowDataButton.hidden = true;
    startLoginButton.hidden = true;
    setStatus("Open browser host to receive connections");
    return;
  }
  const startLogin = await invoke<boolean>("get_start_on_login").catch(() => false);
  startLoginButton.setAttribute("aria-pressed", String(startLogin));
  startLoginButton.textContent = `Start with Windows: ${startLogin ? "On" : "Off"}`;
  primaryConfig = config;
  await listen<Frame>("screen-frame", async (event) => {
    if (!activePeer || stopped || event.payload.peer !== activePeer || event.payload.displayRevision !== activeDisplayRevision) return;
    const bytes = Uint8Array.from(atob(event.payload.jpegBase64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      if (!activePeer || stopped || event.payload.peer !== activePeer || event.payload.displayRevision !== activeDisplayRevision) return;
      if (canvas.width !== event.payload.width || canvas.height !== event.payload.height) {
        canvas.width = event.payload.width;
        canvas.height = event.payload.height;
      }
      if (activePeer && !stopped) {
        context.drawImage(bitmap, 0, 0);
        drawnDisplayRevision = event.payload.displayRevision;
        drawnFrames++;
        lastDrawnAt = performance.now();
        const { cursorX, cursorY, width, height } = event.payload;
        if (!desktopPeers.has(activePeer) && cursorX >= 0 && cursorX < width && cursorY >= 0 && cursorY < height) {
          context.beginPath();
          context.moveTo(cursorX, cursorY);
          context.lineTo(cursorX + 2, cursorY + 18);
          context.lineTo(cursorX + 6, cursorY + 14);
          context.lineTo(cursorX + 10, cursorY + 23);
          context.lineTo(cursorX + 13, cursorY + 21);
          context.lineTo(cursorX + 9, cursorY + 12);
          context.lineTo(cursorX + 15, cursorY + 12);
          context.closePath();
          context.fillStyle = "#fff";
          context.strokeStyle = "#111";
          context.lineWidth = 1.5;
          context.fill();
          context.stroke();
        }
        mediaTrack?.requestFrame();
      }
    } finally {
      bitmap.close();
    }
  });
  startupStage = "signaling";
  void startPrimary(config);
  if (currentTrusted) void startTrusted(currentTrusted);
  startupStage = "ready";
  setInterval(async () => {
    if (!activePeer || stopped) return;
    const authoritativePeer = await invoke<string | null>("active_peer").catch(() => null);
    if (authoritativePeer !== activePeer) {
      const transport = activeTransport;
      if (transport) {
        send(activePeer, { type: "session_expired" }, transport);
        closeActive(transport);
      }
      return;
    }
    const text = await invoke<string | null>("read_clipboard").catch(() => null);
    if (text !== null && activePeer) send(activePeer, { type: "clipboard", text });
  }, 500);
  setInterval(async () => {
    const id = currentInvite?.id;
    if (!id || stopped) return;
    const active = await invoke<boolean>("access_link_active", { id }).catch(() => null);
    if (active === false && currentInvite?.id === id) {
      clearInvite();
      setStatus("Access link expired");
    }
  }, 5000);
}

createLinkButton.addEventListener("click", async () => {
  if (createLinkButton.disabled || stopped) return;
  createLinkButton.disabled = true;
  setStatus("Creating access link…");
  let link: AccessLink | null = null;
  let candidate: VDONinja | null = null;
  try {
    link = await invoke<AccessLink>("create_access_link");
    clearInvite();
    const password = await routePasswordForAccessLink(link.secret);
    const room = await roomFromPassword(password);
    candidate = new VDONinja({ password, salt: "vdo.ninja" });
    inviteSdk = candidate;
    bindControl(candidate, link.id);
    await candidate.connect();
    if (inviteSdk !== candidate || stopped) throw new Error("Access link canceled");
    await candidate.joinRoom({ room, password });
    if (inviteSdk !== candidate || stopped) throw new Error("Access link canceled");
    await candidate.publish(controlCanvas.captureStream(1), { streamID: `host_${room}`, label: "Control channel" });
    if (inviteSdk !== candidate || stopped) throw new Error("Access link canceled");
    currentInvite = { id: link.id, expiresAtMs: link.expiresAtMs };
    linkField.value = `https://georgefejer91.github.io/ninja-desk/#access=v1.${link.id}.${link.secret}`;
    linkExpiry.textContent = `Expires ${new Date(link.expiresAtMs).toLocaleString()} while Ninja Desk is running. Replacing the link revokes the old one.`;
    linkDetails.hidden = false;
    createLinkButton.textContent = "Replace link";
    setStatus("Access link ready");
  } catch (error) {
    if (link) await invoke("revoke_access_link", { id: link.id }).catch(() => {});
    if (candidate) clearInvite();
    console.warn(`[host] access link failed: ${safeError(error)}`);
    if (!stopped) setStatus("Could not create access link");
  } finally {
    createLinkButton.disabled = stopped;
  }
});

async function approveConnectedPc() {
  const peer = activePeer;
  const transport = activeTransport;
  if (!peer || !transport || !activeDesktop || stopped) throw new Error("No desktop awaiting approval");
  trustButton.disabled = true;
  try {
    const grant = await invoke<TrustedGrant>("approve_trusted_pc", { peer });
    if (activePeer !== peer || activeTransport !== transport || !send(peer, { type: "trusted_grant", ...grant }, transport)) {
      await invoke("revoke_trusted_pc");
      throw new Error("Controller disconnected");
    }
    currentTrusted = { id: grant.id, secret: grant.secret };
    if (trustedRetryTimer !== null) { clearTimeout(trustedRetryTimer); trustedRetryTimer = null; }
    revokeTrustButton.hidden = false;
    await startTrusted(currentTrusted);
    setStatus("This PC can reconnect until you revoke trust");
  } catch (error) {
    setStatus(`Could not trust PC: ${safeError(error)}`);
    throw error;
  } finally {
    trustButton.disabled = !activeDesktop || stopped;
  }
}
trustButton.addEventListener("click", () => { void approveConnectedPc().catch(() => {}); });

async function revokeConnectedPc() {
  revokeTrustButton.disabled = true;
  try {
    if (activePeer && activeTransport === trustedSdk && send(activePeer, { type: "trusted_revoked" }, trustedSdk)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await invoke("revoke_trusted_pc");
    if (trustedRetryTimer !== null) { clearTimeout(trustedRetryTimer); trustedRetryTimer = null; }
    currentTrusted = null;
    const previous = trustedSdk;
    trustedSdk = null;
    if (previous) { closeActive(previous); await previous.disconnect().catch(() => {}); }
    revokeTrustButton.hidden = true;
    setStatus("Trusted PC revoked");
  } catch {
    setStatus("Could not revoke trusted PC");
    throw new Error("Could not revoke trusted PC");
  } finally {
    revokeTrustButton.disabled = false;
  }
}
revokeTrustButton.addEventListener("click", () => { void revokeConnectedPc().catch(() => {}); });

startLoginButton.addEventListener("click", async () => {
  startLoginButton.disabled = true;
  try {
    const enabled = startLoginButton.getAttribute("aria-pressed") !== "true";
    await invoke("set_start_on_login", { enabled });
    startLoginButton.setAttribute("aria-pressed", String(enabled));
    startLoginButton.textContent = `Start with Windows: ${enabled ? "On" : "Off"}`;
  } catch { setStatus("Could not change Windows startup"); }
  finally { startLoginButton.disabled = false; }
});

copyLinkButton.addEventListener("click", async () => {
  if (!currentInvite) return;
  try {
    await navigator.clipboard.writeText(linkField.value);
    copyLinkButton.textContent = "Copied";
    setTimeout(() => { copyLinkButton.textContent = "Copy link"; }, 1500);
  } catch {
    linkField.select();
    setStatus("Select and copy the link above");
  }
});

revokeLinkButton.addEventListener("click", async () => {
  const id = currentInvite?.id;
  if (!id) return;
  revokeLinkButton.disabled = true;
  try {
    await invoke("revoke_access_link", { id });
    if (currentInvite?.id === id) clearInvite();
    setStatus("Access link revoked");
  } catch {
    setStatus("Could not revoke access link");
  } finally {
    revokeLinkButton.disabled = false;
  }
});

revealButton.addEventListener("click", () => {
  const visible = passwordField.type === "password";
  passwordField.type = visible ? "text" : "password";
  revealButton.textContent = visible ? "Hide" : "Show";
});
copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(passwordField.value);
  copyButton.textContent = "Copied";
  setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
});
stopButton.addEventListener("click", async () => {
  stopped = true;
  if (primaryRetryTimer !== null) clearTimeout(primaryRetryTimer);
  if (trustedRetryTimer !== null) clearTimeout(trustedRetryTimer);
  activePeer = null;
  stopFastCapture();
  activeTransport = null;
  closeMedia();
  blankScreen();
  await invoke("stop");
  clearInvite();
  await trustedSdk?.disconnect().catch(() => {});
  trustedSdk = null;
  await sdk?.disconnect();
  setStatus("Stopped");
  stopButton.disabled = true;
  lowDataButton.disabled = true;
});
replacePasswordButton.addEventListener("click", async () => {
  replacePasswordButton.disabled = true;
  copyButton.disabled = true;
  revealButton.disabled = true;
  passwordField.value = "";
  setStatus("Replacing password and restarting…");
  try {
    await invoke("replace_password");
    stopped = true;
    if (primaryRetryTimer !== null) clearTimeout(primaryRetryTimer);
    if (trustedRetryTimer !== null) clearTimeout(trustedRetryTimer);
    activePeer = null;
    stopFastCapture();
    activeTransport = null;
    closeMedia();
    blankScreen();
    clearInvite();
    await trustedSdk?.disconnect().catch(() => {});
    trustedSdk = null;
    await sdk?.disconnect();
    stopButton.disabled = true;
    lowDataButton.disabled = true;
    setStatus("Restarting with new password…");
  } catch {
    stopped = true;
    if (primaryRetryTimer !== null) clearTimeout(primaryRetryTimer);
    if (trustedRetryTimer !== null) clearTimeout(trustedRetryTimer);
    activePeer = null;
    stopFastCapture();
    activeTransport = null;
    await invoke("stop").catch(() => {});
    closeMedia();
    blankScreen();
    clearInvite();
    await trustedSdk?.disconnect().catch(() => {});
    trustedSdk = null;
    await sdk?.disconnect().catch(() => {});
    setStatus("Password replacement failed. Remote access is stopped.");
    stopButton.disabled = true;
    lowDataButton.disabled = true;
    replacePasswordButton.disabled = false;
  }
});

controlButton.addEventListener("click", () => {
  void invoke("open_controller").catch(() => setStatus("Could not open controller"));
});

async function hostRuntime(): Promise<RuntimeStatus> {
  let route: RuntimeStatus["route"] = "unknown";
  const current = mediaSdk;
  if (current) {
    try {
      const stats = await current.getStats();
      if (mediaSdk === current) {
        const observed = iceRoute(Object.values(stats).flat(), "publisher");
        route = observed === "Direct" ? "direct" : observed === "Relayed" ? "relayed" : "unknown";
      }
    } catch { /* No selected ICE pair is reported as unknown. */ }
  }
  const mediaActive = !!mediaSdk && publishedTrack?.readyState === "live";
  return {
    phase: stopped ? "stopped" : activePeer ? mediaActive ? "media_ready" : "control_ready" : primaryRetryTimer !== null || trustedRetryTimer !== null ? "reconnecting" : startupStage === "ready" ? "offline" : "connecting",
    authenticated: !!activePeer,
    remembered: !!currentTrusted,
    retryScheduled: primaryRetryTimer !== null || trustedRetryTimer !== null,
    mediaActive,
    frames: drawnFrames,
    lastFrameAgeMs: lastDrawnAt === null ? null : Math.round(performance.now() - lastDrawnAt),
    route,
  };
}

void startCliBridge(hostRuntime, async (action): Promise<CliResult> => {
  if (action.type === "host_pair_approve") {
    if (!activePeer || !activeDesktop || stopped) return { ok: false, code: "no_pending_pairing" };
    await approveConnectedPc();
    return { ok: true };
  }
  if (action.type === "host_pair_revoke") { await revokeConnectedPc(); return { ok: true }; }
  return { ok: false, code: "wrong_window" };
}).catch(() => {});

let hostFullscreenBusy = false;
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.code === "KeyF" && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    if (!event.repeat && !hostFullscreenBusy) {
      hostFullscreenBusy = true;
      void invoke<boolean>("get_window_fullscreen").then(active => invoke<boolean>("set_window_fullscreen", { enabled: !active })).catch(() => {}).finally(() => { hostFullscreenBusy = false; });
    }
  }
});

type SavedComputer = { hostId: string; name: string; lastConnectedAtMs: number };
const desktopPanel = document.querySelector<HTMLElement>("#desktop-panel")!;
const settingsPanel = document.querySelector<HTMLElement>("#settings-panel")!;
const settingsToggle = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
const savedList = document.querySelector<HTMLElement>("#saved-list")!;
const connectStatus = document.querySelector<HTMLElement>("#connect-status")!;
const quickConnect = document.querySelector<HTMLFormElement>("#quick-connect")!;
const remoteCode = document.querySelector<HTMLInputElement>("#connect-code")!;
const connectRemote = document.querySelector<HTMLButtonElement>("#connect-remote")!;
const previousPage = document.querySelector<HTMLButtonElement>("#saved-prev")!;
const nextPage = document.querySelector<HTMLButtonElement>("#saved-next")!;
let savedComputers: SavedComputer[] = [];
let savedPage = 0;
let savedPageSize = 1;
let savedPageBudget = 0;
let loadingSaved = false;
let browserConnections = false;

function useBrowserConnections() {
  browserConnections = true;
  quickConnect.hidden = true;
  document.querySelector<HTMLElement>(".saved-computers")!.hidden = true;
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.dataset.fit = "";
  heading.textContent = "Browser connections";
  const detail = document.createElement("p");
  detail.dataset.fit = "";
  detail.textContent = "Open the browser controller to connect to another computer using its access code.";
  section.append(heading, controlButton, detail);
  if (openHostButton.hidden === false) section.append(openHostButton);
  document.querySelector(".remote-desktop")!.append(section);
}

settingsToggle.addEventListener("click", () => {
  const show = settingsPanel.hidden;
  settingsPanel.hidden = !show;
  desktopPanel.hidden = show;
  settingsToggle.textContent = show ? "Back" : "Settings";
  settingsToggle.setAttribute("aria-expanded", String(show));
});
document.querySelector("#close-link")!.addEventListener("click", () => { linkDetails.hidden = true; createLinkButton.focus(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !linkDetails.hidden) { linkDetails.hidden = true; createLinkButton.focus(); } });

quickConnect.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = remoteCode.value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(password)) { connectStatus.textContent = "Enter the remote computer’s full access code."; return; }
  connectRemote.disabled = true;
  try {
    await invoke("connect_controller", { password });
    remoteCode.value = "";
    connectStatus.textContent = "Connection started. Approve this PC on the remote computer to save it.";
  } catch { connectStatus.textContent = "Could not start the connection. Check that Ninja Desk is running."; }
  finally { connectRemote.disabled = false; }
});

function fitSavedPage() {
  if (!savedList.clientHeight) return;
  const size = document.body.dataset.panelFit === "reflow" ? 1 :
    Math.max(1, Math.min(4, Math.floor((savedList.clientHeight + 8) / (window.innerWidth < 740 ? 144 : 108))));
  if (size !== savedPageBudget) { savedPageBudget = size; savedPageSize = size; savedPage = 0; renderSavedComputers(); }
}

function renderSavedComputers() {
  savedList.replaceChildren();
  const pages = Math.max(1, Math.ceil(savedComputers.length / savedPageSize));
  savedPage = Math.min(savedPage, pages - 1);
  if (!savedComputers.length) {
    const empty = document.createElement("p");
    empty.dataset.fit = "";
    empty.textContent = "No saved computers yet. Connect using an access code and approve this PC on the remote computer.";
    savedList.append(empty);
  }
  for (const computer of savedComputers.slice(savedPage * savedPageSize, (savedPage + 1) * savedPageSize)) {
    const row = document.createElement("article");
    row.className = "saved-computer";
    const name = document.createElement("span");
    name.className = "saved-name";
    name.dataset.fit = "";
    name.textContent = computer.name || `PC ${computer.hostId.slice(0, 8)}`;
    const meta = document.createElement("span");
    meta.className = "saved-meta";
    meta.dataset.fit = "";
    meta.textContent = computer.lastConnectedAtMs > 0 ? `Last connected ${new Date(computer.lastConnectedAtMs).toLocaleDateString()}` : "Remembered PC";
    const actions = document.createElement("div");
    actions.className = "saved-actions";
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.className = "saved-connect";
    reconnect.dataset.fit = "";
    reconnect.textContent = "Reconnect";
    reconnect.addEventListener("click", async () => {
      reconnect.disabled = true;
      try { await invoke("connect_controller", { hostId: computer.hostId }); connectStatus.textContent = `Connecting to ${name.textContent}.`; }
      catch { connectStatus.textContent = "Could not reconnect. The remote PC must be running and online."; }
      finally { reconnect.disabled = false; }
    });
    const rename = document.createElement("button");
    rename.type = "button";
    rename.dataset.fit = "";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => {
      const input = document.createElement("input");
      input.value = computer.name;
      input.maxLength = 80;
      input.setAttribute("aria-label", "Computer name. Enter saves, Escape cancels.");
      name.replaceWith(input);
      input.focus();
      input.select();
      input.addEventListener("keydown", async (event) => {
        if (event.key === "Escape") renderSavedComputers();
        if (event.key === "Enter" && input.value.trim()) {
          input.disabled = true;
          try { await invoke("rename_saved_computer", { hostId: computer.hostId, name: input.value.trim() }); await refreshSavedComputers(); }
          catch { connectStatus.textContent = "Could not rename the computer."; input.disabled = false; }
        }
      });
    });
    const forget = document.createElement("button");
    forget.type = "button";
    forget.dataset.fit = "";
    forget.textContent = "Forget";
    forget.addEventListener("click", async () => {
      forget.disabled = true;
      try { await invoke("forget_saved_computer", { hostId: computer.hostId }); await refreshSavedComputers(); }
      catch { connectStatus.textContent = "Could not forget the computer."; forget.disabled = false; }
    });
    actions.append(reconnect, rename, forget);
    row.append(name, actions, meta);
    savedList.append(row);
  }
  previousPage.disabled = savedPage === 0;
  nextPage.disabled = savedPage === pages - 1;
  document.querySelector<HTMLElement>("#saved-page")!.textContent = `Page ${savedPage + 1} of ${pages}`;
  requestAnimationFrame(() => {
    if (savedPageSize > 1 && Array.from(savedList.children).some(row => row.scrollHeight > row.clientHeight + 1)) {
      savedPageSize--;
      savedPage = 0;
      renderSavedComputers();
    }
  });
}

async function refreshSavedComputers() {
  if (loadingSaved || browserConnections) return;
  loadingSaved = true;
  try {
    const next = await invoke<SavedComputer[]>("list_saved_computers");
    if (JSON.stringify(next) !== JSON.stringify(savedComputers)) { savedComputers = next; renderSavedComputers(); }
    fitSavedPage();
  } catch { connectStatus.textContent = "Saved computers are unavailable in this runtime."; }
  finally { loadingSaved = false; }
}
previousPage.addEventListener("click", () => { savedPage--; renderSavedComputers(); });
nextPage.addEventListener("click", () => { savedPage++; renderSavedComputers(); });
document.querySelector("#refresh-saved")!.addEventListener("click", () => { void refreshSavedComputers(); });
new ResizeObserver(fitSavedPage).observe(savedList);
void refreshSavedComputers();
window.setInterval(() => { if (!desktopPanel.hidden && !savedList.contains(document.activeElement)) void refreshSavedComputers(); }, 5000);
openHostButton.addEventListener("click", () => {
  void invoke("open_browser_host").catch(() => setStatus("Could not open browser host"));
});

void start().catch((error) => {
  console.error(`[host] ${startupStage} failed: ${safeError(error)}`);
  setStatus(`Could not start: ${startupStage}`);
});
