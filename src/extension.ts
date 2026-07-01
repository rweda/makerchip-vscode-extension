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

// Default Makerchip server URL
const DEFAULT_SERVER_URL = 'https://beta.makerchip.com';

// How long to wait for a newly opened panel's webview to signal readiness
// before rejecting. Without this, a webview that fails to load (e.g. plugin
// import failure, or a startup race with VS Code) leaves the ready promise
// pending forever, hanging every awaiting caller.
const READY_TIMEOUT_MS = 30_000;

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
 * @param createIfNeeded If true, creates a new panel if it doesn't exist. If false, throws error.
 * @returns Promise that resolves when panel is ready
 */
async function ensurePanelReady(name?: string, createIfNeeded: boolean = false): Promise<void> {
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
  
  // Panel doesn't exist
  if (!createIfNeeded) {
    const availablePanels = Array.from(panels.keys());
    const panelList = availablePanels.length > 0 ? availablePanels.join(', ') : 'none';
    throw new Error(`Makerchip panel '${panelKey}' is not open. Available panels: ${panelList}. Use makerchip_compile to open a new panel.`);
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
 * @param createIfNeeded If true, creates panel if it doesn't exist. Default false.
 */
export async function callIDE(method: string, args?: any[], panelName?: string, createIfNeeded: boolean = false): Promise<void> {
  const name = panelName || 'default';
  await ensurePanelReady(name, createIfNeeded);
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
    log(`Makerchip Server: ${url}`);
  }).catch(error => {
    log(`⚠ Makerchip server not configured. Panels will not open.`);
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

      // Call IDE to compile the code (default panel, creating it if needed)
      await callIDE('compile', [code], 'default', true);
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
      await callIDE('compile', [code], panelName, true);
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
      await callIDE('compile', [code], panelName, true);
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
    vscode.commands.registerCommand('makerchip.invokeIdeMethod', async (method: string, args: any[] = [], panelName?: string, createIfNeeded: boolean = false) => {
      await callIDE(method, args, panelName, createIfNeeded);
    })
  );

  // INVOKE IDE METHOD AND RETURN RESULT (used by tools that need return values)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.callIdeMethodWithResult', async (method: string, args: any[] = [], panelName?: string, createIfNeeded: boolean = false): Promise<any> => {
      const name = panelName || 'default';
      //log(`[callIdeMethodWithResult] Calling '${method}' on panel '${name}' with args:`, args);
      
      await ensurePanelReady(name, createIfNeeded);
      const panel = panels.get(name);
      if (!panel) {
        console.error(`[callIdeMethodWithResult] Panel '${name}' not found`);
        throw new Error(`Panel '${name}' not found`);
      }
      
      // Generate unique request ID
      const requestId = `req_${++requestCounter}`;
      
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

  // GET PANEL NAMES COMMAND (for tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.getPanelNames', async (): Promise<string[]> => {
      return Array.from(panels.keys());
    })
  );

  // HIGHLIGHT ENTITY COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.highlight', async () => {
      const id = await vscode.window.showInputBox({
        prompt: 'Enter TL-Verilog path to highlight',
        placeHolder: 'e.g., /cpu|my_pipe$data, |fetch@1, /cpu',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Path cannot be empty';
          }
          return null;
        }
      });
      
      if (id) {
        await callIDE('highlight', [id.trim(), false]);
        vscode.window.showInformationMessage(`Highlighted: ${id.trim()}`);
      }
    })
  );

  // CLEAR HIGHLIGHTS COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.clearHighlights', async () => {
      await callIDE('clearHighlights', []);
      vscode.window.showInformationMessage('Cleared all highlights');
    })
  );

  // To debug webviews: Help > Toggle Developer Tools, then inspect the webview <iframe> element
}

/**
 * Open a new Makerchip webview panel and initialize it with the IDE.
 * Sets up message handlers for compilation results, errors, and IDE communication.
 * @param panelKey Unique identifier for this panel instance
 * @returns Promise that resolves when the IDE is ready
 */
async function openMakerchipPanel(panelKey: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // Guard so the promise settles exactly once, and a timeout guards against
    // a webview that never signals readiness.
    let settled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearReadyTimeout = () => {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
    };

    const settleResolve = () => {
      if (settled) { return; }
      settled = true;
      clearReadyTimeout();
      resolve();
    };

    // Reject the ready promise and tear down the panel so a later call can
    // retry with a clean slate. Disposing triggers onDidDispose, which cleans
    // up the tracking maps.
    const settleReject = (err: Error) => {
      if (settled) { return; }
      settled = true;
      clearReadyTimeout();
      panelReadyPromises.delete(panelKey);
      const existing = panels.get(panelKey);
      if (existing) {
        existing.dispose();
      }
      reject(err);
    };

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
      log(`Opening ${displayName}...`);
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to get server URL';
      vscode.window.showErrorMessage(errorMsg);
      settleReject(error instanceof Error ? error : new Error(errorMsg));
      return;
    }
    
    // Get webview URI for the script file
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.js')
    );

    // Detect VS Code theme to match Makerchip IDE dark mode
    const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
                        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

    // Load HTML template and replace placeholders
    const htmlPath = path.join(context.extensionPath, 'out', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{scriptUri}}/g, scriptUri.toString());
    html = html.replace(/{{serverUrl}}/g, serverUrl);
    html = html.replace(/{{defaultDarkMode}}/g, isDarkTheme.toString());
    
    panel.webview.html = html;

    // Arm the readiness timeout. If the webview never posts 'ready' (e.g. the
    // plugin failed to load, or activation raced VS Code startup), reject so
    // callers surface an error instead of hanging indefinitely.
    readyTimeout = setTimeout(() => {
      settleReject(new Error(
        `Makerchip panel '${panelKey}' did not become ready within ${READY_TIMEOUT_MS / 1000}s. ` +
        `Check the server connection (${serverUrl}) and try again.`
      ));
    }, READY_TIMEOUT_MS);

    // Handle messages from webview: IDE ready state, compilation results, errors, and method responses
    panel.webview.onDidReceiveMessage(async (msg) => {
      // Only log message type, not the entire payload (which can be huge for VCD data)
      if (msg.type !== 'compileFileChunk') {
        log(`[webview → extension] ${msg.type}`);
      }
      
      if (msg.type === 'ready') {
        log(`✓ Connected to ${serverUrl}`);
        settleResolve();   // 🔹 resolve when IDE is ready
      }

      if (msg.type === 'initError') {
        // Webview reported an initialization failure - reject now rather than
        // waiting for the ready timeout.
        settleReject(new Error(`Makerchip webview failed to initialize: ${msg.error}`));
      }
      
      if (msg.type === 'notification') {
        // Generic notification message (info/warning/error)
        log(`[${msg.severity.toUpperCase()}] ${msg.message}`);
        
        if (msg.severity === 'error') {
          vscode.window.showErrorMessage(msg.message);
        } else if (msg.severity === 'warning') {
          vscode.window.showWarningMessage(msg.message);
        } else if (msg.severity === 'info') {
          vscode.window.showInformationMessage(msg.message);
        }
      }
      
      if (msg.type === 'ideResult') {
        //log(`[ideResult] Received:`, { method: msg.method, requestId: msg.requestId, hasResult: !!msg.result });
        
        // Check if this is a response to a pending request
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          //log(`[ideResult] Resolving pending request: ${msg.requestId}`);
          const { resolve: resolveResult } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          resolveResult(msg.result);
        } else if (msg.requestId) {
          console.warn(`[ideResult] Received result for unknown request ID: ${msg.requestId}`);
        }
        
        // Also handle compile ID initialization for cache
        if (msg.method === 'compile' && msg.result) {
          log(`Compile started: ${msg.result}`);
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
        console.error(`[ideError] ${msg.method}: ${msg.error}`);
        
        // Check if this is a response to a pending request
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          //log(`[ideError] Rejecting pending request: ${msg.requestId}`);
          const { reject } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          reject(new Error(msg.error));
        } else if (msg.requestId) {
          console.warn(`[ideError] Received error for unknown request ID: ${msg.requestId}`);
        }
      }
      
      if (msg.type === 'compileFileChunk') {
        // Cache compilation result file chunks (stdall, make.out, or vlt_dump.vcd)
        try {
          await compileCache.appendFile(msg.id, msg.fileName, msg.chunk);
          if (msg.complete) {
            await compileCache.completeFile(msg.id, msg.fileName);
            log(`✓ ${msg.fileName} complete`);
          }
        } catch (error) {
          console.error(`Failed to cache ${msg.fileName} chunk:`, error);
        }
      }
      
      if (msg.type === 'compileError') {
        // Record compilation error
        log(`Compile error: ${msg.errorType}`);
        try {
          await compileCache.recordError(msg.id, msg.errorType, msg.message, msg.details);
        } catch (error) {
          console.error('Failed to record compile error:', error);
        }
      }
      
      if (msg.type === 'compileExitStatus') {
        // Record exit status from compilation stage
        log(`${msg.stage} exit: ${msg.exitCode}`);
        try {
          await compileCache.recordExitStatus(msg.id, msg.stage, msg.exitCode);
        } catch (error) {
          console.error('Failed to record exit status:', error);
        }
      }
      
      if (msg.type === 'compileDenied') {
        // Show denial message to user
        log(`Compilation denied: ${msg.reason}`);
        const retryMsg = msg.retryAfterSeconds ? ` Retry after ${msg.retryAfterSeconds} seconds.` : '';
        vscode.window.showWarningMessage(`Compilation denied: ${msg.message}${retryMsg}`);
      }
    });

    panel.onDidDispose(() => { 
      clearReadyTimeout();
      // If the panel is closed before it ever became ready, reject any pending
      // waiter so it doesn't hang.
      if (!settled) {
        settled = true;
        reject(new Error(`Makerchip panel '${panelKey}' was closed before it became ready.`));
      }
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
 * 1. Tunnel state file (ACTIVE_TUNNEL in extension directory, created by ./launch script)
 * 2. VS Code configuration (makerchip.serverUrl)
 * 3. Default: DEFAULT_SERVER_URL
 */
async function getServerUrl(): Promise<string> {
  // Check tunnel state file (created by ./launch script)
  const tunnelStatePath = path.join(__dirname, '..', 'ACTIVE_TUNNEL');
  if (fs.existsSync(tunnelStatePath)) {
    try {
      const stateContent = fs.readFileSync(tunnelStatePath, 'utf8');
      const tunnelUrl = stateContent.match(/TUNNEL_URL=(.+)/)?.[1];
      if (tunnelUrl && tunnelUrl.startsWith('http')) {
        log(`Using server URL from tunnel state: ${tunnelUrl}`);
        return tunnelUrl;
      }
    } catch (err) {
      log(`Warning: Failed to read tunnel state file: ${err}`);
    }
  }
  
  // Check VS Code configuration
  const config = vscode.workspace.getConfiguration('makerchip');
  const configUrl = config.get<string>('serverUrl');
  if (configUrl) {
    log(`Using server URL from configuration: ${configUrl}`);
    return configUrl;
  }
  
  // Use default
  log(`Using default server URL: ${DEFAULT_SERVER_URL}`);
  return DEFAULT_SERVER_URL;
}