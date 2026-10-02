import { invoke as nativeInvoke } from "@tauri-apps/api/core";

type Event<T> = { payload: T };
const browserHost = location.protocol === "http:" && location.hostname === "127.0.0.1";
const hashToken = browserHost && /^#[0-9a-f]{64}$/.test(location.hash) ? location.hash.slice(1) : "";
if (hashToken) {
  sessionStorage.setItem("ninja-host-token", hashToken);
  history.replaceState(null, "", location.pathname);
}
const token = hashToken || (browserHost ? sessionStorage.getItem("ninja-host-token") ?? "" : "");

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!browserHost) return nativeInvoke<T>(command, args);
  if (!token) throw new Error("Browser host token missing");
  if (command === "transport_mode") return "browser" as T;
  if (command === "open_controller") {
    window.open("https://georgefejer91.github.io/ninja-desk/", "_blank", "noopener");
    return undefined as T;
  }
  const response = await fetch(`/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ninja-Token": token },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  const result = await response.json() as { ok: boolean; value?: T; error?: string };
  if (!result.ok) throw new Error(result.error ?? "Request failed");
  return result.value as T;
}

export async function listen<T>(event: string, handler: (event: Event<T>) => void | Promise<void>): Promise<() => void> {
  if (event !== "screen-frame") throw new Error("Unsupported event");
  let active = true;
  let seq = 0;
  const poll = async () => {
    while (active) {
      try {
        const frame = await invoke<{ seq: number; payload: T } | null>("read_frame", { since: seq });
        if (active && frame) { seq = frame.seq; await handler({ payload: frame.payload }); }
      } catch { /* The next poll retries while the app is running. */ }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };
  void poll();
  return () => { active = false; };
}
