const encoder = new TextEncoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("Invalid access password");
  return Uint8Array.from(hex.match(/../g)!, (part) => Number.parseInt(part, 16));
}

export function nonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export async function importHmacKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacBytes(key: Uint8Array | CryptoKey, message: string): Promise<Uint8Array> {
  const imported = key instanceof Uint8Array ? await importHmacKey(key) : key;
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

export async function hmacHex(key: Uint8Array | CryptoKey, message: string): Promise<string> {
  return bytesToHex(await hmacBytes(key, message));
}

export async function roomFromPassword(password: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(password)) throw new Error("Access password must be 64 hexadecimal characters");
  return (await sha256Hex(hexToBytes(password))).slice(0, 32);
}

export type AccessLinkSecret = { id: string; secret: string };

export function parseAccessFragment(hash: string): AccessLinkSecret | null {
  if (!hash.startsWith("#access=")) return null;
  const match = /^#access=v1\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(hash);
  if (!match) throw new Error("Invalid access link");
  return { id: match[1], secret: match[2] };
}

export async function routePasswordForAccessLink(secret: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid access link");
  return hmacHex(hexToBytes(secret), "route|v1");
}

export function transcript(room: string, generation: string, peer: string, hostNonce: string, clientNonce: string, hostCert: string, clientCert: string): string {
  return `v1|${room}|${generation}|${peer}|${hostNonce}|${clientNonce}|${hostCert}|${clientCert}`;
}

export function mouseMessage(generation: string, peer: string, seq: number, op: number, x: number, y: number, arg: number, displayRevision?: number): string {
  return `mouse|${generation}|${peer}|${seq}|${op}|${x}|${y}|${arg}${displayRevision === undefined ? "" : `|${displayRevision}`}`;
}

export function monitorMessage(generation: string, peer: string, seq: number, displayRevision: number): string {
  return `monitor|${generation}|${peer}|${seq}|${displayRevision}`;
}

export async function clipboardMessage(generation: string, peer: string, seq: number, text: string): Promise<string> {
  return `clipboard|${generation}|${peer}|${seq}|${await sha256Hex(text)}`;
}
