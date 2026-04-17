import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {

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

      // Open panel if not already open
      if (!panel) {
        await openMakerchipPanel(context);
        panel?.webview.postMessage({ type: 'setCode', code });
      } else {
    // Already open — reveal and immediately recompile with new code
    panel.reveal(vscode.ViewColumn.Beside, true); 
    panel.webview.postMessage({ type: 'setCode', code });
  }

      // Small delay to let the webview initialize if freshly opened
      setTimeout(() => {
        panel?.webview.postMessage({ type: 'setCode', code });
      }, panel ? 0 : 1500);
    })
  );
}

function openMakerchipPanel(context: vscode.ExtensionContext): Promise<void> {
  return new Promise((resolve) => {
    panel = vscode.window.createWebviewPanel(
      'makerchip', 'Makerchip IDE',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const nonce = getNonce();

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy"
          content="
            default-src 'none';
            img-src https: data: blob:;
            style-src 'unsafe-inline' https://beta.makerchip.com https://ide-beta.makerchip.com https:;
            script-src 'nonce-${nonce}' https://beta.makerchip.com https://ide-beta.makerchip.com 'unsafe-eval' 'unsafe-inline';
            frame-src https://beta.makerchip.com https://ide-beta.makerchip.com https:;
            connect-src https://beta.makerchip.com https://ide-beta.makerchip.com wss://beta.makerchip.com wss://ide-beta.makerchip.com https:;
            font-src https://beta.makerchip.com https://ide-beta.makerchip.com https:;
            worker-src blob:;
          ">
        <style>
          html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; }
          #my-makerchip { width: 100%; height: 100vh; }
        </style>
      </head>
      <body>
        <div id="my-makerchip"></div>
        <script nonce="${nonce}" type="module">
          const vscode = acquireVsCodeApi();
          import IdePlugin from 'https://beta.makerchip.com/dist/makerchip-plugin.js';

          class VSCodeMakerchip extends IdePlugin {
            onReady() {
              console.log("Makerchip ready");
              this.activatePane("Diagram");
              vscode.postMessage({ type: 'ready' });   // 🔹 notify extension
            }
            onCompilationLog(id, log, complete, type) {
              vscode.postMessage({ type: 'log', value: log });
              if (complete) vscode.postMessage({ type: 'done', value: log });
            }
            onCompilationVcd(id, vcd) {
              vscode.postMessage({ type: 'vcd', value: vcd });
            }
          }

          const ide = await new VSCodeMakerchip('my-makerchip', { hasEditor: false });

          window.addEventListener('message', async (event) => {
            const msg = event.data;
            if (msg.type === 'setCode') {
              await ide.compile(msg.code);
            }
          });
        </script>
      </body>
      </html>
    `;

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') resolve();   // 🔹 resolve when IDE is ready
      if (msg.type === 'done') vscode.window.showInformationMessage("Makerchip: Compilation finished");
    });

    panel.onDidDispose(() => { panel = undefined; });
  });
}

export function deactivate() {}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}