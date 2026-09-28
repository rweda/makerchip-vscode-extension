/**
 * `vscode:uninstall` entry point. VS Code runs this as plain Node (no `vscode` API, no
 * extension host) when the extension is uninstalled, so it may only use Node built-ins.
 *
 * This is the fast path for removing our skill from `~/.claude/skills/`. It is best-effort:
 * VS Code does not run it when the extension folder is deleted by hand, and it is skipped in
 * some remote/portable setups. The durable mechanism is the prune-by-missing-path pass that
 * every surviving install runs on activation (see claudeSkill.ts). The one case only this
 * script can handle is uninstalling the LAST install, after which nothing of ours ever runs
 * again to notice.
 */

import * as path from 'path';
import { removeClaudeSkillOwner } from './claudeSkill';

// out/uninstall.js → the extension root, matching the `context.extensionPath` we registered.
const extensionPath = path.resolve(__dirname, '..');

removeClaudeSkillOwner(extensionPath)
  .then(result => console.log(`Makerchip: Claude skill cleanup: ${result.action}`))
  .catch(error => console.error(`Makerchip: Claude skill cleanup failed: ${error}`));
