import { invoke, listen } from "./bridge";
import VDONinja from "@vdoninja/sdk";
import logoUrl from "../branding/ninja-desk.svg";
import { fingerprints } from "./fingerprints";
import { isRecord, roomFromPassword, routePasswordForAccessLink } from "./protocol";
import { watchTextFit } from "./text-fit";

type Bootstrap = { room: string; streamId: string; password: string; generation: string };
type Challenge = { nonce: string; generation: string; hostCert: string; clientCert: string };
type AuthResult = { proof: string; width: number; height: number; cursorX: number; cursorY: number; mediaPassword: string };
type Frame = { jpegBase64: string; width: number; height: number; cursorX: number; cursorY: number };
type AccessLink = { id: string; secret: string; expiresAtMs: number };

const status = document.querySelector<HTMLElement>("#status")!;
const passwordField = document.querySelector<HTMLInputElement>("#password")!;
const revealButton = document.querySelector<HTMLButtonElement>("#reveal")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const fastCaptureButton = document.querySelector<HTMLButtonElement>("#fast-capture")!;
const replacePasswordButton = document.querySelector<HTMLButtonElement>("#replace-password")!;
const controlButton = document.querySelector<HTMLButtonElement>("#control")!;
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
let mediaSdk: VDONinja | null = null;
let mediaTrack: CanvasCaptureMediaStreamTrack | null = null;
let publishedTrack: MediaStreamTrack | null = null;
let fastCapture: MediaStream | null = null;
let activePeer: string | null = null;
let activeTransport: VDONinja | null = null;
let currentInvite: Pick<AccessLink, "id" | "expiresAtMs"> | null = null;
let stopped = false;
let startupStage = "bootstrap";
let incomingQueue: Promise<void> = Promise.resolve();
let incomingPending = 0;

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
    await track.applyConstraints({ width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 60, max: 60 } }).catch(() => {});
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

function bindControl(transport: VDONinja, inviteId?: string) {
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
    incomingQueue = incomingQueue.then(() => handleData(transport, event.detail.uuid, event.detail.data, inviteId))
      .catch((error) => console.warn(`[host] command failed: ${safeError(error)}`))
      .finally(() => { incomingPending--; });
  });
  transport.on("peerDisconnected", (event) => {
    if (event.detail.uuid === activePeer) closeActive(transport);
  });
  transport.on("disconnected", () => {
    closeActive(transport);
    if (!stopped && transport === sdk) setStatus("Reconnecting…");
    if (!stopped && transport === inviteSdk) setStatus("Access link reconnecting…");
  });
}

async function startMedia(password: string) {
  const room = await roomFromPassword(password);
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
    await candidate.publish(stream, { streamID: `host_${room}`, label: "Desktop" });
    if (mediaSdk !== candidate || !activePeer) throw new Error("Media session canceled");
    publishedTrack = track;
  } catch (error) {
    if (mediaSdk === candidate) { mediaSdk = null; mediaTrack = null; publishedTrack = null; }
    await candidate.disconnect().catch(() => {});
    throw error;
  }
}

async function handleData(transport: VDONinja, peer: string, data: unknown, inviteId?: string) {
  if (!isRecord(data) || typeof data.type !== "string" || stopped || (transport !== sdk && transport !== inviteSdk)) return;
  try {
    if (data.type === "auth_hello" && typeof data.clientNonce === "string") {
      const pair = await fingerprints(transport, peer, "publisher");
      if (transport !== sdk && transport !== inviteSdk) return;
      const challenge = await invoke<Challenge>("begin_auth", { peer, hostCert: pair.local, clientCert: pair.remote, inviteId });
      send(peer, { type: "auth_challenge", peer, ...challenge }, transport);
      return;
    }
    if (data.type === "auth_proof" && typeof data.clientNonce === "string" && typeof data.proof === "string") {
      const result = await invoke<AuthResult>("finish_auth", { peer, clientNonce: data.clientNonce, proof: data.proof, inviteId });
      if (transport !== sdk && transport !== inviteSdk) {
        await invoke("disconnect", { peer }).catch(() => {});
        return;
      }
      activePeer = peer;
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
    if (data.type === "mouse") {
      const command = { peer, seq: data.seq, op: data.op, x: data.x, y: data.y, arg: data.arg, mac: data.mac };
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
    send(peer, { type: "auth_error" }, transport);
  }
}

async function start() {
  void watchTextFit().catch(() => {});
  const config = await invoke<Bootstrap>("bootstrap");
  startupStage = "events";
  passwordField.value = config.password;
  if (await invoke<string>("transport_mode") === "external") {
    openHostButton.hidden = false;
    setStatus("Open browser host to receive connections");
    return;
  }
  sdk = new VDONinja({ password: config.password, salt: "vdo.ninja" });
  bindControl(sdk);
  await listen<Frame>("screen-frame", async (event) => {
    if (!activePeer || stopped) return;
    const bytes = Uint8Array.from(atob(event.payload.jpegBase64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      if (canvas.width !== event.payload.width || canvas.height !== event.payload.height) {
        canvas.width = event.payload.width;
        canvas.height = event.payload.height;
      }
      if (activePeer && !stopped) {
        context.drawImage(bitmap, 0, 0);
        const { cursorX, cursorY, width, height } = event.payload;
        if (cursorX >= 0 && cursorX < width && cursorY >= 0 && cursorY < height) {
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
  setStatus("Connecting to VDO.Ninja…");
  await sdk.connect();
  startupStage = "room";
  setStatus("Joining room…");
  await sdk.joinRoom({ room: config.room, password: config.password });
  startupStage = "video";
  setStatus("Publishing control channel…");
  await sdk.publish(controlCanvas.captureStream(1), { streamID: config.streamId, label: "Control channel" });
  startupStage = "ready";
  setStatus("Waiting for controller");
  setInterval(async () => {
    if (!activePeer || stopped) return;
    const authoritativePeer = await invoke<string | null>("active_peer").catch(() => null);
    if (authoritativePeer !== activePeer) {
      activePeer = null;
      fastCaptureButton.disabled = !!fastCapture || stopped;
      activeTransport = null;
      closeMedia();
      blankScreen();
      setStatus("Waiting for controller");
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
  activePeer = null;
  stopFastCapture();
  activeTransport = null;
  closeMedia();
  blankScreen();
  await invoke("stop");
  clearInvite();
  await sdk?.disconnect();
  setStatus("Stopped");
  stopButton.disabled = true;
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
    activePeer = null;
    stopFastCapture();
    activeTransport = null;
    closeMedia();
    blankScreen();
    clearInvite();
    await sdk?.disconnect();
    stopButton.disabled = true;
    setStatus("Restarting with new password…");
  } catch {
    stopped = true;
    activePeer = null;
    stopFastCapture();
    activeTransport = null;
    await invoke("stop").catch(() => {});
    closeMedia();
    blankScreen();
    clearInvite();
    await sdk?.disconnect().catch(() => {});
    setStatus("Password replacement failed. Remote access is stopped.");
    stopButton.disabled = true;
    replacePasswordButton.disabled = false;
  }
});

controlButton.addEventListener("click", () => {
  void invoke("open_controller").catch(() => setStatus("Could not open controller"));
});
openHostButton.addEventListener("click", () => {
  void invoke("open_browser_host").catch(() => setStatus("Could not open browser host"));
});

void start().catch((error) => {
  console.error(`[host] ${startupStage} failed: ${safeError(error)}`);
  setStatus(`Could not start: ${startupStage}`);
});
