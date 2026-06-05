/*
 * For populating resources and skill(s) in ~/.vscode-makerchip/resources/.
 * This directory may be added to a workspace (by the Makerchip extension) as available RAG data for Copilot.
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
  await copyReadmeFile(context, 'README.md', MAKERCHIP_DIR, log);
  await copyReadmeFile(context, 'compile-cache-README.md', CACHE_DIR, log);
  await copyReadmeFile(context, '.copilot-instructions.md', MAKERCHIP_DIR, log);
  await copyReadmeFile(context, 'tmp-README.md', TMP_DIR, log);

  // Create version metadata
  await createVersionMetadata();

  // Install skill
  await installSkill(context, log);

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
 * Copy a README file from extension resources to a target directory
 */
async function copyReadmeFile(
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
  const apiDocsPath = path.join(RESOURCES_DIR, 'Makerchip-public', 'docs', 'plugin_api', 'API_features.md');
  
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
