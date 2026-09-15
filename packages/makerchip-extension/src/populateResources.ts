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

// Directory structure
export const MAKERCHIP_DIR = path.join(os.homedir(), '.vscode-makerchip');
export const RESOURCES_DIR = path.join(MAKERCHIP_DIR, 'resources');
export const CACHE_DIR = path.join(MAKERCHIP_DIR, 'compile-cache');
export const TMP_DIR = path.join(MAKERCHIP_DIR, 'tmp');
export const RESOURCES_VERSION = '2.0.0';

interface Repository {
  name: string;
  url: string;
}

const REPOSITORIES: Repository[] = [
  { name: 'Makerchip-public', url: 'https://github.com/rweda/Makerchip-public.git' },
  { name: 'makerchip_examples', url: 'https://github.com/stevehoover/makerchip_examples.git' },
  { name: 'LF-Building-a-RISC-V-CPU-Core-Course', url: 'https://github.com/stevehoover/LF-Building-a-RISC-V-CPU-Core-Course.git' },
  { name: 'warp-v', url: 'https://github.com/stevehoover/warp-v.git' },
  { name: 'warp-v_includes', url: 'https://github.com/stevehoover/warp-v_includes.git' },
  { name: 'tlv_lib', url: 'https://github.com/TL-X-org/tlv_lib.git' },
  { name: 'tlv_flow_lib', url: 'https://github.com/TL-X-org/tlv_flow_lib.git' },
  { name: 'Virtual-FPGA-Lab', url: 'git@github.com:os-fpga/Virtual-FPGA-Lab.git'},
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

  // Move tmp directory contents to /tmp for cleanup before updating
  await stageTmpForDeletion(log);

  // Create directory structure
  await fs.mkdir(RESOURCES_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  // Clean up unexpected resources
  await cleanupUnexpectedResources(log);

  // Clone or update repositories
  const result = await updateRepositories(log);

  // Copy READMEs
  await copyResourceFile(context, 'README.md', MAKERCHIP_DIR, log);
  await copyResourceFile(context, 'compile-cache-README.md', CACHE_DIR, log);
  await copyResourceFile(context, 'tmp-README.md', TMP_DIR, log);

  // Copilot instruction file, installed at the path Copilot actually auto-loads
  // (<workspace folder>/.github/copilot-instructions.md). The Claude-harness counterpart,
  // CLAUDE.md, is generated later (generateClaudeMd) once the skills are installed.
  await installCopilotInstructions(context, log);

  // Copy the minimal scratch design used to open panels without creating clutter.
  await copyResourceFile(context, 'minimal.tlv', RESOURCES_DIR, log);

  // Create version metadata
  await createVersionMetadata();

  // Mark reference data read-only to prevent accidental edits (repos are now clean)
  await makeResourcesReadOnly(log);

  // Install skill
  await installSkill(context, log);

  // CLAUDE.md for the Claude harness (which auto-loads CLAUDE.md, but NOT
  // .github/copilot-instructions.md or .vscode/skills/*). Runs after installSkill so it
  // can enumerate the installed skill files and point Claude at them. See generateClaudeMd.
  await generateClaudeMd(context, log);

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
    
    // Move entire directory to /tmp
    await fs.rename(TMP_DIR, stagingDir);
    
    log('  ✓ Tmp directory moved to /tmp (will be deleted on reboot)');
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
 * Clean up unexpected files and directories
 */
async function cleanupUnexpectedResources(log: (message: string) => void): Promise<void> {
  log('🧹 Cleaning up unexpected resources...');

  const repoNames = REPOSITORIES.map(r => r.name);
  const validResources = new Set([...repoNames, ...EXPECTED_RESOURCES]);

  let removedCount = 0;

  try {
    const resources = await fs.readdir(RESOURCES_DIR);

    for (const resource of resources) {
      // Check if resource is valid
      if (!validResources.has(resource)) {
        log(`  Removing: ${resource}`);
        const resourcePath = path.join(RESOURCES_DIR, resource);
        await fs.rm(resourcePath, { recursive: true, force: true });
        removedCount++;
      }
    }

    if (removedCount === 0) {
      log('  ✓ No unexpected resources found');
    }
  } catch (error) {
    log(`  Warning: Failed to cleanup: ${error}`);
  }

  log('');
}

/**
 * Check if a git repository has local changes (uncommitted or unpushed)
 */
async function hasLocalChanges(repoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Check for uncommitted changes
    const proc = spawn('git', ['status', '--porcelain'], { cwd: repoPath, stdio: 'pipe' });
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      // If there's any output, there are local changes
      resolve(output.trim().length > 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
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
 * Only the write bits are cleared; the executable bit is preserved, so git's view
 * of each tree is unchanged (git tracks the exec bit, not the read/write bits) and
 * `git status` stays clean. Directories are left writable and the `.git` directory
 * is skipped, so git can still fast-forward on the next update: it updates tracked
 * files by unlinking + recreating them, which needs directory (not file) write
 * permission. `.version.json` is skipped because it is rewritten on every run.
 */
async function makeResourcesReadOnly(log: (message: string) => void): Promise<void> {
  log('🔒 Marking reference data read-only...');

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const { mode } = await fs.stat(fullPath);
          await fs.chmod(fullPath, mode & ~0o222);
        } catch {
          // Ignore individual file failures (e.g. transient/removed files)
        }
      }
    }
  };

  try {
    // Skip the top-level .version.json (rewritten every run); lock repo trees only.
    const entries = await fs.readdir(RESOURCES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git') {
        await walk(path.join(RESOURCES_DIR, entry.name));
      }
    }
    log('  ✓ Reference data is read-only');
  } catch (error) {
    log(`  Warning: Failed to set read-only permissions: ${error}`);
  }

  log('');
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
      
      // Remove existing non-git directory if it exists
      try {
        const stat = await fs.stat(repoPath);
        if (stat.isDirectory()) {
          log('    ! Removing existing non-git directory');
          await fs.rm(repoPath, { recursive: true, force: true });
        }
      } catch {
        // Path doesn't exist, which is fine
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
  const targetSkillsDir = path.join(MAKERCHIP_DIR, '.vscode', 'skills');
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
 * as a workspace folder, so Copilot picks it up. Earlier versions wrote it to the folder
 * root (`.copilot-instructions.md`), which no tool auto-loads; that stale copy is removed here.
 */
async function installCopilotInstructions(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  const templatePath = path.join(context.extensionPath, 'resources', '.copilot-instructions.md');
  const githubDir = path.join(MAKERCHIP_DIR, '.github');
  const targetPath = path.join(githubDir, 'copilot-instructions.md');

  try {
    await fs.mkdir(githubDir, { recursive: true });
    await fs.copyFile(templatePath, targetPath);
    log('  ✓ Installed .github/copilot-instructions.md');
  } catch (error) {
    log(`  Warning: Failed to install copilot-instructions.md: ${error}`);
  }

  // Remove the stale root-level copy from earlier extension versions (wrong path).
  try {
    await fs.rm(path.join(MAKERCHIP_DIR, '.copilot-instructions.md'), { force: true });
  } catch {
    // Nothing to remove, which is fine.
  }
}

/**
 * Claude-only guidance appended to CLAUDE.md (not part of the shared Copilot intro).
 * This guidance is based on testing a pre-release version of Microsoft's Claude harness.
 * Future versions may resolve these issues.
 */
const CLAUDE_TOOL_GATING_NOTE = `
## Tool Issues

Based on testing of a pre-release version of Microsoft's Claude harness, there are several
issues with tool access that have workarounds. Be careful to work around them, as some
can result in HANGS.

### Makerchip Tool Gating (Claude harness)

The Makerchip MCP tools are gated to conserve tool slots, so not all are offered at once. Two
fallbacks are always available: \`makerchip_enable_tools\` (activate (or release) a capability set) and
\`makerchip_invoke_tool\` (call any tool by name, even a gated one).

- \`makerchip_enable_tools\` makes a set's tools *offered*, but a newly enabled tool only becomes
  directly callable on the NEXT turn — the offered tool list for the current turn is fixed before the
  enable takes effect. Calling it the same turn fails with "No such tool available". This is expected
  and does NOT require a new chat: either wait for your next turn, or call it now via
  \`makerchip_invoke_tool\`.
- For a one-off call to a gated tool, prefer \`makerchip_invoke_tool\` (no lasting tool-set change).
- **Never issue \`mcp__client__makerchip*\` calls concurrently — issue them ONE AT A TIME**, awaiting
  each before starting the next. Batching two or more in a single execution round HANGS: the first
  returns, the rest never reach the extension (the harness bridge dispatches one tool call at a time
  and drops the concurrent ones). This is a harness-bridge limitation, not a stale provider.
  Fix: re-issue the calls serially.
- A set change (\`makerchip_enable_tools\` enable OR release) plus a same-turn call to an affected tool
  is unsafe: *enabling* lags (fast "No such tool available", above), and *releasing* a set then calling
  one of its still-offered tools that same turn HANGS (the bridge dispatches to a now-unregistered
  tool). Let set changes settle to the next turn, or reach the tool via \`makerchip_invoke_tool\`.

### Stale Tool-Provider Binding

The tool-provider clientId is bound at the start of the chat session and stays pinned for the whole
chat. If the extension host reloads, it comes back with a new MCP gateway and clientId, but the chat
stays bound to the old one, so every \`mcp__client__makerchip*\` call routes to the dead connection and
**hangs indefinitely** — it never reaches the extension. If the user skips the command, a "skipped
from another client" / "Unknown error" is surfaced. The harness may even say *"another active client
now provides ... you may try calling the tool again"* — but retrying re-routes to the same dead
connection and hangs again.

### Diagnosing a Hang

Try to avoid hangs, but if you slip and hit one, rule out the turn-local causes first:
- **Gating lag** — fails FAST with "No such tool available"; only right after \`makerchip_enable_tools\`;
  clears next turn. Do NOT start a new chat.
- **Concurrent calls** — HANGS; you issued >=2 \`mcp__client__\` calls in one execution round (the first
  returned, a later one hung). Fix: re-issue serially, one at a time. No fresh chat.
- **Same-turn set change** — HANGS; you released a set and called one of its tools in the same turn.
  Fix: let it settle to the next turn, or use \`makerchip_invoke_tool\`. No fresh chat.
- **Stale provider** — a LONE, serial call still HANGS (until skipped), with no gating change this turn,
  after a reload, an extension update/enable/disable or, an extension host crash; retrying keeps hanging.
  Fix: Direct the user to start a fresh chat.

`;

/**
 * Generate `CLAUDE.md` for the Claude harness. Unlike Copilot, the Claude harness auto-loads
 * `CLAUDE.md` but NOT `.github/copilot-instructions.md` or `.vscode/skills/*`. So CLAUDE.md is a
 * COPY of the shared instruction intro (not a link — Claude needs the real file) with a generated
 * list of the installed skill files appended, telling Claude they exist and where to read them.
 * Regenerated on every populate so the skill list stays accurate; must run after installSkill.
 */
async function generateClaudeMd(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  const introPath = path.join(context.extensionPath, 'resources', '.copilot-instructions.md');
  const skillsDir = path.join(MAKERCHIP_DIR, '.vscode', 'skills');

  try {
    const intro = await fs.readFile(introPath, 'utf-8');
    const skillLines = await listSkillFiles(skillsDir);
    const skillSection = skillLines.length > 0
      ? '\n## Skill Files (read as needed)\n\n' +
        'The Claude harness does not auto-load `.vscode/skills/`. These files (relative to this ' +
        'folder) provide detailed TL-Verilog guidance — read the relevant one when its topic comes up:\n\n' +
        skillLines.join('\n') + '\n'
      : '';
    const content = intro.trimEnd() + '\n' + skillSection + CLAUDE_TOOL_GATING_NOTE;

    await fs.writeFile(path.join(MAKERCHIP_DIR, 'CLAUDE.md'), content, 'utf-8');
    log('  ✓ Generated CLAUDE.md');
  } catch (error) {
    log(`  Warning: Failed to generate CLAUDE.md: ${error}`);
  }
}

/**
 * List installed skill files as Markdown bullets ("- `.vscode/skills/<file>` — <description>"),
 * pulling each description from the file's YAML frontmatter. The meta index (README.md) is skipped.
 */
async function listSkillFiles(skillsDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await fs.readdir(skillsDir))
      .filter(f => f.endsWith('.md') && f !== 'README.md')
      .sort();
  } catch {
    return [];
  }

  const lines: string[] = [];
  for (const file of files) {
    let description = '';
    try {
      description = extractFrontmatterDescription(await fs.readFile(path.join(skillsDir, file), 'utf-8'));
    } catch {
      // Unreadable file: list it without a description rather than dropping it.
    }
    const rel = `.vscode/skills/${file}`;
    lines.push(description ? `- \`${rel}\` — ${description}` : `- \`${rel}\``);
  }
  return lines;
}

/** Extract the `description:` value from leading YAML frontmatter (quoted or bare), or '' if absent. */
function extractFrontmatterDescription(content: string): string {
  if (!content.startsWith('---')) {
    return '';
  }
  const end = content.indexOf('\n---', 3);
  const frontmatter = end >= 0 ? content.slice(0, end) : content;
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  if (!match) {
    return '';
  }
  let value = match[1].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}
