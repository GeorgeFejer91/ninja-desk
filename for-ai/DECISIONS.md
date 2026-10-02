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
