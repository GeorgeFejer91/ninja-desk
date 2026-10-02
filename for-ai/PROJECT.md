# Project contract

Ninja Desk gives one owner live view, mouse control, and two-way text clipboard transfer to a signed-in Windows or Linux X11 desktop. The Windows app can also control another host through its bundled controller window. The Linux app uses a localhost browser host and opens the browser companion for control. This public repository contains the Tauri host, browser companion, and Windows/Linux installer workflows.

## Ownership

- `src-tauri/`: Rust local authority, capture, password, session, mouse, clipboard, Linux localhost bridge.
- `src/`, root `index.html`, and `controller.html`: Tauri WebView, desktop controller, Ninja SDK adapter, shared protocol.
- `companion/`: static browser UI. `vite.companion.config.ts` builds `companion-dist/`.
- `branding/`: original transparent logo source and raster exports; `src-tauri/icons/` contains generated installer/app icons.
- `.github/workflows/`: Windows checks/installer artifact, Linux bundle, and Pages.
- `README.md` and `DESIGN.md`: user and product documentation.
- `for-ai/`: agent control plane; `.for-ai-local/`: ignored evidence.

## Constraints

- Remote desktop authority remains in Rust. Never place credentials in Pages or Git.
- Preserve Tauri identifier `dev.local.vdoninjaremote` through migration so existing Windows DPAPI app data remains accessible.
- One controller, ordinary signed-in Windows or Linux X11 desktop, primary display, text clipboard. See `DESIGN.md`.
- The browser companion's connected viewer fills the viewport and offers fullscreen/immersive viewing, fit/original-size zoom, and Mouse/Touch gestures. Capture now targets up to 30 fps with newest-frame delivery; end-to-end latency is unmeasured.
- A successful build does not prove Windows app-to-app, Linux X11, phone, cross-network, or end-to-end runtime behavior.
- The earlier host and companion repositories are migration sources; this repository owns ongoing product work.

## State

The public repository was created 2026-10-02. Product source was migrated from the prior host project. Git, CI, and observed Windows/browser behavior determine verified status.
