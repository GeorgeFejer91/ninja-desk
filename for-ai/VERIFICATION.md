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
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Use Windows Actions if the local MSVC linker is unavailable. Build/test evidence does not replace a real browser/Windows session. For protocol/UI changes, observe wrong-password rejection, no pre-auth media, Stop/reconnect, pointer mapping, and clipboard. For password replacement, verify the old grant is revoked, the app restarts, the new password appears, and the old password is refused. Phone and cross-network claims need those actual surfaces.

## Publication

Review staged files for credentials and generated artifacts before public commit. Push without force; verify remote SHA. Confirm Windows check and Pages workflows for that SHA, fetch the Pages HTML/assets, and run the installer workflow to confirm an NSIS executable artifact. Installer build does not prove installation. Report exact results, limitations, and control-plane changes.
