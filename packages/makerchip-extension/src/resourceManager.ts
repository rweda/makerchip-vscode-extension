import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { populateResources, MAKERCHIP_DIR, MANAGED_ENTRIES, RESOURCES_DIR, RESOURCES_VERSION } from './populateResources';
import { installLiveDocSkill } from './liveDocSkill';
import { log } from './logger';

/** Resolves the connected Makerchip server's base URL. */
type ServerUrlFn = () => Promise<string>;

interface ResourcesMetadata {
  updated: string;
  repositories: string[];
  script_version: string;
}

/**
 * Initialize Makerchip reference data on extension activation
 */
export async function initializeResources(context: vscode.ExtensionContext, serverUrl: ServerUrlFn): Promise<void> {
  const config = vscode.workspace.getConfiguration('makerchip');
  const autoUpdate = config.get<boolean>('autoUpdateResources', true);

  try {
    if (autoUpdate && await checkResourcesNeedUpdate()) {
      await updateResourcesWithProgress(context, serverUrl);
    } else {
      console.log(autoUpdate ? 'Makerchip reference data is up to date' : 'Makerchip: Auto-update reference data disabled');
      // Refresh the Live Doc skill regardless, to track the server we are connected to now.
      await composeLiveDocSkill(context, serverUrl);
    }

    // Optionally add to workspace
    if (autoUpdate) {
      await maybeAddResourcesToWorkspace(context);
    }
  } catch (error) {
    console.error('Failed to initialize Makerchip reference data:', error);
    // Don't block extension activation on resource failure
  }
}

/**
 * Check if resources need to be updated
 */
async function checkResourcesNeedUpdate(): Promise<boolean> {
  try {
    const versionFile = path.join(RESOURCES_DIR, '.version.json');
    const content = await fs.readFile(versionFile, 'utf-8');
    const metadata: ResourcesMetadata = JSON.parse(content);
    
    // Check if version changed or resources are old (>7 days)
    const updated = new Date(metadata.updated);
    const daysSinceUpdate = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
    
    return metadata.script_version !== RESOURCES_VERSION || daysSinceUpdate > 7;
  } catch {
    // If version file doesn't exist or is invalid, needs update
    return true;
  }
}

/**
 * Update resources by running the populate logic
 */
export async function updateResources(context: vscode.ExtensionContext, serverUrl: ServerUrlFn): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Makerchip Reference Data');
  outputChannel.show(true);

  try {
    const result = await populateResources(context, outputChannel);
    
    let message = `Makerchip reference data updated: ${result.success}/${result.total} repositories`;
    if (result.localChanges.length > 0) {
      message += ` (${result.localChanges.length} skipped due to local changes)`;
    }
    
    if (result.success === result.total) {
      vscode.window.showInformationMessage(message);
    } else if (result.localChanges.length > 0) {
      // Don't show another message here; populateResources already showed a warning
      outputChannel.appendLine(message);
    } else {
      vscode.window.showWarningMessage(message);
    }
  } catch (error: any) {
    console.error('Failed to update reference data:', error);
    vscode.window.showErrorMessage(`Failed to update Makerchip reference data: ${error.message}`);
    throw error;
  } finally {
    // Populating clears the skills directory, even when it then fails.
    await composeLiveDocSkill(context, serverUrl);
  }
}

/**
 * Update resources with progress indicator
 */
async function updateResourcesWithProgress(context: vscode.ExtensionContext, serverUrl: ServerUrlFn): Promise<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Updating Makerchip reference data...',
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Cloning repositories...' });
      
      await updateResources(context, serverUrl);
      
      progress.report({ message: 'Complete!' });
    }
  );
}

/**
 * Compose the Live Doc skill from the connected server's API reference (see liveDocSkill.ts), into
 * the skills directory that populating clears. Never fails: a missing skill is only logged.
 */
async function composeLiveDocSkill(context: vscode.ExtensionContext, serverUrl: ServerUrlFn): Promise<void> {
  try {
    const result = await installLiveDocSkill({
      extensionPath: context.extensionPath,
      skillsDir: path.join(MAKERCHIP_DIR, MANAGED_ENTRIES.vscode, 'skills'),
      serverUrl: await serverUrl(), log,
    });
    log(`Live Doc skill ${result.action}: ${result.skillPath}` + (result.reason ? ` (${result.reason})` : ''));
  } catch (error: any) {
    log(`⚠ Live Doc skill not installed: ${error?.message ?? error}`);
  }
}

/**
 * Optionally add reference data folder to workspace
 */
async function maybeAddResourcesToWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('makerchip');
  const addResources = config.get<string>('addResourcesFolder');
  
  const folders = vscode.workspace.workspaceFolders || [];
  const alreadyAdded = folders.some(f => f.uri.fsPath === MAKERCHIP_DIR);
  
  if (alreadyAdded || addResources === 'never') {
    return;
  }
  
  if (addResources === 'always') {
    await addResourcesFolder();
    return;
  }
  
  // Ask user (first time only)
  const response = await vscode.window.showInformationMessage(
    'Add Makerchip data folder (docs, examples, compile cache) to workspace for AI assistant context?',
    'Yes',
    'No',
    'Never'
  );
  
  if (response === 'Yes') {
    await config.update('addResourcesFolder', 'always', vscode.ConfigurationTarget.Global);
    await addResourcesFolder();
  } else if (response === 'Never') {
    await config.update('addResourcesFolder', 'never', vscode.ConfigurationTarget.Global);
  }
}

/**
 * Add resources folder to workspace
 */
async function addResourcesFolder(): Promise<void> {
  const numFolders = vscode.workspace.workspaceFolders?.length || 0;
  
  const success = vscode.workspace.updateWorkspaceFolders(
    numFolders,
    0,
    {
      uri: vscode.Uri.file(MAKERCHIP_DIR),
      name: '📚 Makerchip Data'
    }
  );
  
  if (success) {
    vscode.window.showInformationMessage('Makerchip data folder added to workspace');
  }
}

/**
 * Get the resources directory path
 */
export function getResourcesPath(): string {
  return RESOURCES_DIR;
}

/**
 * Check if resources are installed
 */
export async function resourcesExist(): Promise<boolean> {
  try {
    await fs.access(RESOURCES_DIR);
    return true;
  } catch {
    return false;
  }
}
