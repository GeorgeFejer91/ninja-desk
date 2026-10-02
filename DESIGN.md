# VDO.Ninja screen, mouse, and clipboard remote

Status: implementation prototype; a local browser-to-Windows session passed the core screen, mouse, and text clipboard checks on 2026-10-01. The host and GitHub Pages companion now share the Ninja Desk repository. A physical phone and connection from another network are not yet qualified. Target one Windows 10/11 laptop and one active controller in a phone or desktop browser. The laptop must be on, signed in, and running the host app.

## Source review and scope

Reviewed [RustDesk `fada664`](https://github.com/rustdesk/rustdesk/tree/fada664df7a294d1d1a9ca3e7cd3637069122f17) and [Ninja SDK `3065375`](https://github.com/steveseguin/ninjasdk/tree/3065375308420da2f01fd57b4974088a39274cf9) on 2026-10-01. RustDesk implements screen capture and input as local [client/service components](https://github.com/rustdesk/rustdesk/blob/fada664df7a294d1d1a9ca3e7cd3637069122f17/README.md). The [Ninja SDK](https://github.com/steveseguin/ninjasdk/blob/3065375308420da2f01fd57b4974088a39274cf9/docs/remote-control.md) transports WebRTC media and data but does not move the Windows mouse. This project will implement its own local mouse operations and use the SDK for VDO.Ninja-compatible transport. No RustDesk server protocol or copied RustDesk code is needed.

The requested first release has:

- live view of the desktop, initially the primary monitor;
- pointer movement, left/right/middle clicks, scroll, and press/release for dragging;
- two-way clipboard transfer during an authorized session;
- a password prompt, one active controller, reconnect, and local Stop.
- phone controls for relative mouse mode, direct touch mode, click/drag, two-finger right click and view zoom/pan, three-finger scroll, and view options.

General keyboard input, file transfer, audio, printing, terminal, tunneling, restart, privacy mode, and RustDesk account/server functions are not yet implemented. The user has asked for RustDesk-like phone navigation; this prototype implements the controls that map to its screen, mouse, and clipboard backend. Full RustDesk layout/settings parity is not yet achieved.

## Shape

```text
Phone or desktop browser: static HTTPS companion + pinned Ninja SDK
                           | authenticated control channel in the password-derived room
                           | desktop video in a fresh room revealed after authorization
VDO.Ninja-compatible signaling / STUN / optional TURN
                           |
Windows laptop: Tauri v2 WebView2 SDK adapters
                           | authenticated local bridge
                 Rust authority: password, grant, capture, mouse, clipboard, Stop
```

The browser page can be hosted as static HTTPS assets; it stores no desktop data or backend authority. A page served solely from laptop localhost would be unreachable from an arbitrary distant phone. The WebRTC path may be direct or TURN-relayed; show the observed route rather than assuming direct access. The local Rust authority decides every action. A VDO room or peer ID only helps discovery.

The current package pins `@vdoninja/sdk` 1.6.1 and uses its documented signaling API; it does not implement the VDO handshake WebSocket. The SDK core is [MPL-2.0](https://github.com/steveseguin/ninjasdk/blob/3065375308420da2f01fd57b4974088a39274cf9/LICENSING.md). Rust captures the primary monitor with `xcap`, JPEG-encodes frames, and sends them through Tauri events to a canvas in WebView2. The control stream contains only black pixels. After Rust authorizes one peer, the host publishes the desktop canvas in a separate room whose random session credential is delivered only over the authenticated data channel. A local browser session with the separated media path showed live desktop video, mouse movement/click, and two-way text clipboard transfer. A second browser received only the control track and an access-denied response while the first remained connected. A short test also showed live frames and remote pointer movement while the host window was minimized. The deployed HTTPS companion authenticated and showed live desktop video from a browser on that same laptop. Latency, frame rate, sustained minimized-window behavior, a physical phone, and a connection from another network remain unverified. The app does not rely on browser screen-selection prompts.

## One-owner access password

At local setup, generate a random 256-bit password (64 hexadecimal characters). The owner saves it in a password manager and types/pastes it into the browser for each session. The Windows host protects its copy with user-scoped [DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) in its app-data directory. The room ID derives from the password, so the browser asks for only one value. This deliberately replaces the earlier OPAQUE plan and does not support a short, user-chosen password. The local **Replace password** action revokes access, writes a new DPAPI-protected password, and requires an app restart before showing/using the new value. Local Stop revokes the current session until the host restarts.

The password is supplied to the Ninja SDK for its signaling protection, but that alone does not authorize the desktop. Over the control data channel, browser and host exchange fresh nonces and prove possession of the generated password with HMAC-SHA-256 bound to the target, protocol version, and both WebRTC certificate fingerprints. Rust then derives a fresh media-room credential from the session key. The host sends no desktop pixels in the control room and starts the media stream only after this proof succeeds. Derive a separate per-session MAC key and require a sequence-numbered MAC on each mouse command. A captured proof cannot feasibly be brute-forced because the password is random and high-entropy; this design is unsuitable for a memorable password.

Rust holds one control grant for at most 24 hours, tied to the authenticated peer and host generation. Every mouse or clipboard command checks that grant, its sequence number, the MAC, and bounds. Mouse commands reject a changed main-display size. Local Stop, password replacement, or disconnect revokes the grant and releases a held left button. There are no accounts, device records, or remembered-browser tokens in the first release. No password or grant appears in a URL, logs, or public assets.

## Mouse contract

The browser sends only move, left-button press/release, click, and scroll operations with bounded normalized coordinates and signed sequence numbers. The video rectangle maps to the primary monitor size; Rust rejects commands if the main-display dimensions changed since authorization. The browser drops excess queued pointer moves while preserving serialized button operations. Rust sends an acknowledgement for each applied or rejected command; a browser timeout is not proof that a click did not happen. Geometry changes with identical dimensions remain a limitation to qualify.

Use [Enigo](https://docs.rs/enigo/0.6.1/enigo/) for native Windows pointer input from Rust. [PyAutoGUI's Windows implementation](https://github.com/asweigart/pyautogui/blob/master/pyautogui/_pyautogui_win.py) also calls Windows APIs through Python `ctypes`; adding a Python sidecar would not give this Rust/Tauri host extra mouse authority. Windows input is limited by integrity levels, so the first release claims control only of the signed-in user's ordinary desktop, not UAC prompts or the secure lock screen. Keep a local Stop control visible and test release of a held button when the connection drops.

## Clipboard contract

The current host polls Windows text clipboard every 500 ms while a controller is authorized and sends changed items to the browser. Browser paste/send places text on the Windows clipboard. Rust remembers the last item to prevent immediate echoes. It does not persist clipboard history, log contents, or transfer before authentication. A [clipboard format listener](https://learn.microsoft.com/en-us/windows/win32/dataxchg/using-the-clipboard) and item IDs/revisions remain an optimization if tests find polling or deduplication inadequate.

The first interoperable format is `text/plain` UTF-8, including multiline text, capped at 256 KiB. PNG images, files, and rich clipboard formats are not implemented. If images are added later, they need a separate bounded transfer lane so they cannot delay mouse commands.

An ordinary browser cannot guarantee silent, continuous two-way system clipboard access across Chrome, Firefox, Safari, and phone browsers. [Browser clipboard rules](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API) can require focus, a user gesture, or permission, and differ by engine. The companion will sync automatically where a browser grants it; otherwise it shows the latest remote clipboard with a **Copy to this device** action and accepts **Paste/send to laptop** through a focused paste field or button. These explicit actions still put the item in the other device's clipboard. Do not represent the fallback as background auto-sync.

## Acceptance gate

From a real phone or desktop browser, open the HTTPS companion, enter the generated password, see the live laptop screen, move and click the mouse, scroll and drag, and observe Rust acknowledgements. Copy text on Windows and place it in the browser device's clipboard; copy text on the browser device and place it in Windows' clipboard, using a user action when that browser requires one. Verify multiline/Unicode text, no echo loop, size rejection, wrong-password rejection, **no pre-auth video or clipboard**, stale/replayed command rejection, Stop, disconnect cleanup, and reconnect. Record Windows/WebView2/browser/SDK versions, clipboard permission behavior, and selected ICE route. A Tauri build or SDK room connection alone does not meet this gate.

Open implementation decisions: capture-to-WebRTC performance and sustained minimized-window behavior, SDK certificate stats availability on target phone browsers, and whether managed VDO.Ninja signaling/TURN service limits fit this use. The static HTTPS companion is public. An NSIS installer is built through the Windows installer workflow; installed operation and a remote phone session still require qualification.
