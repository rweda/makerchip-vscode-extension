// Experimental feature: compile TL-Verilog to Verilog via SandPiper SaaS.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { postSandpiper, asArgList } from './sandpiperClient';
import { createTlvStatusButton } from './statusBar';

export function registerSandpiperCompile(context: vscode.ExtensionContext): void {
  createTlvStatusButton(context, {
    text: '$(rocket) SandPiper',
    tooltip: 'Compile TL-Verilog using SandPiper SaaS',
    command: 'extension.sandpiperSaas',
    priority: 0
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.sandpiperSaas', async () => {
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
        await compileTLVerilogWithSandPiper(document.getText(), document.fileName);
      } catch (error) {
        vscode.window.showErrorMessage(`SandPiper SaaS compilation failed: ${error.message}`);
      }
    })
  );
}

async function compileTLVerilogWithSandPiper(tlvCode: string, inputFilePath: string): Promise<void> {
  const filename = path.basename(inputFilePath);
  const externSettings = asArgList(
    vscode.workspace.getConfiguration('tlverilog').get('formattingSettings')
  );
  const args = `-i ${filename} -o ${filename.replace('.tlv', '.sv')} --m4out out/m4out ${externSettings.join(' ')} --iArgs`;

  try {
    const data = await postSandpiper({ [filename]: tlvCode }, args);

    const outputKey = Object.keys(data).find(
      (key) => key.startsWith('out/') && key.endsWith('.sv')
    );
    const genKey = Object.keys(data).find(
      (key) => key.startsWith('out/') && key.endsWith('_gen.sv')
    );

    if (outputKey && genKey) {
      const verilog = (data[outputKey] as string)
        .replace(
          `\`include "${path.basename(genKey)}"`,
          '// gen included here\n' + data[genKey]
        )
        .split('\n')
        .filter((line) => !line.startsWith('`include "sp_default.vh"'))
        .join('\n');
      const outputDirectory = path.dirname(inputFilePath);
      const outputFilePath = path.join(outputDirectory, path.basename(outputKey));
      const genFilePath = path.join(outputDirectory, path.basename(genKey));

      fs.writeFileSync(outputFilePath, verilog);
      fs.writeFileSync(genFilePath, data[genKey]);

      vscode.window.showInformationMessage(
        `Generated Verilog code saved to ${outputFilePath} and ${genFilePath}`
      );
    } else {
      console.error('Output files not found in response:', data);
      throw new Error('SandPiper SaaS compilation failed: Output files not found in response.');
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
