import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { populateResources, MAKERCHIP_DIR, RESOURCES_DIR, RESOURCES_VERSION } from './populateResources';

interface ResourcesMetadata {
  updated: string;
  repositories: string[];
  script_version: string;
}

/**
 * Initialize Makerchip reference data on extension activation
 */
export async function initializeResources(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('makerchip');
  const autoUpdate = config.get<boolean>('autoUpdateResources', true);

  if (!autoUpdate) {
    console.log('Makerchip: Auto-update reference data disabled');
    return;
  }

  try {
    const needsUpdate = await checkResourcesNeedUpdate();
    
    if (needsUpdate) {
      await updateResourcesWithProgress(context);
    } else {
      console.log('Makerchip reference data is up to date');
    }

    // Optionally add to workspace
    await maybeAddResourcesToWorkspace(context);
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
export async function updateResources(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Makerchip Reference Data');
  outputChannel.show(true);

  try {
    const result = await populateResources(context, outputChannel);
    
    const message = `Makerchip reference data updated: ${result.success}/${result.total} repositories`;
    vscode.window.showInformationMessage(message);
  } catch (error: any) {
    console.error('Failed to update reference data:', error);
    vscode.window.showErrorMessage(`Failed to update Makerchip reference data: ${error.message}`);
    throw error;
  }
}

/**
 * Update resources with progress indicator
 */
async function updateResourcesWithProgress(context: vscode.ExtensionContext): Promise<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Updating Makerchip reference data...',
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Cloning repositories...' });
      
      await updateResources(context);
      
      progress.report({ message: 'Complete!' });
    }
  );
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
    'Add Makerchip data folder (docs, examples, compile cache) to workspace for Copilot context?',
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
