# Project contract

Ninja Desk gives one owner live view, mouse control, and two-way text clipboard transfer to a signed-in Windows desktop. This single public repository contains the Tauri host, GitHub Pages companion, and NSIS installer workflow.

## Ownership

- `src-tauri/`: Rust local authority, capture, password, session, mouse, clipboard.
- `src/` and root `index.html`: Tauri WebView, Ninja SDK adapter, shared protocol.
- `companion/`: static browser UI. `vite.companion.config.ts` builds `companion-dist/`.
- `branding/`: original transparent logo source and raster exports; `src-tauri/icons/` contains generated installer/app icons.
- `.github/workflows/`: Windows checks/installer artifact and Pages.
- `README.md` and `DESIGN.md`: user and product documentation.
- `for-ai/`: agent control plane; `.for-ai-local/`: ignored evidence.

## Constraints

- Remote desktop authority remains in Rust. Never place credentials in Pages or Git.
- Preserve Tauri identifier `dev.local.vdoninjaremote` through migration so existing Windows DPAPI app data remains accessible.
- One controller, ordinary signed-in Windows desktop, primary display, text clipboard. See `DESIGN.md`.
- The browser companion's connected viewer fills the viewport and offers fullscreen/immersive viewing, fit/original-size zoom, and Mouse/Touch gestures. Its current capture target is about 15 fps; phone latency parity is unverified.
- A successful build does not prove phone, cross-network, or end-to-end runtime behavior.
- The earlier host and companion repositories are migration sources; this repository owns ongoing product work.

## State

The public repository was created 2026-10-02. Product source was migrated from the prior host project. Git, CI, and observed Windows/browser behavior determine verified status.
