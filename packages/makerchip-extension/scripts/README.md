# VS Code storage maintenance scripts

Risky AI-generated utility scripts for cleaning up the debris VS Code leaves behind in
`~/.config/Code/`. Both are self-contained Python 3 (stdlib only) and share the
same safety model.

> [!IMPORTANT]
> **Quit every VS Code window before running either script.** VS Code is
> single-instance: one process hosts all windows and keeps the SQLite storage
> DBs open, rewriting them on exit. Edits made while it is running get silently
> overwritten. Both scripts refuse to run while `code` is detected (override
> with `--force`, at your own risk).
>
> Both scripts are **reversible** — nothing is hard-deleted. Removed data is
> moved into a timestamped archive and edited files are snapshotted first.
> Always start with `--dry-run`.

---

## `scrub-ghost-editors.py`

Removes phantom "ghost" untitled editor tabs from a workspace's persisted editor
layout.

**Symptom:** empty untitled tabs reopen every session with bogus titles like a
quoted path, `&&`, or a stale `/tmp/...` file — none of which exist on disk.

**Cause:** an editor entry with
`id == workbench.editors.untitledEditorInput` whose `resourceJSON` has
`scheme == "file"` but points at a path that does not exist. These get re-seeded
into new Extension Development Host windows via
`windowsState.lastPluginDevelopmentHostWindow`, so they propagate forward on
every launch until scrubbed.

**What it does:**
- Scans each `workspaceStorage/<hash>/state.vscdb`, finds ghost editors, removes
  them, and remaps the `mru` / `active` / `preview` / `sticky` indices.
- Also cleans stale `textResourceEditor` view-state.
- Backs up each modified DB to `state.vscdb.ghostbak-<timestamp>` alongside it.

```bash
python3 scrub-ghost-editors.py --dry-run   # preview
python3 scrub-ghost-editors.py             # apply
```

Flags: `--dry-run`, `--force`.

---

## `prune-orphan-workspaces.py`

Deletes workspace storage (and matching global bookkeeping) for workspaces whose
backing folder or `.code-workspace` file no longer exists.

**Why:** deleting a project or workspace file leaves its
`workspaceStorage/<hash>/` dir — including chat history and caches — plus
scattered global references, forever. Nothing garbage-collects it. On one
machine this accounted for **65 orphaned dirs / ~8 GB**.

**What it removes (for each orphaned workspace):**
- `User/workspaceStorage/<hash>/`
- `Backups/<hash>/` (hot-exit backups)
- Matching entries in `globalStorage/storage.json`:
  `backupWorkspaces`, `profileAssociations`, `windowSplashWorkspaceOverride`,
  `windowsState`
- Matching entries in `Backups/workspaces.json`
- Any missing-path entries in a `recentlyOpened` MRU list (if present in
  `globalStorage/state.vscdb`)

**Safety rules:**
- Only `file://` targets are ever considered. Remote workspaces
  (`vscode-remote://`, `vscode-userdata://`, …) cannot be verified locally and
  are **always preserved**.
- Non-workspace storage dirs are skipped: `ext-dev`, `vscode-chat-images`,
  `vscode-userdata`.
- Everything removed is moved into `~/.config/Code/.storage-cleanup-<timestamp>/`,
  which also holds pre-edit snapshots of `storage.json`, `state.vscdb`, and
  `workspaces.json`. To undo, move the dirs back and restore the snapshots. Once
  satisfied, delete the archive to actually reclaim the space.

```bash
python3 prune-orphan-workspaces.py --dry-run   # preview
python3 prune-orphan-workspaces.py             # apply
```

Flags: `--dry-run`, `--force`.

> [!WARNING]
> **Chat history is stored per-workspace** (`chatSessions/` and
> `GitHub.copilot-chat/` inside each `workspaceStorage/<hash>/`). Pruning an
> orphaned workspace therefore removes its chats too. They are recoverable from
> the archive until you delete it — but if you want to keep a conversation from
> a deleted project, rescue it from the archive first.
