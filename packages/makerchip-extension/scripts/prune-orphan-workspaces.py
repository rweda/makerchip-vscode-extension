#!/usr/bin/env python3
"""
Prune orphaned VS Code workspace storage.

When you delete a project folder or a `.code-workspace` file, VS Code does NOT
clean up after itself. It leaves behind:

  * User/workspaceStorage/<hash>/            (state.vscdb, chat history, caches)
  * globalStorage/storage.json               (backupWorkspaces, profileAssociations,
                                              windowsState, windowSplashWorkspaceOverride)
  * Backups/<hash>/  and  Backups/workspaces.json   (hot-exit)

None of this is garbage-collected, so it accumulates indefinitely. This script
finds every workspace storage whose backing folder / workspace file no longer
exists and removes it, along with the matching global bookkeeping entries.

SAFETY
------
* VS Code MUST be fully quit before running (its storage service overwrites the
  DBs on exit). The script refuses to run while `code` is up unless --force.
* Nothing is hard-deleted. Everything removed is MOVED into a timestamped
  archive dir (~/.config/Code/.storage-cleanup-<ts>/) and the edited JSON files
  are snapshotted there first, so the whole operation is reversible: just move
  the dirs back and restore the snapshots.
* Only `file://` targets are considered. Remote URIs (vscode-remote://,
  vscode-userdata://, etc.) can't be verified locally and are ALWAYS preserved.
* Use --dry-run first to preview.

USAGE
-----
    python3 prune-orphan-workspaces.py --dry-run
    python3 prune-orphan-workspaces.py
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse

CODE_CONFIG = os.path.expanduser("~/.config/Code")
WS_STORAGE = os.path.join(CODE_CONFIG, "User", "workspaceStorage")
GLOBAL_JSON = os.path.join(CODE_CONFIG, "User", "globalStorage", "storage.json")
GLOBAL_DB = os.path.join(CODE_CONFIG, "User", "globalStorage", "state.vscdb")
BACKUPS = os.path.join(CODE_CONFIG, "Backups")
BACKUPS_JSON = os.path.join(BACKUPS, "workspaces.json")

# Storage dirs that are not per-workspace and must never be pruned.
SKIP_DIRS = {"ext-dev", "vscode-chat-images", "vscode-userdata"}


def code_is_running() -> bool:
    try:
        out = subprocess.run(
            ["pgrep", "-f", r"/usr/share/code/code|/opt/.*code|Code - Insiders|/usr/bin/code"],
            capture_output=True, text=True,
        )
        return bool(out.stdout.strip())
    except FileNotFoundError:
        return False


def uri_to_local_path(uri: str) -> str | None:
    """Return a local filesystem path for a file:// URI, else None (remote/other)."""
    if not isinstance(uri, str):
        return None
    if uri.startswith("file://"):
        return unquote(urlparse(uri).path)
    if uri.startswith("/"):
        return uri
    return None  # remote / non-file scheme -> never touch


def target_missing(uri: str) -> bool:
    """True only when this is a local file:// target that does not exist."""
    p = uri_to_local_path(uri)
    if p is None:
        return False  # remote or unknown -> treat as live, never prune
    return not os.path.exists(p)


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024
    return f"{n:.1f}GB"


def find_orphans() -> tuple[dict, list]:
    """Return (orphan_hash -> pointer_uri, skipped_remote_list)."""
    orphans: dict[str, str] = {}
    remote_skipped = []
    for wj in glob.glob(os.path.join(WS_STORAGE, "*", "workspace.json")):
        h = os.path.basename(os.path.dirname(wj))
        if h in SKIP_DIRS:
            continue
        try:
            d = json.load(open(wj))
        except (ValueError, OSError):
            continue
        ptr = d.get("workspace") or d.get("folder")
        if not ptr:
            continue
        if uri_to_local_path(ptr) is None:
            remote_skipped.append((h, ptr))
            continue
        if target_missing(ptr):
            orphans[h] = ptr
    return orphans, remote_skipped


def prune_global_json(orphan_hashes: set, dry: bool, report: list) -> dict | None:
    try:
        d = json.load(open(GLOBAL_JSON))
    except (ValueError, OSError):
        return None
    changed = False

    bw = d.get("backupWorkspaces")
    if isinstance(bw, dict):
        for sub in ("workspaces", "folders", "emptyWindows"):
            lst = bw.get(sub)
            if not isinstance(lst, list):
                continue
            new = []
            for e in lst:
                uri = (e or {}).get("configURIPath") or (e or {}).get("folderUri") or ""
                eid = (e or {}).get("id")
                if (eid in orphan_hashes) or (uri and target_missing(uri)):
                    report.append(f"backupWorkspaces.{sub}: {uri or eid}")
                    changed = True
                    continue
                new.append(e)
            bw[sub] = new

    pa = d.get("profileAssociations")
    if isinstance(pa, dict):
        for sub in ("workspaces", "emptyWindows"):
            m = pa.get(sub)
            if not isinstance(m, dict):
                continue
            for key in list(m.keys()):
                if target_missing(key):  # only file:// missing paths
                    report.append(f"profileAssociations.{sub}: {key}")
                    del m[key]
                    changed = True

    wso = d.get("windowSplashWorkspaceOverride")
    if isinstance(wso, dict):
        wmap = wso.get("workspaces")
        if isinstance(wmap, dict):
            for key in list(wmap.keys()):
                if key in orphan_hashes or target_missing(key):
                    report.append(f"windowSplashWorkspaceOverride: {key}")
                    del wmap[key]
                    changed = True

    ws = d.get("windowsState")
    if isinstance(ws, dict):
        def win_missing(w):
            if not isinstance(w, dict):
                return False
            wi = w.get("workspaceIdentifier") or {}
            uri = wi.get("configURIPath") or w.get("folder") or ""
            return bool(uri) and target_missing(uri)

        for key in ("lastActiveWindow", "lastPluginDevelopmentHostWindow"):
            if win_missing(ws.get(key)):
                report.append(f"windowsState.{key}")
                ws[key] = None
                changed = True
        ow = ws.get("openedWindows")
        if isinstance(ow, list):
            new = [w for w in ow if not win_missing(w)]
            if len(new) != len(ow):
                report.append(f"windowsState.openedWindows: dropped {len(ow) - len(new)}")
                ws["openedWindows"] = new
                changed = True

    return d if changed else None


def prune_backups_json(dry: bool, report: list) -> dict | None:
    if not os.path.exists(BACKUPS_JSON):
        return None
    try:
        d = json.load(open(BACKUPS_JSON))
    except (ValueError, OSError):
        return None
    changed = False
    for sub, uri_key in (
        ("rootURIWorkspaces", "configURIPath"),
        ("folderWorkspaceInfos", "folderUri"),
        ("emptyWorkspaceInfos", None),
    ):
        lst = d.get(sub)
        if not isinstance(lst, list):
            continue
        new = []
        for e in lst:
            uri = (e or {}).get(uri_key) if uri_key else None
            if uri and target_missing(uri):
                report.append(f"Backups/workspaces.json {sub}: {uri}")
                changed = True
                continue
            new.append(e)
        d[sub] = new
    return d if changed else None


def prune_recent_db(dry: bool, report: list) -> list:
    """Opportunistically prune a recently-opened MRU list if present."""
    edits = []
    if not os.path.exists(GLOBAL_DB):
        return edits
    try:
        conn = sqlite3.connect(GLOBAL_DB)
        rows = conn.execute(
            "SELECT key,value FROM ItemTable WHERE key LIKE '%recentlyOpened%'"
        ).fetchall()
    except sqlite3.Error:
        return edits
    finally:
        try:
            conn.close()
        except Exception:
            pass
    for key, val in rows:
        try:
            d = json.loads(val)
        except (ValueError, TypeError):
            continue
        entries = d.get("entries")
        if not isinstance(entries, list):
            continue
        new = []
        for e in entries:
            uri = (
                (e or {}).get("folderUri")
                or ((e or {}).get("workspace") or {}).get("configPath")
                or (e or {}).get("fileUri")
                or ""
            )
            if uri and target_missing(uri):
                report.append(f"recentlyOpened: {uri}")
                continue
            new.append(e)
        if len(new) != len(entries):
            d["entries"] = new
            edits.append((key, json.dumps(d)))
    return edits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Preview only.")
    ap.add_argument("--force", action="store_true", help="Run even if VS Code is up (unsafe).")
    args = ap.parse_args()

    if not args.dry_run and not args.force and code_is_running():
        print(
            "ERROR: VS Code appears to be running. Quit ALL VS Code windows first,\n"
            "       then re-run (or pass --force to override).",
            file=sys.stderr,
        )
        return 2

    orphans, remote_skipped = find_orphans()
    if not orphans:
        print("No orphaned workspace storage found. Nothing to do.")
        return 0

    reclaim = sum(dir_size(os.path.join(WS_STORAGE, h)) for h in orphans)
    print(f"Found {len(orphans)} orphaned workspace storage dir(s) "
          f"(~{human(reclaim)} reclaimable).")
    if remote_skipped:
        print(f"Preserving {len(remote_skipped)} remote workspace(s) (cannot verify).")

    greport: list = []
    breport: list = []
    orphan_hashes = set(orphans)

    if args.dry_run:
        for h, ptr in sorted(orphans.items()):
            print(f"  would remove workspaceStorage/{h}  -> {uri_to_local_path(ptr)}")
        prune_global_json(orphan_hashes, True, greport)
        prune_backups_json(True, breport)
        prune_recent_db(True, breport)
        print(f"\n  would prune {len(greport)} globalStorage entry(ies), "
              f"{len(breport)} backup/recent entry(ies).")
        print("Dry run only — nothing changed. Re-run without --dry-run to apply.")
        return 0

    # --- apply ---
    ts = time.strftime("%Y%m%d-%H%M%S")
    archive = os.path.join(CODE_CONFIG, f".storage-cleanup-{ts}")
    os.makedirs(os.path.join(archive, "workspaceStorage"), exist_ok=True)
    os.makedirs(os.path.join(archive, "Backups"), exist_ok=True)

    # Snapshot files we are about to edit (for reversibility).
    for src in (GLOBAL_JSON, GLOBAL_DB, BACKUPS_JSON):
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(archive, os.path.basename(src)))

    # Move orphaned storage + matching hot-exit backups into the archive.
    for h in orphan_hashes:
        src = os.path.join(WS_STORAGE, h)
        if os.path.isdir(src):
            shutil.move(src, os.path.join(archive, "workspaceStorage", h))
        bsrc = os.path.join(BACKUPS, h)
        if os.path.isdir(bsrc):
            shutil.move(bsrc, os.path.join(archive, "Backups", h))

    new_global = prune_global_json(orphan_hashes, False, greport)
    if new_global is not None:
        with open(GLOBAL_JSON, "w") as f:
            json.dump(new_global, f)

    new_backups = prune_backups_json(False, breport)
    if new_backups is not None:
        with open(BACKUPS_JSON, "w") as f:
            json.dump(new_backups, f)

    db_edits = prune_recent_db(False, breport)
    if db_edits:
        conn = sqlite3.connect(GLOBAL_DB)
        try:
            for key, val in db_edits:
                conn.execute("UPDATE ItemTable SET value=? WHERE key=?", (val, key))
            conn.commit()
        finally:
            conn.close()

    print(f"\nRemoved {len(orphan_hashes)} workspace storage dir(s), "
          f"{len(greport)} globalStorage entry(ies), {len(breport)} backup/recent entry(ies).")
    print(f"Everything was moved/snapshotted to:\n  {archive}")
    print("If anything looks wrong, restore from there. Once satisfied, delete it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
