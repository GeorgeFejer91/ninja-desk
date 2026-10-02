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

## D-0003 — Temporary URL uses a separate in-memory invitation

- Date: 2026-10-02
- Status: Accepted
- Context: The owner wants a URL that opens the browser companion directly for 24 hours, without exposing or rotating the durable access password at expiry.
- Decision: Rust generates one 256-bit invitation at a time, publishes a separate VDO.Ninja control route, and validates its absolute 24-hour deadline on every command. Put bootstrap material in a URL fragment and clear it on load. Keep the invitation only in host memory.
- Consequences: Local revoke or replacement invalidates the URL and its active grant. Restart also invalidates it, so links are valid for *up to* 24 hours while the app keeps running. Possession of the URL grants access during that window.
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
