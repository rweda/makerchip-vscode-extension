/**
 * Makerchip VS Code Extension - Main activation module
 * 
 * Provides TL-Verilog development support with:
 *   - Makerchip IDE integration via webview panel
 *   - GitHub Copilot Language Model tools (makerchip_run, makerchip_ide_call)
 *   - Chat participant (@makerchip)
 *   - Resource management (clones docs/examples to ~/.vscode-makerchip-resources)
 * 
 * Architecture:
 *   - Global context/panel state for clean API
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

let panel: vscode.WebviewPanel | undefined;
let panelReady: Promise<void> | undefined;
let statusBarItem: vscode.StatusBarItem;
let context: vscode.ExtensionContext;

/**
 * Ensure the Makerchip panel is open and ready to receive messages.
 * @returns Promise that resolves when panel is ready
 */
async function ensurePanelReady(): Promise<void> {
  if (panelReady) {
    // Panel is already open or opening - wait for it
    return panelReady;
  }
  
  if (panel) {
    // Panel exists but ready promise was cleared - just reveal it
    panel.reveal(vscode.ViewColumn.Beside, true);
    return Promise.resolve();
  }
  
  // Open new panel and track the ready promise
  panelReady = openMakerchipPanel();
  return panelReady;
}

/**
 * Call an IDE method, ensuring the panel is open and ready.
 * @param method IDE method name to invoke
 * @param args Arguments to pass to the method
 */
export async function callIDE(method: string, ...args: any[]): Promise<void> {
  await ensurePanelReady();
  panel!.webview.postMessage({ 
    type: 'ide', 
    method, 
    args 
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
    console.error('Failed to initialize Makerchip resources:', error);
  });

  // STATUS BAR BUTTON
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(circuit-board) Run Makerchip";
  statusBarItem.command = 'makerchip.run';
  statusBarItem.tooltip = 'Open Makerchip and compile current file';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // SINGLE RUN COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.run', async () => {

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      const code = editor.document.getText();

      // Call IDE to compile the code
      await callIDE('compile', code);
    })
  );

  // UPDATE RESOURCES COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.updateResources', async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Updating Makerchip resources...',
            cancellable: false
          },
          async () => {
            await updateResources(context);
          }
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to update resources: ${error.message}`);
      }
    })
  );

  // INVOKE IDE METHOD COMMAND (used by Copilot tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.invokeIdeMethod', async (method: string, args: any[] = []) => {
      await callIDE(method, ...args);
    })
  );
}

function openMakerchipPanel(): Promise<void> {
  return new Promise((resolve) => {
    panel = vscode.window.createWebviewPanel(
      'makerchip', 'Makerchip IDE',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

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

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') resolve();   // 🔹 resolve when IDE is ready
      if (msg.type === 'done') vscode.window.showInformationMessage("Makerchip: Compilation finished");
    });

    panel.onDidDispose(() => { 
      panel = undefined;
      panelReady = undefined;  // Clear ready promise so new panel can be created
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