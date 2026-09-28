# Development — Redwood Internal

> **⚠️ Redwood-internal.** This guide covers co-developing the Makerchip VS Code
> extension against a local **`mono`** server clone. `mono` (the Makerchip
> monorepo / SandHost) is a **private Redwood EDA repository**; the workflow
> below is not usable without it, which is why it is kept out of the public
> [CONTRIBUTING.md](CONTRIBUTING.md). For build, PR, and the public `./launch`
> (deployed server) and F5 flows, start there.

Everything in the public guide still applies. This document adds only what is
specific to running the extension against a **local `mono` clone**: the
`./launch <clone>` mode, the tunnel it creates, the per-clone VS Code profile,
and the day-to-day iteration loop.

## The clone is the unit of coupling

```
clone ↔ SandHost/port ↔ tunnel ↔ workspace ↔ VS Code profile
```

`./launch <clone>` does everything needed to develop against one clone:

- starts the clone's SandHost (`bin/start`) if it isn't already running,
- ensures a Cloudflare tunnel to that SandHost's port,
- opens the clone's workspace (`.vscode-env/<clone>.code-workspace` inside the
  clone),
- in a VS Code profile (`--user-data-dir`) **dedicated to that clone**
  (`.vscode-env/profile` inside the clone), seeded with your normal settings.

Both the workspace and the profile are created and owned by the clone's own
`bin/vscode_setup` (via `install.sh`); they live inside the clone under a
git-ignored `.vscode-env/` directory. `./launch` and the clone's `bin/open_code`
open the **same** per-clone profile (the clone must be installed first). Each
clone gets its own profile so each can run its own Extension Development Host
(EDH) — VS Code allows one EDH per `--user-data-dir` — with its own Copilot
chats, while sharing your settings/keybindings/snippets (symlinked, not copied).
The deployed modes (no clone) share one profile and open no workspace.

## `./launch <clone>`

```bash
# A local mono clone (3 forms; see resolution below)
./launch feature_x
./launch mono_feature_x
./launch ~/repos/mono_feature_x
```

A clone reference is resolved, in order, as:

1. a path (relative or absolute) to an existing clone directory,
2. a directory `<name>` under `$MONO_REPO_PARENT_DIR` (default: the parent of
   this extension repo, i.e. `~/repos` in the standard layout),
3. the slug form `mono_<name>` under that same parent.

Compared with a deployed-server launch (`./launch` / `./launch <url>`), the
clone mode additionally starts the clone's SandHost + tunnel, opens a dedicated
workspace, and uses a per-clone VS Code profile. The sandhost is selected
explicitly by the argument (deployed modes use the default or an explicit URL).

## Workflow for local development

1. **Launch against a clone** (from the extension repo):
   ```bash
   ./launch feature_x
   ```
   Stop the clone's SandHost with `bin/stop` (in the clone).

2. **Edit `mono`** → restart the SandHost (`bin/start` in the clone) → run
   **Makerchip: Reload Panels** (or ask Copilot to reload panels) to reconnect →
   open webviews to the fresh build (or re-run `./launch <clone>`).

3. **Edit the extension** → reload the VS Code window (Developer: Reload
   Window). The EDH does not hot-reload; wait for `tsc` to finish first.

4. **Re-run `./launch <clone>`** to refocus that clone's existing window — VS
   Code restarts the dev host to load the latest build (no duplicate) — and
   re-ensure the tunnel.

## Managing tunnels

There is at most one tunnel per clone. It may remain up for as long as you are
working with the clone.

**Start it.** If needed, `./launch <clone>` starts the tunnel (cloudflared, in
its own session via `setsid`) in the background; it keeps running until torn
down. The tunnel is owned by the clone: its URL is recorded in the clone's
`sandhost/TUNNEL_INFO`, which the extension re-reads (resolved from its
workspace folder) whenever a panel is built — so opening a new panel, reloading
the window, or running **Makerchip: Reload Panels** picks up the current tunnel.

**Stop it.** The tunnel is intentionally independent of the SandHost: `bin/stop`
(and `bin/start`'s restart) leave it running so an open window survives a
SandHost restart. Tear it down explicitly when you're done with the clone (e.g.
before trashing it):

```bash
bin/teardown_tunnel   # in the clone; stops cloudflared, clears sandhost/TUNNEL_INFO
```

**Restart it.** If you do restart the tunnel, just restart the Makerchip
webviews (**Makerchip: Reload Panels**) to repoint them.

**Reap strays.** Detached SandHosts and tunnels outlive a deleted/trashed clone.
Find and clean them with the clone's reaper (any clone's copy works — it scans
the whole machine):

```bash
bin/reap          # Report orphans, then prompt [y/N] to kill them.
                  # Or run with --report or --kill to avoid the prompt.
```

## F5 against a clone (discovery)

F5 launches the EDH as a debug session of the current window (the only way to
get **breakpoints**), but it does **not** start a clone's SandHost or tunnel and
it is not pinned to a server by `./launch`. Instead, `getServerUrl()` has a
discovery fallback that runs **only** for an F5 EDH: it scans the open workspace
folders for a clone's `sandhost/TUNNEL_INFO`.

To debug against a clone:

1. Bring its SandHost and tunnel up — `./launch <clone>` once, or the clone's own
   `bin/start` plus a tunnel.
2. Add the clone as a workspace folder.
3. Reload, then F5.

This scan is deliberately skipped for a `./launch` EDH (`./launch` exports
`MAKERCHIP_LAUNCH=1`) so whatever folders happen to be open can never override
its explicit choice.
