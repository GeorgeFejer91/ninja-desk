import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RuntimeStatus = {
  phase: "offline" | "connecting" | "authenticating" | "control_ready" | "media_ready" | "reconnecting" | "stopped" | "revoked" | "error";
  authenticated: boolean;
  remembered: boolean;
  retryScheduled: boolean;
  mediaActive: boolean;
  frames: number;
  lastFrameAgeMs: number | null;
  route: "direct" | "relayed" | "unknown";
};

export type CliAction =
  | { type: "controller_connect"; password?: string; hostId?: string }
  | { type: "controller_disconnect" | "controller_forget" | "controller_probe" }
  | { type: "controller_clipboard_send"; text: string }
  | { type: "host_pair_approve" | "host_pair_revoke" };

export type CliResult = { ok: boolean; code?: string; data?: Record<string, boolean | number | string | null> };

// Local IPC reaches the same handlers as the installed UI. No browser binding
// and no generic command forwarding are exposed by this diagnostic adapter.
export async function startCliBridge(snapshot: () => RuntimeStatus | Promise<RuntimeStatus>, apply: (action: CliAction) => Promise<CliResult>) {
  if (!isTauri()) return;
  let reporting = false;
  let busy = false;
  let closed = false;
  let timer: number | null = null;
  let removeListener: (() => void) | null = null;
  window.addEventListener("pagehide", () => {
    closed = true;
    if (timer !== null) clearInterval(timer);
    removeListener?.();
  }, { once: true });
  const report = async () => {
    if (reporting || closed) return;
    reporting = true;
    try { await invoke("report_runtime_status", { status: await snapshot() }); }
    catch { /* Older runtimes do not implement the optional CLI adapter. */ }
    finally { reporting = false; }
  };
  const unlisten = await listen<{ requestId: string; action: CliAction }>("ninja-cli-action", async ({ payload }) => {
    if (!/^[0-9a-f]{32}$/.test(payload.requestId)) return;
    let result: CliResult = { ok: false, code: "busy" };
    if (!busy) {
      busy = true;
      try { result = await apply(payload.action); }
      catch { result = { ok: false, code: "action_failed" }; }
      finally { busy = false; }
    }
    await report();
    await invoke("complete_cli_action", { requestId: payload.requestId, result }).catch(() => {});
  });
  removeListener = unlisten;
  if (closed) { unlisten(); return; }
  await report();
  if (!closed) timer = window.setInterval(() => { void report(); }, 1000);
}
