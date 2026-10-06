# Persistent Windows host availability

## Observable contract

The host should be available to its remembered controller whenever it is
powered, awake, signed into the correct Windows account, running Ninja Desk,
and able to reach signaling and a working WebRTC route. A temporary browser
invitation is not permanent device trust. Use the installed remembered-PC
pairing and preserve each user's protected credential files.

The current implementation supplies desktop view, mouse control and text
clipboard. General remote keyboard input, UAC/secure desktop, the Windows lock
screen, signed-out access, file transfer and audio remain outside its contract.
Document those limits rather than describing it as a complete replacement for
every remote-desktop operation. No configuration can guarantee availability
while the PC is off or the network/signaling service is unavailable.

## Setup on both PCs

1. Confirm the canonical checkout/source and exact installed GUI/CLI with the
   cross-computer protocol. Inspect disk space before upgrading either PC.
2. Enable the app's visible **Start with Windows** setting. Verify the quoted
   current-user Run entry and Windows startup approval. Launch without `--show`
   on the host, keep one process, and confirm closing the management window
   leaves the tray host running. No automatic Windows login is implied.
3. Establish and approve remembered-PC trust once. Verify the host reports a
   trusted PC and the controller reports the selected saved computer. Keep
   secrets in Windows-protected app data, outside the public repository.
4. For automatic controller opening, use the existing `startup-controller-v1`
   preference for the exact saved host. It contains only its host identifier;
   the native app checks the protected pairing before opening the viewer.
   Other saved computers must not silently replace a missing target.
5. For an always-available desktop host on AC, inspect its current power policy
   and prevent automatic system sleep/hibernate if needed and authorized by
   the requested setup. Record original values and how to restore them. Display
   sleep may remain enabled. Do not silently alter the controller's battery
   policy, account lock settings, automatic login, firewall, or router.

## Recovery policy

The app retries interrupted host routes and saved-controller connections with
bounded backoff capped at 30 seconds. Network recovery must reuse persisted
device trust and create fresh sessions; it must not replay old commands.

Windows sign-in autostart is not crash supervision. If continuous process
recovery is configured, use one documented current-user supervisor, fixed
installed executable paths, limited privileges, a bounded restart rate, and a
visible disable/remove procedure. Never interpret an idle host, a sleeping
peer, or a single missed report as a crash. Do not kill a working host or reset
its pairing to repair an unavailable network. Verify actual recovery instead
of assuming a scheduled task registration proves it.

If the native process exists but CLI/renderer reports repeatedly stay stale,
collect credential-free diagnostics and coordinate one guarded restart after
preserving the installed artifact and protected data. Do not loop restarts or
add an unauthenticated control endpoint. Stop/revoke/Forget must retain their
documented authorization effects; a supervisor must not recreate removed trust.

## Required device evidence

Record exact machine/source/build identities and the following results:

| Scenario | Required observation |
| --- | --- |
| Ordinary cold start | One tray-host process; saved pairing preserved; fresh CLI report |
| Windows sign-in | Actual sign-in starts the host; quoted registration alone is partial evidence |
| Controller on demand | Saved-PC reconnect authenticates and receives fresh rendered frames |
| Automatic controller startup | Selected saved host opens without code entry; unavailable target retries |
| Host restart | Controller reconnects automatically with new authentication and fresh frames |
| Network interruption/recovery | Bounded retries; fresh session after restoration; no stale input |
| Crash recovery, if enabled | Supervisor restores the exact installed process; no restart storm |
| AC idle/display sleep | System remains available while its display may sleep |
| Trust revoke/Forget | Active access ends; removed authorization is not restored by retries |
| Desktop interaction | Visible mouse effect and clipboard transfer on the real selected monitor |
| Long session/other network | Actual sustained session and measured direct/relay route, if claimed |

`ninja-desk-cli.exe status --json` and `doctor --json` are redacted native
diagnostics. Require fresh reports, authentication, media activity and recent
frames. A `controller connect` acceptance or `controller probe`
acknowledgement alone does not prove visible control. Use `check-machine.ps1`
for repeatable source, installation, startup and runtime receipts.

Report setup, restart, sign-in, crash recovery, and full remote interaction as
separate VERIFIED/PARTIAL/BLOCKED/NOT RUN results. Keep unresolved device or
network failures visible to the user and the other PC's agent.
