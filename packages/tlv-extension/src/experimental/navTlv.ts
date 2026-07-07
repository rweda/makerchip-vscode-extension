// Experimental feature: generate and view the Nav-TLV HTML view via SandPiper SaaS.
import * as vscode from 'vscode';
import * as path from 'path';
import axios from 'axios';
import { postSandpiper, asArgList } from './sandpiperClient';
import { createTlvStatusButton } from './statusBar';

export function registerNavTlv(context: vscode.ExtensionContext): void {
  createTlvStatusButton(context, {
    text: '$(list-tree) Nav TLV',
    tooltip: 'Open Nav TLV Viewer',
    command: 'extension.showNavTlv',
    priority: 3
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.showNavTlv', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active text editor found.');
        return;
      }
      const document = editor.document;
      if (document.languageId !== 'tlverilog') {
        vscode.window.showInformationMessage('The active file is not a TL-Verilog file.');
        return;
      }
      try {
        const navTlvHtml = await generateNavTlvHtml(document.getText(), document.fileName);
        showNavTlvInWebview(navTlvHtml);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate Nav TLV: ${error.message}`);
      }
    })
  );
}

async function generateNavTlvHtml(tlvCode: string, inputFilePath: string): Promise<string> {
  const externSettings = asArgList(
    vscode.workspace.getConfiguration('tlverilog').get('formattingSettings')
  );
  const filename = path.basename(inputFilePath);
  const args = `-i ${filename} -o gene.sv --dhtml ${externSettings.join(' ')} --iArgs`;

  try {
    const data = await postSandpiper({ [filename]: tlvCode }, args);
    const htmlOutputKeyM4 = `out/${filename.replace('.tlv', '.m4out.html')}`;
    const htmlOutputKeyM5 = `out/${filename.replace('.tlv', '.m5out.html')}`;
    const htmlOutputKey = data[htmlOutputKeyM5] ? htmlOutputKeyM5 : htmlOutputKeyM4;
    if (data[htmlOutputKey]) {
      return data[htmlOutputKey];
    } else {
      throw new Error('SandPiper SaaS compilation failed: No HTML output generated.');
    }
  } catch (error) {
    let errorMessage = 'SandPiper SaaS compilation failed: ';
    if (axios.isAxiosError(error)) {
      errorMessage += error.message;
    } else {
      errorMessage += error;
    }
    vscode.window.showErrorMessage(errorMessage);
    throw new Error(errorMessage);
  }
}

function showNavTlvInWebview(navTlvHtml: string) {
  const panel = vscode.window.createWebviewPanel(
    'navTlvViewer',
    'Nav TLV Viewer',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const modifiedHtml = `
          <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Nav TLV Viewer</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    background-color: white;
                    margin: 0;
                    padding: 20px;
                }
                .nav-tlv-content { 
                    white-space: pre; 
                    font-family: monospace; 
                    background-color: white;
                }
            </style>
        </head>
        <body>
            <div class="nav-tlv-content">${navTlvHtml}</div>
            <script>
                // You can add any necessary JavaScript here
            </script>
        </body>
        </html>
    `;

  panel.webview.html = modifiedHtml;
}
