// Experimental feature: generate and view a TL-Verilog diagram (SVG) via SandPiper SaaS.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { postSandpiper, asArgList } from './sandpiperClient';
import { createTlvStatusButton } from './statusBar';

export function registerDiagram(context: vscode.ExtensionContext): void {
  createTlvStatusButton(context, {
    text: '$(file-media) SVG',
    tooltip: 'Generate and view TL-Verilog SVG diagram',
    command: 'extension.showSvg',
    priority: 1
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.showSvg', async () => {
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
        const svgFilePath = await generateSvgFile(document.getText(), document.fileName);
        showSvgInWebview(svgFilePath);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate SVG: ${error.message}`);
      }
    })
  );
}

async function generateSvgFile(tlvCode: string, inputFilePath: string): Promise<string> {
  const filename = path.basename(inputFilePath);
  const externSettings = asArgList(
    vscode.workspace.getConfiguration('tlverilog').get('formattingSettings')
  );
  const args = `-i ${filename} --graphTrans --svg ${externSettings.join(' ')} --iArgs`;

  try {
    const data = await postSandpiper({ [filename]: tlvCode }, args);
    const svgOutputKeyM4 = `out/${filename.replace('.tlv', '.m4out_graph.svg')}`;
    const svgOutputKeyM5 = `out/${filename.replace('.tlv', '.m5out_graph.svg')}`;
    const svgOutputKey = data[svgOutputKeyM5] ? svgOutputKeyM5 : svgOutputKeyM4;
    if (data[svgOutputKey]) {
      const svgContent = data[svgOutputKey];
      const outputDirectory = path.dirname(inputFilePath);
      const svgFilePath = path.join(
        outputDirectory,
        `${path.basename(filename, '.tlv')}_diagram.svg`
      );
      fs.writeFileSync(svgFilePath, svgContent);
      return svgFilePath;
    } else {
      throw new Error('SandPiper SaaS compilation failed: No SVG output generated.');
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

function showSvgInWebview(svgFilePath: string) {
  const panel = vscode.window.createWebviewPanel(
    'svgViewer',
    'TL-Verilog SVG Viewer',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const svg = fs.readFileSync(svgFilePath, 'utf8');
  const webviewContent = `
       <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sandpiper Diagram Viewer</title>
        <style>
            body { 
                margin: 0; 
                padding: 0;
                height: 100vh;
                display: flex;
                flex-direction: column;
                background-color: #f0f0f0;
            }
            .controls-container {
                position: fixed;
                top: 10px;
                right: 10px;
                z-index: 1000;
            }
            .zoom-controls {
                display: flex;
                flex-direction: column;
                background-color: white;
                border-radius: 4px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            .zoom-button {
                padding: 5px 10px;
                font-size: 18px;
                cursor: pointer;
                border: none;
                background-color: transparent;
            }
            .zoom-button:hover {
                background-color: #f0f0f0;
            }
            .zoom-reset {
                border-top: 1px solid #ccc;
                font-size: 14px;
            }
            .svg-container {
                flex: 1;
                display: flex;
                justify-content: center;
                align-items: center;
                overflow: hidden;
            }
            svg { 
                max-width: 100%; 
                max-height: 100%; 
                border: 1px solid #ccc; 
                background-color: white;
            }
        </style>
    </head>
    <body>
        <div class="controls-container">
            <div class="zoom-controls">
                <button class="zoom-button" onclick="zoomIn()">+</button>
                <button class="zoom-button" onclick="zoomOut()">-</button>
                <button class="zoom-button zoom-reset" onclick="resetZoom()">RESET</button>
            </div>
        </div>
        <div class="svg-container" id="svg-container">
            ${svg}
        </div>
    
        <script>
        let currentZoom = 1;
        const svgContainer = document.getElementById('svg-container');
        const svg = svgContainer.querySelector('svg');
    
        function zoomIn() {
            currentZoom *= 1.2;
            updateZoom();
        }
    
        function zoomOut() {
            currentZoom /= 1.2;
            updateZoom();
        }
    
        function resetZoom() {
            currentZoom = 1;
            updateZoom();
        }
    
        function updateZoom() {
            svg.style.transform = \`scale(\${currentZoom})\`;
        }
        </script>
    </body>
    </html>
    `;

  panel.webview.html = webviewContent;
}
