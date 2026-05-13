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
import { log } from './logger';
import * as compileCache from './compileCache';

// Track multiple panels by name
const panels = new Map<string, vscode.WebviewPanel>();
const panelReadyPromises = new Map<string, Promise<void>>();
const pendingCompiles = new Map<string, string>(); // panelKey -> source code while awaiting an ID
const pendingIdeResults = new Map<string, {resolve: (result: any) => void, reject: (error: Error) => void}>(); // requestId -> promise callbacks
let panelCounter = 1;
let requestCounter = 0;
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

/**
 * Extension activation entry point called by VS Code.
 * Registers commands, tools, chat participant, and initializes resources.
 * @param ctx Extension context provided by VS Code
 */
export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;  // Store context globally
  log('Makerchip extension activating...');
  
  // Log server configuration on startup
  getServerUrl().then(url => {
    log(`[extension] Makerchip server configured: ${url}`);
    log(`Makerchip Server: ${url}`);
  }).catch(error => {
    log(`[extension] Server URL not configured: ${error.message}`);
    log(`⚠ Makerchip panels will not open until server URL is configured`);
  });
  
  // Register Language Model tool for Copilot (automatic invocation)
  // Both declarative (package.json) and programmatic registration are required
  try {
    registerMakerchipTool(context);
    log('Makerchip tool registered successfully');
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

  // INVOKE IDE METHOD AND RETURN RESULT (used by tools that need return values)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.callIdeMethodWithResult', async (method: string, args: any[] = [], panelName?: string): Promise<any> => {
      const name = panelName || 'default';
      log(`[callIdeMethodWithResult] Calling '${method}' on panel '${name}' with args:`, args);
      
      await ensurePanelReady(name);
      const panel = panels.get(name);
      if (!panel) {
        console.error(`[callIdeMethodWithResult] Panel '${name}' not found`);
        throw new Error(`Panel '${name}' not found`);
      }
      
      // Generate unique request ID
      const requestId = `req_${++requestCounter}`;
      log(`[callIdeMethodWithResult] Generated request ID: ${requestId}`);
      
      // Create promise that will be resolved when we get the result
      const resultPromise = new Promise<any>((resolve, reject) => {
        pendingIdeResults.set(requestId, { resolve, reject });
        
        // Set timeout to reject after 10 seconds
        setTimeout(() => {
          if (pendingIdeResults.has(requestId)) {
            pendingIdeResults.delete(requestId);
            console.error(`[callIdeMethodWithResult] Timeout for request ${requestId} (method: ${method})`);
            reject(new Error(`Timeout waiting for IDE method '${method}' result`));
          }
        }, 10000);
      });
      
      // Send message with request ID
      log(`[callIdeMethodWithResult] Sending message to webview:`, { type: 'ide', method, requestId });
      panel.webview.postMessage({ 
        type: 'ide', 
        method, 
        args: args || [],
        requestId
      });
      
      return resultPromise;
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

  // OPEN WEBVIEW DEVTOOLS COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.openDevTools', async () => {
      const panelNames = Array.from(panels.keys());
      if (panelNames.length === 0) {
        vscode.window.showErrorMessage('No Makerchip panels are currently open');
        return;
      }
      
      let panelName: string | undefined;
      if (panelNames.length === 1) {
        panelName = panelNames[0];
      } else {
        panelName = await vscode.window.showQuickPick(panelNames, {
          placeHolder: 'Select which Makerchip panel to debug'
        });
      }
      
      if (panelName) {
        const panel = panels.get(panelName);
        if (panel) {
          // Use the internal API to open webview DevTools
          if ((panel.webview as any).openDevTools) {
            (panel.webview as any).openDevTools();
            vscode.window.showInformationMessage(`Opening DevTools for ${panelName}...`);
          } else {
            vscode.window.showWarningMessage(
              'webview.openDevTools() is not available. Try: Help > Toggle Developer Tools, then inspect the webview iframe.'
            );
          }
        }
      }
    })
  );
}

/**
 * Open a new Makerchip webview panel and initialize it with the IDE.
 * Sets up message handlers for compilation results, errors, and IDE communication.
 * @param panelKey Unique identifier for this panel instance
 * @returns Promise that resolves when the IDE is ready
 */
async function openMakerchipPanel(panelKey: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
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
    
    // Get server URL - required, no default fallback
    let serverUrl: string;
    try {
      serverUrl = await getServerUrl();
      log(`[extension] Opening Makerchip panel "${displayName}" with server: ${serverUrl}`);
      log(`Connecting to Makerchip server: ${serverUrl}`);
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to get server URL';
      log(`[extension] Error opening panel: ${errorMsg}`);
      vscode.window.showErrorMessage(errorMsg);
      panel.dispose();
      panels.delete(panelKey);
      panelReadyPromises.delete(panelKey);
      reject(error);
      return;
    }
    
    // Get webview URI for the script file
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.js')
    );

    // Load HTML template and replace placeholders
    const htmlPath = path.join(context.extensionPath, 'out', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{scriptUri}}/g, scriptUri.toString());
    html = html.replace(/{{serverUrl}}/g, serverUrl);
    
    panel.webview.html = html;

    // Handle messages from webview: IDE ready state, compilation results, errors, and method responses
    panel.webview.onDidReceiveMessage(async (msg) => {
      log(`Message received from webview (panel: ${panelKey}):`, msg.type, msg);
      
      if (msg.type === 'ready') {
        console.log(`[extension] IDE ready for panel: ${panelKey}`);
        log(`✓ Connected to ${serverUrl}`);
        resolve();   // 🔹 resolve when IDE is ready
      }
      
      if (msg.type === 'notification') {
        // Generic notification message (info/warning/error)
        log(`[${msg.severity.toUpperCase()}] ${msg.message}`);
        
        if (msg.severity === 'error') {
          if (msg.action) {
            vscode.window.showErrorMessage(msg.message, msg.action).then(choice => {
              if (choice === msg.action && msg.action === 'Open DevTools') {
                (panel.webview as any).openDevTools?.();
              }
            });
          } else {
            vscode.window.showErrorMessage(msg.message);
          }
        } else if (msg.severity === 'warning') {
          if (msg.action) {
            vscode.window.showWarningMessage(msg.message, msg.action);
          } else {
            vscode.window.showWarningMessage(msg.message);
          }
        } else if (msg.severity === 'info') {
          vscode.window.showInformationMessage(msg.message);
        }
      }
      
      if (msg.type === 'ideResult') {
        log(`[ideResult] Received:`, { method: msg.method, requestId: msg.requestId, hasResult: !!msg.result });
        
        // Check if this is a response to a pending request
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          log(`[ideResult] Resolving pending request: ${msg.requestId}`);
          const { resolve: resolveResult } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          resolveResult(msg.result);
        } else if (msg.requestId) {
          console.warn(`[ideResult] Received result for unknown request ID: ${msg.requestId}`);
        }
        
        // Also handle compile ID initialization for cache
        if (msg.method === 'compile' && msg.result) {
          log(`Compile ID received: ${msg.result}`);
          try {
            const sourceCode = pendingCompiles.get(panelKey);
            await compileCache.initCompile(msg.result, sourceCode);
            pendingCompiles.delete(panelKey); // Clean up
          } catch (error) {
            console.error('Failed to initialize compile cache:', error);
          }
        }
      }
      
      if (msg.type === 'ideError') {
        console.error(`[ideError] Received:`, { method: msg.method, requestId: msg.requestId, error: msg.error });
        
        // Check if this is a response to a pending request
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          log(`[ideError] Rejecting pending request: ${msg.requestId}`);
          const { reject } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          reject(new Error(msg.error));
        } else if (msg.requestId) {
          console.warn(`[ideError] Received error for unknown request ID: ${msg.requestId}`);
        }
      }
      
      if (msg.type === 'compileFileChunk') {
        // Cache compilation result file chunks (stdall, make.out, or vlt_dump.vcd)
        log(`Compile file chunk for ${msg.id}: ${msg.fileName}, ${msg.chunk.length} chars, complete=${msg.complete}`);
        try {
          await compileCache.appendFile(msg.id, msg.fileName, msg.chunk);
          if (msg.complete) {
            await compileCache.completeFile(msg.id, msg.fileName);
            log(`${msg.fileName} complete and cached for ${msg.id}`);
          }
        } catch (error) {
          console.error(`Failed to cache ${msg.fileName} chunk:`, error);
        }
      }
      
      if (msg.type === 'compileError') {
        // Record compilation error
        log(`Compile error for ${msg.id}: ${msg.errorType}`);
        try {
          await compileCache.recordError(msg.id, msg.errorType, msg.message, msg.details);
        } catch (error) {
          console.error('Failed to record compile error:', error);
        }
      }
      
      if (msg.type === 'compileExitStatus') {
        // Record exit status from compilation stage
        log(`Exit status for ${msg.id}: ${msg.stage} = ${msg.exitCode}`);
        try {
          await compileCache.recordExitStatus(msg.id, msg.stage, msg.exitCode);
        } catch (error) {
          console.error('Failed to record exit status:', error);
        }
      }
      
      if (msg.type === 'compileDenied') {
        // Show denial message to user
        log(`Compilation denied: ${msg.reason} - ${msg.message}`);
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

/**
 * Extension deactivation cleanup.
 * Called by VS Code when the extension is deactivated.
 */
export function deactivate() {}

/**
 * Generate a random nonce for Content Security Policy in webview.
 * @returns 16-character random string
 */
function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/**
 * Get the Makerchip server URL from:
 * 1. Local file (.makerchip-server-url in this repo, written by start_cloudflared script)
 * 2. VS Code configuration (makerchip.serverUrl)
 * 
 * Throws an error if no server URL is configured.
 */
async function getServerUrl(): Promise<string> {
  // Check this repo for .makerchip-server-url file (written by (private) `mono` repo's start_cloudflared script)
  const extensionUrlFile = path.join(context.extensionPath, '.makerchip-server-url');
  log(`[getServerUrl] Checking extension directory: ${extensionUrlFile}`);
  try {
    if (fs.existsSync(extensionUrlFile)) {
      const fileUrl = fs.readFileSync(extensionUrlFile, 'utf8').trim();
      log(`[getServerUrl] Found file in extension dir with content: "${fileUrl}"`);
      if (fileUrl && fileUrl.startsWith('http')) {
        log(`Using server URL from extension directory: ${fileUrl}`);
        return fileUrl;
      } else {
        console.warn(`[getServerUrl] File content doesn't start with http: "${fileUrl}"`);
      }
    } else {
      log(`[getServerUrl] File does not exist in extension directory`);
    }
  } catch (error) {
    console.warn(`Failed to read server URL from ${extensionUrlFile}:`, error);
  }
  
  // Check VS Code configuration
  const config = vscode.workspace.getConfiguration('makerchip');
  const configUrl = config.get<string>('serverUrl');
  if (configUrl) {
    log(`Using server URL from configuration: ${configUrl}`);
    return configUrl;
  }
  
  // No server URL found - throw error
  const errorMsg = 'Makerchip server URL not configured. Please set makerchip.serverUrl in settings or run start_cloudflared script.';
  log(`[getServerUrl] ERROR: ${errorMsg}`);
  throw new Error(errorMsg);
}