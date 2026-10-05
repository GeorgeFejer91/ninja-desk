# Verification gates

Use `VERIFIED`, `PARTIAL`, `BLOCKED`, or `NOT RUN`; identify the surface each result covers.

## Context

```powershell
pwsh -NoProfile -File for-ai/scripts/check-context.ps1 -ProjectRoot . -RequireRemote
git status --short
git diff --check
```

The bundled context checker needs PowerShell 7 (`pwsh`) here; Windows PowerShell 5.1 misread `origin/main` during bootstrap.

## Product

```powershell
npm ci
npm run build
npm run check:protocol
npm run check:view
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Use Windows Actions if the local MSVC linker is unavailable. Build/test evidence does not replace a real browser/Windows session. For protocol/UI changes, observe wrong-password rejection, no pre-auth media, Stop/reconnect, pointer mapping, and clipboard. For password replacement, verify the old grant is revoked, the app restarts, the new password appears, and the old password is refused. For access links, verify direct URL open without password entry, the same screen/pointer/clipboard path, and old-link rejection after replacement, revocation, expiry, and app restart. Phone and cross-network claims need those actual surfaces.

For Linux, run the x86_64 Ubuntu 22.04 installer workflow, then install and run the exact `.deb` or `.AppImage` on an X11 desktop. Open the browser host and a second PC's controller, verify capture, mouse, clipboard, Stop/reconnect, and secret-file permissions. Wayland is outside the current target. For latency claims, measure input-to-effect and screen-change-to-viewer display p50/p95/p99 on real devices and record the ICE route; frame-rate settings and builds alone are not latency evidence.

For fast capture, use the installed Windows WebView and Linux browser host: select the primary monitor, confirm pointer mapping and no pre-auth media, then end browser sharing and verify automatic-capture fallback. Record the browser's applied resolution/frame rate, negotiated codec, and ICE route beside any latency measurements.

For Low data mode, compare WebRTC outbound video bytes over equal 60-second still-screen and moving-screen sessions in normal and Low data modes on the same route. Verify the toggle both before and during a connection, primary-display pointer mapping after scaling, correct new frames after idle, and recovery when browser display constraints are refused. Record applied capture settings and sender bitrate parameters. Do not infer a data-savings percentage from configured limits alone.

For saved desktop trust, pair an installed Windows controller from a password session, then restart both apps and verify password-free reconnect, screen, mouse, and clipboard. Interrupt the network and restore it; observe bounded retries, fresh authorization, and no stale command replay. Verify host-side Revoke terminates its active trusted session, Forget removes the controller credential, Replace password clears host trust, and a normal password session still works after trust revocation. Verify closing the main window leaves one tray-host process, tray Quit ends availability, a second launch focuses the existing instance, and the Start with Windows toggle's enabled/disabled registration and hidden sign-in launch. These are device gates, not build-only gates.

## Publication

Review staged files for credentials and generated artifacts before public commit. Push without force; verify remote SHA. Confirm Windows check and Pages workflows for that SHA, fetch the Pages HTML/assets, and run the installer workflow to confirm an NSIS executable artifact. Installer build does not prove installation. Report exact results, limitations, and control-plane changes.
Confirm the Linux workflow yields `.deb` and `.AppImage` artifacts when Linux support changes. Installer build does not prove installation or runtime behavior.
