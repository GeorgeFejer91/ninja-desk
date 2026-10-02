# Decision log

Record only durable choices whose rationale future agents would otherwise have
to rediscover. Source and tests remain the authority for implementation facts.

## D-0001 — Minimal control plane before product scaffolding

- Date: 2026-10-02
- Status: Accepted
- Context: The project needs a predictable AI entrypoint without choosing an
  application stack or inventing product structure prematurely.
- Decision: Use a short root `AGENTS.md` that routes to a lowercase `for-ai/`
  control plane. Keep product output outside that folder and add project files,
  skills, and protocols only for current requirements.
- Consequences: New agents get a reliable map and readiness gates. Product
  ownership was later recorded in `PROJECT.md`.
- Supersedes: None

## D-0002 — One public product repository

- Date: 2026-10-02
- Status: Accepted
- Context: The host and public companion were split across two repositories; the user requested one public project with an installer and Pages.
- Decision: Keep host, companion, documentation, and workflows in this public repository. Deploy only the built companion to Pages. Build the Windows NSIS installer as a separate Actions artifact.
- Consequences: Source and the companion page are public. Remote control still requires the host-generated password. Preserve the internal Tauri identifier so existing DPAPI data remains readable.
- Supersedes: None

## D-0003 — Linux WebRTC in an external local browser

- Date: 2026-10-02
- Status: Accepted
- Context: Linux WebKitGTK WebRTC is experimental or disabled in current releases, while the product transport depends on WebRTC.
- Decision: Keep Rust as the Linux desktop authority and expose only a token-protected localhost API to a browser-host page bundled with the app. Use the default browser for Linux hosting and control; target X11 input. Windows retains its integrated WebView transport and controller.
- Consequences: The browser host requires a local browser window and a working default browser. The Linux package must be tested on a real X11 desktop; build success cannot establish runtime support. The existing VDO.Ninja signaling path remains required and may select a direct or relayed ICE route.
- Supersedes: None

## D-0004 — Separate Linux screen capture dependency

- Date: 2026-10-02
- Status: Accepted
- Context: `xcap` links PipeWire on Linux even for X11 capture, and its current PipeWire bindings do not compile against Ubuntu 22.04 headers.
- Decision: Use `screenshots` for the Linux capture path and keep `xcap` for Windows. Convert the Linux image buffer into the existing JPEG encoder's image type without copying pixels.
- Consequences: The Ubuntu 22.04 installer can target X11 without PipeWire build headers. Capture and control still require a real X11 desktop test.
- Supersedes: None

## Record format

For later decisions, add one compact entry with:

- identifier and title;
- date and status (`Proposed`, `Accepted`, `Superseded`, or `Rejected`);
- context;
- decision;
- consequences;
- supersession link when applicable.

Do not rewrite accepted history to hide a changed direction. Add a superseding
decision and link both entries.
