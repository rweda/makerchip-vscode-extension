#!/usr/bin/env python3
"""
Scrub phantom "ghost" editor tabs out of VS Code's persisted editor layout.

Background
----------
An old version of the Extension Development Host launcher word-split an unquoted
command such as:

    code '/home/.../showdown.code-workspace' && '/tmp/tmp.XXXXXXXX'

into three argv entries. `code` treated each non-existent path as a brand-new
editor, creating three empty `untitledEditorInput` tabs whose "names" are shell
tokens (a quoted workspace path, `&&`, and a temp file). Those tabs then live in
VS Code's per-window editor memento and get re-seeded into every new Extension
Development Host window via window/editor restoration, so they reappear on every
launch. The launcher itself is now fixed, but the stale tabs still persist.

This script removes those ghost tabs from the saved state so they stop coming
back. It targets exactly:

    editor.id   == "workbench.editors.untitledEditorInput"
    resource    scheme == "file"
    resource    path does NOT exist on disk

That signature matches the ghosts precisely and never matches a real untitled
buffer (those use the "untitled" scheme) or a real open file (those exist on
disk).

Safety
------
- VS Code MUST be fully quit before running; otherwise it overwrites the DB on
  exit and your changes are lost. The script refuses to run while `code` is up.
- Every modified state.vscdb is backed up to  state.vscdb.ghostbak-<timestamp>.
- Use --dry-run first to preview what would be removed.

Usage
-----
    python3 scrub-ghost-editors.py --dry-run     # preview only
    python3 scrub-ghost-editors.py               # apply (VS Code must be closed)
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
WORKSPACE_STORAGE = os.path.join(CODE_CONFIG, "User", "workspaceStorage")
GLOBAL_STORAGE_JSON = os.path.join(CODE_CONFIG, "User", "globalStorage", "storage.json")
EDITOR_MEMENTO_KEY = "memento/workbench.parts.editor"
GHOST_INPUT_ID = "workbench.editors.untitledEditorInput"


def code_is_running() -> bool:
    try:
        out = subprocess.run(
            ["pgrep", "-f", "/usr/share/code/code|/opt/.*code|Code - Insiders|/usr/bin/code"],
            capture_output=True,
            text=True,
        )
        return bool(out.stdout.strip())
    except FileNotFoundError:
        # pgrep unavailable; be conservative and assume not running.
        return False


def path_exists(p: str) -> bool:
    try:
        return os.path.exists(p)
    except (OSError, ValueError):
        return False


def is_ghost_editor(editor: dict) -> bool:
    if editor.get("id") != GHOST_INPUT_ID:
        return False
    raw = editor.get("value")
    if not isinstance(raw, str):
        return False
    try:
        v = json.loads(raw)
    except (ValueError, TypeError):
        return False
    res = v.get("resourceJSON") or {}
    if res.get("scheme") != "file":
        return False
    path = res.get("path")
    if not isinstance(path, str) or not path:
        return False
    # Ghost = file-scheme untitled input whose backing file does not exist.
    return not path_exists(path)


def remap_index_list(indices, removed_set, old_to_new):
    """Map a list of old editor indices to new ones, dropping removed."""
    out = []
    for i in indices:
        if i in removed_set:
            continue
        out.append(old_to_new[i])
    return out


def scrub_group(group: dict, report: list) -> bool:
    """Remove ghost editors from one editor group dict. Returns True if changed."""
    editors = group.get("editors")
    if not isinstance(editors, list) or not editors:
        return False

    removed_idx = [i for i, e in enumerate(editors) if isinstance(e, dict) and is_ghost_editor(e)]
    if not removed_idx:
        return False

    removed_set = set(removed_idx)
    for i in removed_idx:
        try:
            val = json.loads(editors[i]["value"])
            report.append(val.get("resourceJSON", {}).get("path", "?"))
        except Exception:
            report.append("?")

    kept = [(i, e) for i, e in enumerate(editors) if i not in removed_set]
    old_to_new = {old: new for new, (old, _) in enumerate(kept)}
    group["editors"] = [e for _, e in kept]

    # Fix index-based references that VS Code stores in the group.
    if isinstance(group.get("mru"), list):
        group["mru"] = remap_index_list(group["mru"], removed_set, old_to_new)

    for key in ("active", "preview"):
        if key in group and isinstance(group[key], int):
            if group[key] in removed_set:
                # Point at the first remaining editor, or drop it.
                group[key] = 0 if group["editors"] else None
            else:
                group[key] = old_to_new[group[key]]

    if isinstance(group.get("sticky"), int):
        s = group["sticky"]
        group["sticky"] = -1 if s in removed_set else old_to_new.get(s, -1)

    return True


def walk_and_scrub(node, report) -> bool:
    changed = False
    if isinstance(node, dict):
        if isinstance(node.get("editors"), list):
            if scrub_group(node, report):
                changed = True
        for v in node.values():
            if walk_and_scrub(v, report):
                changed = True
    elif isinstance(node, list):
        for v in node:
            if walk_and_scrub(v, report):
                changed = True
    return changed


def scrub_text_resource_memento(value_json: str, report_paths: set) -> str | None:
    """Remove viewstate entries whose resource path is a known ghost path."""
    try:
        d = json.loads(value_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    changed = False
    for top_key in list(d.keys()):
        section = d[top_key]
        if not isinstance(section, dict):
            continue
        for res_key in list(section.keys()):
            # res_key is typically a URI like file:///path or a plain path.
            candidate = res_key
            if candidate.startswith("file://"):
                candidate = unquote(urlparse(candidate).path)
            if candidate in report_paths:
                del section[res_key]
                changed = True
    return json.dumps(d) if changed else None


def process_db(db_path: str, dry_run: bool) -> tuple[int, list]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "SELECT value FROM ItemTable WHERE key=?", (EDITOR_MEMENTO_KEY,)
        )
        row = cur.fetchone()
        if not row or not row[0]:
            return 0, []
        try:
            memento = json.loads(row[0])
        except (ValueError, TypeError):
            return 0, []

        report: list = []
        changed = walk_and_scrub(memento, report)
        if not changed:
            return 0, []

        ghost_paths = set(report)

        # Also scrub the per-editor view-state memento so no stale refs remain.
        new_text_value = None
        cur = conn.execute(
            "SELECT value FROM ItemTable WHERE key=?",
            ("memento/workbench.editors.textResourceEditor",),
        )
        trow = cur.fetchone()
        if trow and trow[0]:
            new_text_value = scrub_text_resource_memento(trow[0], ghost_paths)

        if dry_run:
            return len(report), report

        backup = f"{db_path}.ghostbak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(db_path, backup)

        conn.execute(
            "UPDATE ItemTable SET value=? WHERE key=?",
            (json.dumps(memento), EDITOR_MEMENTO_KEY),
        )
        if new_text_value is not None:
            conn.execute(
                "UPDATE ItemTable SET value=? WHERE key=?",
                (new_text_value, "memento/workbench.editors.textResourceEditor"),
            )
        conn.commit()
        return len(report), report
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Preview only; make no changes.")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Run even if a running VS Code process is detected (unsafe).",
    )
    args = ap.parse_args()

    if not args.dry_run and not args.force and code_is_running():
        print(
            "ERROR: VS Code appears to be running. Quit ALL VS Code windows first\n"
            "       (its storage service will otherwise overwrite these edits on exit).\n"
            "       Re-run once it is closed, or pass --force to override.",
            file=sys.stderr,
        )
        return 2

    dbs = sorted(glob.glob(os.path.join(WORKSPACE_STORAGE, "*", "state.vscdb")))
    total = 0
    touched = 0
    for db in dbs:
        try:
            n, report = process_db(db, args.dry_run)
        except sqlite3.OperationalError as e:
            print(f"  skip (locked/busy): {db}  [{e}]")
            continue
        if n:
            touched += 1
            total += n
            wsid = os.path.basename(os.path.dirname(db))
            verb = "would remove" if args.dry_run else "removed"
            print(f"[{wsid}] {verb} {n} ghost tab(s):")
            for p in report:
                print(f"    - {p}")

    print()
    action = "Would remove" if args.dry_run else "Removed"
    print(f"{action} {total} ghost tab(s) across {touched} workspace storage(s).")
    if args.dry_run:
        print("Dry run only — nothing was changed. Re-run without --dry-run to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
