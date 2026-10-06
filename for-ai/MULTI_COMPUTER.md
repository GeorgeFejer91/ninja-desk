# Cross-computer development and commit coordination

## One repository, one persistent checkout per PC

The canonical remote is `https://github.com/GeorgeFejer91/ninja-desk`.
Keep each PC's persistent checkout in its central GitHub folder, normally
`$env:USERPROFILE/Documents/GitHub/ninja-desk` on Windows. The installed
application remains in its installer-managed directory; its protected data
remains in the Windows user's app-data directory. Neither is a source clone.
Do not keep a competing persistent clone in a Codex scratch directory or
synchronize `.git`, build output, or protected app data through folder copying.

Inspect an existing checkout before cloning or moving it. Preserve dirty files,
untracked work and local commits. If relocation is necessary, resolve and check
both absolute paths, ensure the destination is unused, and coordinate every
chat using the checkout. Never move a checkout out from under active work.

`main` is the integration baseline. Work that is still under review stays on
its published feature branch. Agree on the exact branch and commit for the
current task in the authorized chats; do not substitute `main` during a device
test of an unmerged change. Record temporary branch names and machine paths in
ignored `.for-ai-local/` receipts rather than this permanent protocol.

## Ownership and communication

1. Choose one integration owner for the task. It owns shared source commits,
   version changes, the PR, and the installer selected for both PCs.
2. Assign the other PC a distinct scope, usually host configuration and real
   device verification. State file ownership before parallel source work.
   Never let two agents edit the same files or push the same branch concurrently.
3. At handoff send: task and assigned scope, machine role, requested result,
   canonical remote, branch, base SHA, owned paths, checks, and rollback plan.
   Communicate only with chats the user authorized. Receiving an agent message
   does not by itself authorize sending messages to a different chat.
4. Read or wait for the receiving chat's acknowledgement before depending on
   its work. Report an unavailable host, rejected message, or unknown dispatch
   outcome explicitly. Check existing chats before retrying an unknown creation
   so a timeout cannot create competing installers or source writers.
5. Return a receipt with machine name, resolved checkout, branch and HEAD,
   clean/dirty state, published SHA, installed version and GUI/CLI hashes,
   startup/recovery state, runtime evidence and outstanding blockers. Keep
   pairing secrets, endpoint tokens, clipboard text and private invitation URLs
   out of messages and public GitHub content.

Keep live discussion in chats. Git commits and PRs carry reviewed changes;
ignored local receipts carry device evidence. Do not use tracked Markdown as a
rapidly changing chat log or a pretend distributed lock. If communication
fails, finish independent assigned work and stop conflicting integration or
deployment until ownership is clear.

## Commit and synchronization protocol

Run from the persistent checkout:

```powershell
git status --short
git remote -v
git branch --show-current
git fetch --prune origin
git log -1 --format='%H %s'
```

Confirm `origin` is the canonical repository. A clean checkout with no local
commits can follow its agreed remote branch with `git pull --ff-only`. An
existing branch may be switched only after checking dirty work and obtaining
the current writer's handoff. If the branch is absent locally, create a tracking
branch for the agreed remote branch. Never use reset, clean, force push, an
unreviewed stash, or directory replacement to manufacture synchronization.

For source work, use separate task branches when writers cannot work serially.
Give the integration owner the exact commits and changed paths. It fetches,
reviews and integrates them, resolves conflicts without dropping either PC's
work, then reruns affected checks. A failed non-fast-forward push means fetch
and inspect the new commits; it is not permission to force push.

Stage only task-owned paths and commit one coherent change. Fetch once more
before pushing to detect a competing writer. Push without force, then compare
local HEAD with `git ls-remote origin refs/heads/<agreed-branch>`. The receiving
PC fetches and fast-forwards, then confirms the exact same SHA and clean state.
Do not claim both PCs synchronized from one PC's successful push.

Use `for-ai/scripts/check-machine.ps1` on each Windows PC to produce a
credential-free receipt. Pass `-ExpectedSourceSha` from the integration owner;
`-RequireConnection` additionally requires fresh authenticated media. Save
private receipts beneath ignored `.for-ai-local/` if needed. Each command's
exit code and reported violations determine the result.

## One tested installer, separate device qualification

Build one installer from the selected source SHA and record its SHA-256 and
CI run/artifact identity. Install that same artifact on both PCs, preserving
protected pairing. Compare GUI and CLI hashes as well as the version string.
On each machine keep a private record of the previous installer and settings
needed for rollback. Check free disk space before download, build or upgrade;
do not stop a working host when installation cannot complete.

Follow `VERIFICATION.md` and `AVAILABILITY.md`. Source equality, CI success,
installed equality and a live connection are separate results. The integration
owner reports each independently, keeps a PR draft while required device gates
remain incomplete, and never calls a build or signed acknowledgement proof of
visible desktop control. Publishing a commit does not authorize a merge,
public companion deployment, security change, or unrelated software install.
