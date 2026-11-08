import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { populateResources, DEV_MODE, MAKERCHIP_DIR, MANAGED_ENTRIES, RESOURCES_DIR, RESOURCES_VERSION } from './populateResources';
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
    if (result.gitMissing) {
      return;  // populateResources has told the user; the summary below would only mislead.
    }
    
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
 * Optionally add this install's data folder to the workspace, replacing any other install's.
 *
 * A workspace (e.g. a mono clone's) can be opened by different installs over time -- the
 * Marketplace one, or EDHs from different checkouts -- and each has its own data folder (see
 * makerchipDirFor). Only the running install's folder is meaningful to an agent, so others are
 * replaced rather than accumulated. Panels restored from an earlier install's session may still
 * refer to compile ids in that install's cache, which this install cannot restore; accepted.
 */
async function maybeAddResourcesToWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('makerchip');
  const addResources = config.get<string>('addResourcesFolder');
  if (addResources === 'never') {
    return;
  }

  // An EDH's folder is named for its checkout, so it is clear which extension clone is loaded;
  // e.g. checkout makerchip-vscode-extension_tt -> "(tt)".
  const checkout = path.basename(path.resolve(context.extensionPath, '..', '..'))
    .replace(/^makerchip-vscode-extension[-_](?=.)/, '');
  const name = DEV_MODE ? `📚 Makerchip Data (${checkout})` : '📚 Makerchip Data';
  const isOurs = (f: vscode.WorkspaceFolder) => f.uri.fsPath === MAKERCHIP_DIR && f.name === name;
  const folders = vscode.workspace.workspaceFolders || [];
  // Any install's data folder ends in the same directory name (see makerchipDirFor).
  const others = folders.filter(f => path.basename(f.uri.fsPath) === path.basename(MAKERCHIP_DIR) && !isOurs(f));

  if (others.length > 0) {
    // The user opted in for this workspace (via an earlier install), so replace without asking.
    // Last first, so earlier indices stay valid; the first is replaced in place unless ours exists.
    const haveOurs = folders.some(isOurs);
    for (const f of [...others].reverse()) {
      const add = (f === others[0] && !haveOurs) ? [{ uri: vscode.Uri.file(MAKERCHIP_DIR), name }] : [];
      await updateWorkspaceFolders(f.index, 1, ...add);
    }
    log(`Replaced ${others.length} other Makerchip data folder(s) in the workspace with ${MAKERCHIP_DIR}`);
    return;
  }
  if (folders.some(isOurs)) {
    return;
  }

  if (addResources === 'always') {
    await addResourcesFolder(name);
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
    await addResourcesFolder(name);
  } else if (response === 'Never') {
    await config.update('addResourcesFolder', 'never', vscode.ConfigurationTarget.Global);
  }
}

/**
 * Add resources folder to workspace
 */
async function addResourcesFolder(name: string): Promise<void> {
  const numFolders = vscode.workspace.workspaceFolders?.length || 0;
  if (await updateWorkspaceFolders(numFolders, 0, { uri: vscode.Uri.file(MAKERCHIP_DIR), name })) {
    vscode.window.showInformationMessage('Makerchip data folder added to workspace');
  }
}

/**
 * `vscode.workspace.updateWorkspaceFolders`, resolved once the change lands: the API forbids a
 * further call before `onDidChangeWorkspaceFolders` fires.
 */
async function updateWorkspaceFolders(start: number, deleteCount: number,
    ...add: { uri: vscode.Uri; name: string }[]): Promise<boolean> {
  let listener: vscode.Disposable | undefined;
  const changed = new Promise<void>(resolve => {
    listener = vscode.workspace.onDidChangeWorkspaceFolders(() => resolve());
  });
  try {
    if (!vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...add)) {
      return false;
    }
    await changed;
    return true;
  } finally {
    listener!.dispose();
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
