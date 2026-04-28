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
  { name: 'M5', url: 'https://github.com/rweda/M5.git' },
  { name: 'LLM_TLV', url: 'https://github.com/stevehoover/LLM_TLV' },
];

const EXPECTED_ITEMS = [
  'README.md',
  '.version.json',
];

interface PopulateResult {
  success: number;
  total: number;
  failed: string[];
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

  // Create directory structure
  await fs.mkdir(RESOURCES_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Clean up unexpected items
  await cleanupUnexpectedItems(log);

  // Clone or update repositories
  const result = await updateRepositories(log);

  // Copy README
  await copyReadme(context, log);

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
  log(`Repositories: ${result.success}/${result.total} updated successfully`);
  log('');

  if (result.failed.length > 0) {
    log('⚠️  Failed repositories:');
    result.failed.forEach(repo => log(`  - ${repo}`));
    log('');
  }

  return result;
}

/**
 * Clean up unexpected files and directories
 */
async function cleanupUnexpectedItems(log: (message: string) => void): Promise<void> {
  log('🧹 Cleaning up unexpected items...');

  const repoNames = REPOSITORIES.map(r => r.name);
  const validItems = new Set([...repoNames, ...EXPECTED_ITEMS]);

  let removedCount = 0;

  try {
    const items = await fs.readdir(RESOURCES_DIR);

    for (const item of items) {
      // Check if item is valid
      if (!validItems.has(item)) {
        log(`  Removing: ${item}`);
        const itemPath = path.join(RESOURCES_DIR, item);
        await fs.rm(itemPath, { recursive: true, force: true });
        removedCount++;
      }
    }

    if (removedCount === 0) {
      log('  ✓ No unexpected items found');
    }
  } catch (error) {
    log(`  Warning: Failed to cleanup: ${error}`);
  }

  log('');
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

  for (const repo of REPOSITORIES) {
    const repoPath = path.join(RESOURCES_DIR, repo.name);
    const isRepo = await isGitRepo(repoPath);

    if (isRepo) {
      // Update existing repository
      log(`  ⟳ Updating: ${repo.name}`);
      const success = await gitOperation(repoPath, repo.url, true);
      
      if (success) {
        log('    ✓ Updated successfully');
        successCount++;
      } else {
        log('    ⚠ Update failed (may have local changes)');
        failed.push(`${repo.name} (update)`);
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
  };
}

/**
 * Copy README.md from template
 */
async function copyReadme(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  const templatePath = path.join(context.extensionPath, 'resources', 'README.md');
  const readmePath = path.join(RESOURCES_DIR, 'README.md');
  
  try {
    await fs.copyFile(templatePath, readmePath);
  } catch (error) {
    log(`  Warning: Failed to copy README: ${error}`);
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
 * Install Copilot skill
 */
async function installSkill(context: vscode.ExtensionContext, log: (message: string) => void): Promise<void> {
  log('Installing Copilot skill...');

  // Install to top-level .vscode directory for workspace recognition
  const skillsDir = path.join(MAKERCHIP_DIR, '.vscode', 'skills');
  await fs.mkdir(skillsDir, { recursive: true });

  // Clean up old skill files
  try {
    const skillFiles = await fs.readdir(skillsDir);
    for (const skillFile of skillFiles) {
      if (skillFile !== 'tlv-ecosystem.md') {
        log(`  Removing old skill: ${skillFile}`);
        await fs.unlink(path.join(skillsDir, skillFile));
      }
    }
  } catch {
    // Directory might not exist yet
  }

  const templatePath = path.join(context.extensionPath, 'resources', 'tlv-ecosystem.md');
  const skillPath = path.join(skillsDir, 'tlv-ecosystem.md');
  
  try {
    await fs.copyFile(templatePath, skillPath);
    log('Skill installed successfully:');
    log('  ✓ tlv-ecosystem.md');
  } catch (error) {
    log(`  Warning: Failed to copy skill: ${error}`);
  }
  
  log('');
}
