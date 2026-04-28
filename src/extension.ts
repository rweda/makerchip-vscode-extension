/**
 * Makerchip VS Code Extension - Main activation module
 * 
 * Provides TL-Verilog development support with:
 *   - Makerchip IDE integration via webview panel(s)
 *   - GitHub Copilot Language Model tools (makerchip_compile, makerchip_ide_call)
 *   - Chat participant (@makerchip)
 *   - Reference data management (clones docs/examples to ~/.vscode-makerchip/resources/)
 *   - Compilation cache (stores results in ~/.vscode-makerchip/compile-cache/)
 * 
 * Architecture:
 *   - Global context/panel state for clean API
 *   - Multiple named panels supported
 *   - Generic callIDE() helper for all IDE method invocations
 *   - Unified message protocol: { type: 'ide', method, args }
 *   - Webview compiled separately as ES module (see tsconfig.webview.json)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { initializeResources, updateResources } from './resourceManager';
import { registerMakerchipTool } from './makerchipTool';
import { registerMakerchipParticipant } from './makerchipParticipant';
import * as compileCache from './compileCache';

// Track multiple panels by name
const panels = new Map<string, vscode.WebviewPanel>();
const panelReadyPromises = new Map<string, Promise<void>>();
const pendingCompiles = new Map<string, string>(); // panelKey -> source code while awaiting an ID
let panelCounter = 1;
let statusBarItem: vscode.StatusBarItem;
let context: vscode.ExtensionContext;

/**
 * Ensure a Makerchip panel is open and ready to receive messages.
 * @param name Optional panel name. If not provided, uses 'default' for single-panel usage.
 * @returns Promise that resolves when panel is ready
 */
async function ensurePanelReady(name?: string): Promise<void> {
  const panelKey = name || 'default';
  
  if (panelReadyPromises.has(panelKey)) {
    // Panel is already open or opening - wait for it
    return panelReadyPromises.get(panelKey)!;
  }
  
  if (panels.has(panelKey)) {
    // Panel exists but ready promise was cleared - just reveal it
    panels.get(panelKey)!.reveal(vscode.ViewColumn.Beside, true);
    return Promise.resolve();
  }
  
  // Open new panel and track the ready promise
  const readyPromise = openMakerchipPanel(panelKey);
  panelReadyPromises.set(panelKey, readyPromise);
  return readyPromise;
}

/**
 * Call an IDE method, ensuring the panel is open and ready.
 * @param method IDE method name to invoke
 * @param args Arguments to pass to the method
 * @param panelName Optional panel name to target. Defaults to 'default'.
 */
export async function callIDE(method: string, args?: any[], panelName?: string): Promise<void> {
  const name = panelName || 'default';
  await ensurePanelReady(name);
  const panel = panels.get(name);
  if (!panel) {
    throw new Error(`Panel '${name}' not found`);
  }
  
  // Track compile source code for cache initialization
  if (method === 'compile' && args && args.length > 0 && typeof args[0] === 'string') {
    pendingCompiles.set(name, args[0]);
  }
  
  panel.webview.postMessage({ 
    type: 'ide', 
    method, 
    args: args || []
  });
}

export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;  // Store context globally
  console.log('Makerchip extension activating...');
  
  // Register Language Model tool for Copilot (automatic invocation)
  // Both declarative (package.json) and programmatic registration are required
  try {
    registerMakerchipTool(context);
    console.log('Makerchip tool registered successfully');
  } catch (error) {
    console.error('Failed to register Makerchip tool:', error);
  }

  // Register Chat Participant for @makerchip (user-initiated)
  try {
    registerMakerchipParticipant(context);
  } catch (error) {
    console.error('Failed to register Makerchip chat participant:', error);
  }

  // Initialize resources (clone/update repos and install skill)
  initializeResources(context).catch(error => {
    console.error('Failed to initialize Makerchip reference data:', error);
  });

  // Cleanup old cache entries on activation
  compileCache.cleanupOldEntries().catch(error => {
    console.error('Failed to cleanup old cache entries:', error);
  });

  // STATUS BAR BUTTON
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(circuit-board) Compile/Simulate";
  statusBarItem.command = 'makerchip.compile';
  statusBarItem.tooltip = 'Compile and simulate current file in Makerchip';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // COMPILE/SIMULATE COMMAND (uses default panel)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compile', async () => {

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      const code = editor.document.getText();

      // Call IDE to compile the code (default panel)
      await callIDE('compile', [code]);
    })
  );

  // COMPILE/SIMULATE IN AUTO-NAMED PANEL COMMAND (sequential naming)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compileNew', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      const code = editor.document.getText();
      const panelName = `Panel ${panelCounter++}`;
      await callIDE('compile', [code], panelName);
    })
  );

  // COMPILE/SIMULATE IN PANEL COMMAND (with panel selection)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compileNamed', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      // Build QuickPick items: existing panels + new panel option
      const existingPanels = Array.from(panels.keys());
      const items: vscode.QuickPickItem[] = [
        ...existingPanels.map(name => ({
          label: name,
          description: name === 'default' ? '(current)' : ''
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem,
        { label: '$(add) New Panel...', alwaysShow: true }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select panel or create new one'
      });

      if (!selected) return; // User cancelled

      let panelName: string;
      if (selected.label === '$(add) New Panel...') {
        // Prompt for new panel name
        const input = await vscode.window.showInputBox({
          prompt: 'Enter panel name (or leave empty for auto-generated)',
          placeHolder: `Panel ${panelCounter}`
        });
        if (input === undefined) return; // User cancelled
        panelName = input.trim() || `Panel ${panelCounter++}`;
      } else {
        panelName = selected.label;
      }

      const code = editor.document.getText();
      await callIDE('compile', [code], panelName);
    })
  );

  // UPDATE REFERENCE DATA COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.updateResources', async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Updating Makerchip reference data...',
            cancellable: false
          },
          async () => {
            await updateResources(context);
          }
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to update reference data: ${error.message}`);
      }
    })
  );

  // INVOKE IDE METHOD COMMAND (used by Copilot tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.invokeIdeMethod', async (method: string, args: any[] = [], panelName?: string) => {
      await callIDE(method, args, panelName);
    })
  );

  // LIST PANELS COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.listPanels', async () => {
      if (panels.size === 0) {
        vscode.window.showInformationMessage('No Makerchip panels currently open');
        return;
      }
      const panelNames = Array.from(panels.keys()).join(', ');
      vscode.window.showInformationMessage(`Open Makerchip panels: ${panelNames}`);
    })
  );
}

function openMakerchipPanel(panelKey: string): Promise<void> {
  return new Promise((resolve) => {
    // Create display name
    const displayName = panelKey === 'default' ? 'Makerchip IDE' : `Makerchip: ${panelKey}`;
    
    const panel = vscode.window.createWebviewPanel(
      'makerchip', displayName,
      vscode.ViewColumn.Beside,
      { 
        enableScripts: true,
        retainContextWhenHidden: true  // Prevent reload on move/hide
      }
    );

    // Store panel in map
    panels.set(panelKey, panel);

    const nonce = getNonce();
    
    // Get webview URI for the script file
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.js')
    );

    // Load HTML template and replace placeholders
    const htmlPath = path.join(context.extensionPath, 'out', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{scriptUri}}/g, scriptUri.toString());
    
    panel.webview.html = html;

    panel.webview.onDidReceiveMessage(async (msg) => {
      console.log(`Message received from webview (panel: ${panelKey}):`, msg.type, msg);
      
      if (msg.type === 'ready') {
        resolve();   // 🔹 resolve when IDE is ready
      }
      
      if (msg.type === 'ideResult' && msg.method === 'compile' && msg.result) {
        // Initialize cache when compile returns an ID
        console.log(`Compile ID received: ${msg.result}`);
        try {
          const sourceCode = pendingCompiles.get(panelKey);
          await compileCache.initCompile(msg.result, sourceCode);
          pendingCompiles.delete(panelKey); // Clean up
        } catch (error) {
          console.error('Failed to initialize compile cache:', error);
        }
      }
      
      if (msg.type === 'compileFileChunk') {
        // Cache compilation result file chunks (stdall, make.out, or vlt_dump.vcd)
        console.log(`Compile file chunk for ${msg.id}: ${msg.fileName}, ${msg.chunk.length} chars, complete=${msg.complete}`);
        try {
          await compileCache.appendFile(msg.id, msg.fileName, msg.chunk);
          if (msg.complete) {
            await compileCache.completeFile(msg.id, msg.fileName);
            console.log(`${msg.fileName} complete and cached for ${msg.id}`);
          }
        } catch (error) {
          console.error(`Failed to cache ${msg.fileName} chunk:`, error);
        }
      }
      
      if (msg.type === 'compileError') {
        // Record compilation error
        console.log(`Compile error for ${msg.id}: ${msg.errorType}`);
        try {
          await compileCache.recordError(msg.id, msg.errorType, msg.message, msg.details);
        } catch (error) {
          console.error('Failed to record compile error:', error);
        }
      }
      
      if (msg.type === 'compileExitStatus') {
        // Record exit status from compilation stage
        console.log(`Exit status for ${msg.id}: ${msg.stage} = ${msg.exitCode}`);
        try {
          await compileCache.recordExitStatus(msg.id, msg.stage, msg.exitCode);
        } catch (error) {
          console.error('Failed to record exit status:', error);
        }
      }
      
      if (msg.type === 'compileDenied') {
        // Show denial message to user
        console.log(`Compilation denied: ${msg.reason} - ${msg.message}`);
        const retryMsg = msg.retryAfterSeconds ? ` Retry after ${msg.retryAfterSeconds} seconds.` : '';
        vscode.window.showWarningMessage(`Compilation denied: ${msg.message}${retryMsg}`);
      }
    });

    panel.onDidDispose(() => { 
      panels.delete(panelKey);
      panelReadyPromises.delete(panelKey);
      pendingCompiles.delete(panelKey);
    });
  });
}

export function deactivate() {}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}