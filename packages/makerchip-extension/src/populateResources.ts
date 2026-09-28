/*
 * For populating resources and skill(s) in ~/.vscode-makerchip/resources/.
 * This directory may be added to a workspace (by the Makerchip extension) as available RAG data for AI coding assistants.
 * Also creates ~/.vscode-makerchip/compile-cache/ for compilation results.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import * as os from 'os';
import { INTRO_TEMPLATE } from './claudeSkill';

// Directory structure
export const MAKERCHIP_DIR = path.join(os.homedir(), '.vscode-makerchip');

/**
 * Every entry the extension manages directly under MAKERCHIP_DIR, and the single source of truth
 * for the top-level sweep in cleanupMakerchipDir: anything listed here is ours, anything else is
 * foreign and gets offered to the user for removal.
 *
 * Any code that writes an entry at this level MUST take its name from here rather than repeating
 * a literal. `compile-history.json` is the cautionary case — compileCache.ts built it as
 * `path.join(path.dirname(CACHE_DIR), 'compile-history.json')`, so it is invisible to a search
 * for MAKERCHIP_DIR and a hand-written allowlist silently omitted it. A sweep that omits an entry
 * offers to delete the user's data.
 */
export const MANAGED_ENTRIES = {
  resources: 'resources',
  compileCache: 'compile-cache',
  compileHistory: 'compile-history.json',
  tmp: 'tmp',
  readme: 'README.md',
  github: '.github',
  vscode: '.vscode',
} as const;

/**
 * Windows and macOS default to case-insensitive filesystems, so `README.MD` and `README.md` are
 * the SAME entry there and a case-sensitive lookup would misclassify one of our own files as
 * foreign — and then offer to delete it. On Linux they are genuinely different entries, so
 * folding case would be wrong: a real stray named `Resources` would be mistaken for ours.
 * Hence the comparison follows the platform rather than picking one behaviour globally.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** Key an entry name for comparison against our managed/deprecated/expected lists. */
function entryKey(name: string): string {
  return CASE_INSENSITIVE_FS ? name.toLowerCase() : name;
}

const MANAGED_SET: ReadonlySet<string> = new Set(Object.values(MANAGED_ENTRIES).map(entryKey));

/**
 * Entries earlier extension versions created here and no longer do. Removed silently: the user
 * never chose to put them here, so prompting about our own leftovers would just be confusing.
 */
const DEPRECATED_ARTIFACTS: ReadonlySet<string> = new Set([
  'CLAUDE.md',                 // Superseded by the Claude skill in ~/.claude/skills/ (claudeSkill.ts).
  // Note the leading dot: this is the old DESTINATION name at the folder root, which no tool
  // auto-loaded. Unrelated to the bundled template, now resources/copilot-instructions.md.
  '.copilot-instructions.md',
].map(entryKey));

/**
 * Absolute paths of stray entries the user chose to keep, so we do not re-ask on every update.
 * Absolute rather than bare names, because the sweeps cover more than one directory.
 */
const KEPT_FOREIGN_KEY = 'makerchip.keptForeignEntries';

export const RESOURCES_DIR = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.resources);
export const CACHE_DIR = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.compileCache);
export const HISTORY_FILE = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.compileHistory);
export const TMP_DIR = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.tmp);
export const RESOURCES_VERSION = '2.1.0';

interface Repository {
  name: string;
  url: string;
}

const REPOSITORIES: Repository[] = [
  // https, not git@: SSH needs a configured key and agent, which many users (especially on
  // Windows) do not have.
  { name: 'Makerchip-public', url: 'https://github.com/rweda/Makerchip-public.git' },
  { name: 'makerchip_examples', url: 'https://github.com/stevehoover/makerchip_examples.git' },
  { name: 'LF-Building-a-RISC-V-CPU-Core-Course', url: 'https://github.com/stevehoover/LF-Building-a-RISC-V-CPU-Core-Course.git' },
  { name: 'warp-v', url: 'https://github.com/stevehoover/warp-v.git' },
  { name: 'warp-v_includes', url: 'https://github.com/stevehoover/warp-v_includes.git' },
  { name: 'tlv_lib', url: 'https://github.com/TL-X-org/tlv_lib.git' },
  { name: 'tlv_flow_lib', url: 'https://github.com/TL-X-org/tlv_flow_lib.git' },
  { name: 'Virtual-FPGA-Lab', url: 'https://github.com/os-fpga/Virtual-FPGA-Lab.git'},
  { name: 'M5', url: 'https://github.com/rweda/M5.git' },
  { name: 'LLM_TLV', url: 'https://github.com/stevehoover/LLM_TLV' },
];

const EXPECTED_RESOURCES = [
  '.version.json',
  'minimal.tlv',  // Bundled scratch design (copied below); not a repo, but expected here.
];

interface PopulateResult {
  success: number;
  total: number;
  failed: string[];
  localChanges: string[];
  /** Absolute paths of entries blocking a clone that we declined to delete. */
  strays: string[];
}

/**
 * Populate/update Makerchip reference data.
 */
export async function populateResources(context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel): Promise<PopulateResult> {
  const log = (message: string) => {
    if (outputChannel) {
      outputChannel.appendLine(message);
    }
    console.log(message);
  };

  log('=========================================');
  log('Makerchip Reference Data Setup');
  log(`Target: ${MAKERCHIP_DIR}`);
  log('=========================================');
  log('');

  // MAKERCHIP_DIR is left write-protected between runs (see lockMakerchipDir), so unlock it
  // before anything creates, removes or renames an entry at this level. This must precede
  // stageTmpForDeletion in particular: rename() needs write permission on BOTH parents, and it
  // renames tmp/ out of here.
  await unlockMakerchipDir();

  // Move tmp directory contents to /tmp for cleanup before updating
  await stageTmpForDeletion(log);

  // Create directory structure
  await fs.mkdir(RESOURCES_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  // Clean up unexpected resources. Anything it will not delete outright is collected and
  // offered to the user once, at the end, together with strays found by the other sweeps.
  const strays: string[] = await cleanupUnexpectedResources(log);

  // Clone or update repositories
  const result = await updateRepositories(log);
  strays.push(...result.strays);

  // Copy READMEs
  await copyResourceFile(context, 'README.md', MAKERCHIP_DIR, log);
  await copyResourceFile(context, 'compile-cache-README.md', CACHE_DIR, log);
  await copyResourceFile(context, 'tmp-README.md', TMP_DIR, log);

  // Copilot instruction file, installed at the path Copilot actually auto-loads
  // (<workspace folder>/.github/copilot-instructions.md). Claude is served separately, by the
  // skill installed into the user's ~/.claude/skills/ (see claudeSkill.ts).
  await installCopilotInstructions(context, log);

  // Copy the minimal scratch design used to open panels without creating clutter.
  await copyResourceFile(context, 'minimal.tlv', RESOURCES_DIR, log);

  // Create version metadata
  await createVersionMetadata();

  // Mark reference data read-only to prevent accidental edits (repos are now clean)
  await makeResourcesReadOnly(log);

  // Install skill
  await installSkill(context, log);

  // Restrict the top level to content we manage: silently drop our own obsolete artifacts
  // and collect anything foreign (strays) that will be offered to the user for deletion.
  // Runs last so the entries created above are already in place.
  strays.push(...await cleanupMakerchipDir(log));

  // compile-history.json is created lazily by compileCache on the first compile, with a plain
  // writeFile. Updating an existing file needs write permission on the FILE, which it keeps — but
  // creating one needs write permission on the DIRECTORY, which we are about to remove. So make
  // sure it exists first, or a user who has never compiled would hit EACCES on their first one.
  await ensureHistoryFile(log);

  // Lock the top level LAST: every step above creates or removes entries at this level.
  await lockMakerchipDir(log);

  // One grouped prompt for everything no sweep was willing to delete on its own authority.
  // Runs after the lock and re-opens it around its own deletions (see offerToTrash).
  offerToTrash(context, strays, log);

  // Summary
  log('=========================================');
  log('✓ Setup Complete');
  log('=========================================');
  log('');
  log(`Location: ${MAKERCHIP_DIR}`);
  log(`  Resources: ${RESOURCES_DIR}`);
  log(`  Cache: ${CACHE_DIR}`);
  log(`  Tmp: ${TMP_DIR}`);
  log(`Repositories: ${result.success}/${result.total} updated successfully`);
  log('');

  if (result.failed.length > 0) {
    log('⚠️  Failed repositories:');
    result.failed.forEach(repo => log(`  - ${repo}`));
    log('');
  }

  // Show persistent warnings for repositories with local changes
  if (result.localChanges.length > 0) {
    const message = result.localChanges.length === 1
      ? `Repository has local changes and was not updated: ${result.localChanges[0]}. Commit or stash your changes to allow updates.`
      : `${result.localChanges.length} repositories have local changes and were not updated. Example: ${result.localChanges[0]}. Commit or stash your changes to allow updates.`;

    vscode.window.showWarningMessage(
      message,
      { modal: false },
      'Open Folder'
    ).then(selection => {
      if (selection === 'Open Folder') {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.localChanges[0]));
      }
    });
  }

  // Show manual retry instructions if there were network failures
  const networkFailures = result.failed.filter(f => !f.includes('local changes'));
  if (networkFailures.length > 0) {
    log('To manually retry failed updates, run:');
    log('  Command Palette → "Makerchip: Update Reference Data"');
    log('');
  }

  return result;
}

/**
 * Move tmp directory to /tmp for cleanup before updates
 */
async function stageTmpForDeletion(log: (message: string) => void): Promise<void> {
  try {
    const tmpStat = await fs.stat(TMP_DIR);
    if (!tmpStat.isDirectory()) {
      return;
    }

    // Check if tmp directory has any contents
    const tmpContents = await fs.readdir(TMP_DIR);
    if (tmpContents.length === 0) {
      return;
    }

    // Create staging directory with timestamp for uniqueness
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
    const stagingDir = path.join(os.tmpdir(), `vscode-makerchip-${timestamp}`);

    log(`🗑️  Staging tmp directory for deletion: ${stagingDir}...`);

    // Move entire directory to the OS temp area. rename() cannot cross filesystems, and the temp
    // area very often is one: a tmpfs /tmp (common in containers and on several distros), or a
    // different volume from the user profile on Windows. Both surface as EXDEV, so fall back to
    // deleting in place — the goal is only to empty tmp/, not to preserve its contents.
    try {
      await fs.rename(TMP_DIR, stagingDir);
      log('  ✓ Tmp directory moved aside (will be deleted on reboot)');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      await fs.rm(TMP_DIR, { recursive: true, force: true });
      log('  ✓ Tmp directory deleted in place (temp area is on another filesystem)');
    }
    log('');
  } catch (error) {
    // Tmp directory doesn't exist or other error, which is fine
    if ((error as any).code !== 'ENOENT') {
      log(`  Warning: Failed to stage tmp directory: ${error}`);
      log('');
    }
  }
}

/**
 * Clean up unexpected entries at the top level of RESOURCES_DIR.
 *
 * The name list (repos + EXPECTED_RESOURCES) decides what is *unexpected*; isDisposableClone
 * decides what is *safe to delete*. Those are different questions and both are needed: a clone
 * dropped from REPOSITORIES is unexpected yet disposable, while an agent's scratch directory is
 * unexpected and must not be destroyed silently. Disposable entries are removed as before;
 * everything else is returned for the caller to offer to the user.
 *
 * @returns absolute paths of entries left in place for the user to decide about.
 */
async function cleanupUnexpectedResources(log: (message: string) => void): Promise<string[]> {
  log('🧹 Cleaning up unexpected resources...');

  const repoNames = REPOSITORIES.map(r => r.name);
  const validResources = new Set([...repoNames, ...EXPECTED_RESOURCES].map(entryKey));

  let removedCount = 0;
  const strays: string[] = [];

  try {
    const resources = await fs.readdir(RESOURCES_DIR);

    for (const resource of resources) {
      if (validResources.has(entryKey(resource))) {
        continue;
      }
      const resourcePath = path.join(RESOURCES_DIR, resource);
      // Per-entry isolation: a delete can fail on content owned by another user (a root-owned
      // tree left by a container writing into the home directory, say). Without this, one
      // EACCES would abort the whole sweep and the remaining entries would go unexamined.
      try {
        if (await isDisposableClone(resourcePath)) {
          log(`  Removing: ${resource} (clean, fully-pushed clone — re-obtainable)`);
          // Locked by the previous run's makeResourcesReadOnly; recursive delete needs write
          // permission on each directory it unlinks from.
          await makeTreeWritable(resourcePath);
          await fs.rm(resourcePath, { recursive: true, force: true });
          removedCount++;
        } else {
          log(`  Keeping for now: ${resource} (not a disposable clone)`);
          strays.push(resourcePath);
        }
      } catch (error) {
        log(`  Warning: Could not process ${resource}, leaving it in place: ${error}`);
        strays.push(resourcePath);
      }
    }

    if (removedCount === 0 && strays.length === 0) {
      log('  ✓ No unexpected resources found');
    }
  } catch (error) {
    log(`  Warning: Failed to cleanup: ${error}`);
  }

  log('');
  return strays;
}

/** Run git in `cwd` and resolve its exit code and stdout. Never rejects. */
function git(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let output = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => resolve({ code, output: output.trim() }));
    proc.on('error', () => resolve({ code: null, output: '' }));
  });
}

/**
 * Check if a git repository has uncommitted changes, including untracked files (which is what
 * catches a stray file an agent dropped inside a clone). Does NOT consider unpushed commits —
 * see hasUnpushedCommits.
 */
async function hasLocalChanges(repoPath: string): Promise<boolean> {
  const { code, output } = await git(['status', '--porcelain'], repoPath);
  return code === 0 && output.length > 0;
}

/**
 * Check whether HEAD has commits its upstream does not. Returns true when that cannot be
 * determined (no upstream, detached HEAD, git failure): the caller uses this to decide whether
 * deleting a clone is lossless, so "unknown" must mean "assume it would lose something".
 */
async function hasUnpushedCommits(repoPath: string): Promise<boolean> {
  const { code, output } = await git(['log', '@{u}..HEAD', '--oneline'], repoPath);
  return code !== 0 || output.length > 0;
}

/**
 * Can this directory be deleted without losing anything the user cannot get back?
 *
 * True only for a git clone that is clean AND fully pushed — such a directory is re-obtainable
 * from its remote, so removing it silently costs nothing. This is evidence rather than a name
 * list on purpose: a clone whose name we no longer recognise (a repo dropped or renamed in
 * REPOSITORIES) is still disposable, while a clone carrying the user's own work is not, and no
 * hand-maintained list can tell those apart. Anything that is not a clean, pushed clone is
 * treated as potentially valuable and offered to the user instead.
 *
 * CONTENT OWNED BY ANOTHER USER fails closed here, which is the behaviour we want. When git
 * cannot read a repository — an unreadable `.git`, or git refusing with "detected dubious
 * ownership" on a root-owned tree — both probes exit non-zero. hasLocalChanges then reports
 * false, but hasUnpushedCommits reports TRUE (it treats "cannot determine" as "would lose
 * something"), so this returns false and the entry becomes a stray for the user to decide about.
 * Verified 2026-09-23 with an unreadable `.git`: both probes exit 128. Do not "fix"
 * hasUnpushedCommits to return false on error — that would make root-owned trees silently
 * deletable.
 */
async function isDisposableClone(entryPath: string): Promise<boolean> {
  if (!(await isGitRepo(entryPath))) {
    return false;
  }
  if (await hasLocalChanges(entryPath)) {
    return false;
  }
  return !(await hasUnpushedCommits(entryPath));
}

/**
 * Clone or update a git repository
 */
async function gitOperation(repoPath: string, repoUrl: string, isUpdate: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = isUpdate
      ? ['pull', '--ff-only', '--quiet']
      : ['clone', '--depth', '1', '--quiet', repoUrl, repoPath];

    const cwd = isUpdate ? repoPath : undefined;

    const proc = spawn('git', args, { cwd, stdio: 'pipe' });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Mark all reference-data files under RESOURCES_DIR read-only to prevent accidental
 * edits. Run once as an isolated pass after all repositories are cloned/updated.
 *
 * Only the write bits are cleared; the executable bit is preserved, so git's view of each tree is
 * unchanged (git tracks the exec bit, not the read/write bits) and `git status` stays clean.
 *
 * DIRECTORIES are locked too, which is the part that actually protects anything: on POSIX,
 * creating or deleting an entry is governed by write permission on the containing DIRECTORY, not
 * on the files. With files-only locking (what this did previously) an agent could still create
 * new files inside a clone — and no sweep caught it either, since cleanupUnexpectedResources only
 * scans the top level of RESOURCES_DIR. Locking directories closes that hole.
 *
 * The cost is that git can no longer update a locked tree (it replaces tracked files by unlinking
 * and recreating them). Previously directories were left writable for exactly that reason; now
 * updateRepositories calls makeTreeWritable on the one repo it is about to touch, so the writable
 * window is one repo wide instead of permanent. `.git` is still skipped, and `.version.json` is
 * skipped because it is rewritten on every run.
 *
 * Note this is a guardrail against mistakes, not a security boundary — same-user code can chmod
 * it back — and it is POSIX-only: Node's chmod cannot write-protect a directory on Windows, so
 * there the sweeps in cleanupUnexpectedResources/cleanupMakerchipDir remain the only mechanism.
 */
async function makeResourcesReadOnly(log: (message: string) => void): Promise<void> {
  log('🔒 Marking reference data read-only...');

  // Entries we could not lock. Almost always means another user owns them (only the owner or
  // root may chmod), so the guardrail does not cover them and the user should know.
  const unprotected: string[] = [];

  // Post-order: clear a directory's write bit only after its children are done. Clearing it
  // earlier would not block chmod on the children (that needs ownership, not parent write), but
  // post-order keeps the traversal obviously correct if this ever grows unlink/rename steps.
  const lock = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;  // Left writable; see makeTreeWritable for how git updates are handled.
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await lock(fullPath);
      }
      if (entry.isDirectory() || entry.isFile()) {
        if (!(await clearWriteBits(fullPath))) {
          unprotected.push(fullPath);
        }
      }
    }
  };

  try {
    // Lock repo trees only. RESOURCES_DIR itself stays writable so cleanupUnexpectedResources can
    // still remove disposable clones, and `.version.json` is rewritten every run.
    const entries = await fs.readdir(RESOURCES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git') {
        await lock(path.join(RESOURCES_DIR, entry.name));
      }
    }
    log('  ✓ Reference data is read-only (files and directories)');
    if (unprotected.length > 0) {
      log(`  ⚠ ${unprotected.length} entr${unprotected.length === 1 ? 'y' : 'ies'} could not be ` +
          'write-protected (owned by another user?); they remain writable:');
      unprotected.slice(0, 10).forEach(entry => log(`      ${entry}`));
      if (unprotected.length > 10) {
        log(`      ... and ${unprotected.length - 10} more`);
      }
    }
  } catch (error) {
    log(`  Warning: Failed to set read-only permissions: ${error}`);
  }

  log('');
}

/**
 * Drop all write bits from one entry. Returns false if that could not be done — a file removed
 * mid-walk, or an entry owned by another user, where chmod fails with EPERM because only the
 * owner (or root) may change a mode. The caller reports those rather than swallowing them:
 * silently failing to protect something looks identical to protecting it.
 */
async function clearWriteBits(target: string): Promise<boolean> {
  try {
    const { mode } = await fs.stat(target);
    await fs.chmod(target, mode & ~0o222);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make MAKERCHIP_DIR itself writable, so entries can be created, removed or renamed at its top
 * level. Only the directory's own mode changes; nothing inside it is touched.
 */
async function unlockMakerchipDir(): Promise<void> {
  try {
    const { mode } = await fs.stat(MAKERCHIP_DIR);
    await fs.chmod(MAKERCHIP_DIR, mode | 0o200);
  } catch {
    // Absent on a first run (created writable below), or owned by someone else — in which case
    // we cannot lock it either, so there is nothing to undo.
  }
}

/**
 * Write-protect MAKERCHIP_DIR ITSELF — not its contents — so nothing can create or delete an
 * entry at its top level. This is what stops an agent dropping a file into the managed directory,
 * since on POSIX the containing directory's write bit governs creating and unlinking entries.
 *
 * Deliberately NOT recursive. `tmp/` and `compile-cache/` keep their own modes and stay fully
 * writable inside, because a parent's write bit says nothing about a subdirectory's contents.
 * Files already at the top level (README.md, compile-history.json) also keep their modes, so
 * rewriting them in place continues to work — only creating and removing is blocked.
 *
 * POSIX only: Node's chmod cannot write-protect a directory on Windows, so there the sweeps in
 * cleanupMakerchipDir remain the only mechanism. Same-user code can chmod this back, so it is a
 * guardrail against mistakes, not a security boundary.
 */
async function lockMakerchipDir(log: (message: string) => void): Promise<void> {
  if (await clearWriteBits(MAKERCHIP_DIR)) {
    log(`🔒 ${MAKERCHIP_DIR} is write-protected (tmp/ and compile-cache/ remain writable)`);
  } else {
    log(`  ⚠ Could not write-protect ${MAKERCHIP_DIR} (owned by another user?)`);
  }
  log('');
}

/**
 * Create compile-history.json if absent, so compileCache never has to create it in a locked
 * directory. The default shape mirrors compileCache's own fallback for an unreadable history
 * (`{ version: '1.0.0', compilations: [] }`) — that fallback is the source of truth; keep these
 * in step. An empty file would also be tolerated, since every read path catches parse failures,
 * but writing the real default avoids a guaranteed parse failure on the first compile.
 */
async function ensureHistoryFile(log: (message: string) => void): Promise<void> {
  try {
    await fs.access(HISTORY_FILE);
    return;
  } catch {
    // Missing: create it below.
  }
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify({ version: '1.0.0', compilations: [] }, null, 2) + '\n', 'utf-8');
    log(`  ✓ Created ${MANAGED_ENTRIES.compileHistory}`);
  } catch (error) {
    log(`  Warning: Failed to create ${MANAGED_ENTRIES.compileHistory}: ${error}`);
  }
}

/**
 * Restore owner write permission across a tree — the inverse of makeResourcesReadOnly.
 *
 * Required because locking DIRECTORIES (not just files) is what actually prevents an agent from
 * creating stray files inside a clone, but it also stops git from updating: git replaces tracked
 * files by unlinking and recreating them, which needs write permission on the containing
 * directory. Earlier versions left directories writable precisely so git would keep working; we
 * now lock them and unlock the specific repo around each git operation instead, so the writable
 * window is one repo wide rather than permanent.
 *
 * Restores owner write only (0o200). Group write from the original umask is not restored, which
 * is fine for a single-user data directory and is all git needs.
 */
async function makeTreeWritable(root: string): Promise<void> {
  // Pre-order: a directory must be writable/searchable before its children can be reached.
  try {
    const { mode } = await fs.stat(root);
    await fs.chmod(root, mode | 0o200);
  } catch {
    return;  // Missing or inaccessible: nothing to unlock.
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeTreeWritable(fullPath);
    } else if (entry.isFile()) {
      try {
        const { mode } = await fs.stat(fullPath);
        await fs.chmod(fullPath, mode | 0o200);
      } catch {
        // Ignore individual failures.
      }
    }
  }
}

/**
 * Check if a directory is a git repository
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitDir = path.join(dirPath, '.git');
    const stat = await fs.stat(gitDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Update all repositories
 */
async function updateRepositories(log: (message: string) => void): Promise<PopulateResult> {
  log('📦 Cloning/updating repositories...');

  let successCount = 0;
  const failed: string[] = [];
  const localChanges: string[] = [];
  const strays: string[] = [];

  for (const repo of REPOSITORIES) {
    const repoPath = path.join(RESOURCES_DIR, repo.name);
    const isRepo = await isGitRepo(repoPath);

    if (isRepo) {
      // Update existing repository
      log(`  ⟳ Updating: ${repo.name}`);

      // Check for local changes before attempting update
      const hasChanges = await hasLocalChanges(repoPath);

      if (hasChanges) {
        log('    ⚠ Skipping update - resource repository has local changes');
        log('    Resource repositories should not be edited manually.');
        log(`    Path: ${repoPath}`);
        log('    Be sure these changes are captured elsewhere, remove the clone, and');
        log('    update using Ctrl+Shift+P → "Makerchip: Update Reference Data"');
        failed.push(`${repo.name} (local changes)`);
        localChanges.push(repoPath);
        continue;
      }

      // The tree is read-only from the previous run (makeResourcesReadOnly locks directories as
      // well as files), so unlock just this repo for the update. makeResourcesReadOnly re-locks
      // everything at the end of populateResources.
      await makeTreeWritable(repoPath);

      const success = await gitOperation(repoPath, repo.url, true);

      if (success) {
        log('    ✓ Updated successfully');
        successCount++;
      } else {
        log('    ⚠ Update failed - likely network issue');
        log(`    Path: ${repoPath}`);
        log('    The repository will use cached data until next update.');
        log('    To retry: Ctrl+Shift+P → "Makerchip: Update Reference Data"');
        failed.push(`${repo.name} (update failed)`);
      }
    } else {
      // Clone new repository
      log(`  ⬇ Cloning: ${repo.name}`);

      // Something already occupies the clone path. It is not a usable clone (we are in the
      // else branch of isGitRepo), but it may still be the user's or an agent's work, so only
      // remove it when that is provably lossless. Otherwise leave it, skip this repo, and let
      // the caller ask — destroying data to make room for a re-clonable repo is a bad trade.
      let blocked = false;
      try {
        const stat = await fs.stat(repoPath);
        if (stat.isDirectory() || stat.isFile()) {
          if (await isDisposableClone(repoPath)) {
            log('    ! Removing existing clone (clean, fully pushed)');
            // Recursive delete unlinks entries from every directory it walks, which needs write
            // permission on those directories — so undo the read-only pass first.
            await makeTreeWritable(repoPath);
            await fs.rm(repoPath, { recursive: true, force: true });
          } else {
            log('    ⚠ Skipping clone - path is occupied by something we will not delete');
            log(`    Path: ${repoPath}`);
            failed.push(`${repo.name} (path occupied)`);
            strays.push(repoPath);
            blocked = true;
          }
        }
      } catch {
        // Path doesn't exist, which is fine
      }

      if (blocked) {
        continue;
      }

      const success = await gitOperation(repoPath, repo.url, false);

      if (success) {
        log('    ✓ Cloned successfully');
        successCount++;
      } else {
        log('    ✗ Clone failed');
        failed.push(`${repo.name} (clone)`);
      }
    }
  }

  log('');

  return {
    success: successCount,
    total: REPOSITORIES.length,
    failed,
    localChanges,
    strays,
  };
}

/**
 * Copy a file from extension resources to a target directory.
 * (Used for the workspace READMEs and the `minimal.tlv` scratch design.)
 */
async function copyResourceFile(
  context: vscode.ExtensionContext,
  sourceFilename: string,
  targetDir: string,
  log: (message: string) => void
): Promise<void> {
  const templatePath = path.join(context.extensionPath, 'resources', sourceFilename);
  // Map specific source files to their target names
  const targetFilename = sourceFilename === 'compile-cache-README.md' || sourceFilename === 'tmp-README.md'
    ? 'README.md'
    : sourceFilename;
  const targetPath = path.join(targetDir, targetFilename);

  try {
    await fs.copyFile(templatePath, targetPath);
  } catch (error) {
    log(`  Warning: Failed to copy file to ${targetPath}: ${error}`);
  }
}

/**
 * Create version metadata
 */
async function createVersionMetadata(): Promise<void> {
  const metadata = {
    updated: new Date().toISOString(),
    repositories: REPOSITORIES.map(r => r.name),
    script_version: RESOURCES_VERSION,
  };

  const versionPath = path.join(RESOURCES_DIR, '.version.json');
  await fs.writeFile(versionPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Copy a directory recursively
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install Copilot skills
 */
async function installSkill(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  log('Installing Copilot skills...');

  // Install to .vscode-makerchip/.vscode/skills/ directory for workspace recognition
  const targetSkillsDir = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.vscode, 'skills');
  const sourceSkillsDir = path.join(context.extensionPath, 'resources', 'skills');

  // Remove existing skills directory to ensure clean state
  try {
    await fs.rm(targetSkillsDir, { recursive: true, force: true });
  } catch {
    // Directory might not exist, which is fine
  }

  // Create target directory
  await fs.mkdir(targetSkillsDir, { recursive: true });

  try {
    // Copy all static skills from resources/skills/
    await copyDirectory(sourceSkillsDir, targetSkillsDir);

    // Generate makerchip-api-features.md
    await generateApiFeaturesSkill(targetSkillsDir, log);

    // List installed skills
    const installedSkills = await fs.readdir(targetSkillsDir);
    log('Skills installed successfully:');
    for (const skillFile of installedSkills) {
      log(`  ✓ ${skillFile}`);
    }
  } catch (error) {
    log(`  Warning: Failed to install skills: ${error}`);
  }

  log('');
}

/**
 * Generate makerchip-api-features.md from Makerchip-public docs
 */
async function generateApiFeaturesSkill(targetDir: string, log: (message: string) => void): Promise<void> {
  // Path to built docs in Makerchip-public repository
  const apiDocsPath = path.join(RESOURCES_DIR, 'Makerchip-public', 'docs', 'plugin_api', 'Plugin_API.md');

  try {
    // Read source content
    const sourceContent = await fs.readFile(apiDocsPath, 'utf-8');

    // YAML frontmatter for the skill
    const frontmatter = `---
description: Data structures for Makerchip IDE layout state and third-party panes
applyTo:
  - pattern: "**/*"
    triggerWords:
      - makerchip
      - layout
      - third-party pane
      - pane
      - state
---

`;

    // Combine frontmatter with source content
    const skillContent = frontmatter + sourceContent;

    // Write to target
    const targetPath = path.join(targetDir, 'makerchip-api-features.md');
    await fs.writeFile(targetPath, skillContent, 'utf-8');

    log('  Generated makerchip-api-features.md from Makerchip-public docs');
  } catch (error) {
    log(`  Warning: Could not generate makerchip-api-features.md: ${error}`);
    log('  (Makerchip-public repository may not be available or docs may not be built)');
  }
}

/**
 * Install the Copilot instruction file at the path Copilot actually auto-loads:
 * `<workspace folder>/.github/copilot-instructions.md`. The Makerchip data folder is added
 * as a workspace folder, so Copilot picks it up. Earlier versions wrote it to the folder root
 * (`.copilot-instructions.md`), which no tool auto-loads; that stale copy is listed in
 * DEPRECATED_ARTIFACTS and removed by cleanupMakerchipDir.
 */
async function installCopilotInstructions(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  const templatePath = path.join(context.extensionPath, 'resources', INTRO_TEMPLATE);
  const githubDir = path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.github);
  const targetPath = path.join(githubDir, 'copilot-instructions.md');

  try {
    await fs.mkdir(githubDir, { recursive: true });
    await fs.copyFile(templatePath, targetPath);
    log('  ✓ Installed .github/copilot-instructions.md');
  } catch (error) {
    log(`  Warning: Failed to install copilot-instructions.md: ${error}`);
  }
}

/**
 * Keep the top level of MAKERCHIP_DIR to exactly what the extension manages. Two classes of
 * stray entry, deliberately handled differently:
 *
 *  - DEPRECATED_ARTIFACTS -- files we created in an earlier version. Removed silently, because the
 *    user never put them there and asking about our own leftovers is noise.
 *  - Anything else -- foreign, most likely dropped by an agent or the user. Returned to the caller,
 *    which routes it through offerToTrash. This mirrors cleanupUnexpectedResources: each sweep
 *    silently removes only what it can prove is ours or re-obtainable, and defers everything else
 *    to a single prompt.
 *
 * @returns absolute paths of entries left in place for the user to decide about.
 *
 * `tmp/` is managed but its CONTENTS are the user's scratch space, so this never looks inside it.
 * Neither does it recurse into `.github/` or `.vscode/`. A stray file inside a cloned repo is
 * already surfaced by hasLocalChanges (`git status --porcelain` reports untracked files), which
 * skips the update and warns.
 */
async function cleanupMakerchipDir(log: (message: string) => void): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(MAKERCHIP_DIR);
  } catch (error) {
    log(`  Warning: Failed to scan ${MAKERCHIP_DIR}: ${error}`);
    return [];
  }

  const strays: string[] = [];

  for (const entry of entries) {
    if (MANAGED_SET.has(entryKey(entry))) {
      continue;
    }
    const entryPath = path.join(MAKERCHIP_DIR, entry);
    if (DEPRECATED_ARTIFACTS.has(entryKey(entry))) {
      try {
        await fs.rm(entryPath, { recursive: true, force: true });
        log(`  \u2713 Removed obsolete ${entry} (left by an earlier extension version)`);
      } catch (error) {
        log(`  Warning: Failed to remove obsolete ${entry}: ${error}`);
      }
      continue;
    }
    log(`  Unexpected entry: ${entry}`);
    strays.push(entryPath);
  }

  return strays;
}

/**
 * Offer to move stray entries to the trash, in one grouped prompt, and remember a decline so the
 * user is not re-asked on every update. Shared by every sweep so they cannot diverge in how they
 * treat the user's data.
 *
 * Trash rather than delete: these paths reached this point precisely because we could NOT prove
 * removing them is lossless, so the operation has to be reversible. If the platform has no trash
 * we report it and stop, rather than escalating to a hard delete the user did not agree to.
 *
 * Fire-and-forget by design -- resource population must not block on a dialog.
 */
function offerToTrash(
  context: vscode.ExtensionContext,
  strays: string[],
  log: (message: string) => void,
): void {
  const kept = context.globalState.get<string[]>(KEPT_FOREIGN_KEY, []);
  const pending = strays.filter(entry => !kept.includes(entry));
  if (pending.length === 0) {
    return;
  }

  const names = pending.map(entry => path.basename(entry));
  const listed = names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')}, \u2026`;
  const message =
    `Makerchip: ${pending.length} unexpected item(s) in ${MAKERCHIP_DIR} (${listed}). ` +
    'This folder is managed by the extension and its contents may be overwritten on update \u2014 ' +
    'keep your own files elsewhere, or in its tmp/ subdirectory.';

  vscode.window.showWarningMessage(message, 'Move to Trash', 'Reveal', 'Keep').then(async selection => {
    if (selection === 'Reveal') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pending[0]));
      return;  // Decide nothing; we will ask again on the next update.
    }
    if (selection === 'Keep') {
      await context.globalState.update(KEPT_FOREIGN_KEY, [...kept, ...pending]);
      return;
    }
    if (selection !== 'Move to Trash') {
      return;  // Dismissed: ask again next time rather than assuming either answer.
    }

    // This runs long after populateResources finished and locked the top level, and removing an
    // entry needs write permission on its parent. Re-open MAKERCHIP_DIR for the deletions, then
    // restore the lock. Strays under resources/ also need their own tree unlocked, because a
    // recursive delete unlinks from every directory it walks.
    await unlockMakerchipDir();
    try {
      for (const entry of pending) {
        try {
          await makeTreeWritable(entry);
          await vscode.workspace.fs.delete(vscode.Uri.file(entry), { recursive: true, useTrash: true });
          log(`  \u2713 Moved to trash: ${entry}`);
        } catch (error) {
          log(`  Warning: Could not move ${entry} to trash: ${error}`);
          vscode.window.showWarningMessage(
            `Makerchip: could not move ${path.basename(entry)} to trash. Please remove it manually.`
          );
        }
      }
    } finally {
      await lockMakerchipDir(log);
    }
  });
}
