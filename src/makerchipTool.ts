import * as vscode from 'vscode';

interface MakerchipToolInput {
  /** Optional file path to open and compile. If not provided, uses the active editor. */
  filePath?: string;
}

/**
 * Language Model tool that allows Copilot to launch Makerchip IDE
 * and compile TL-Verilog code.
 */
export class MakerchipTool implements vscode.LanguageModelTool<MakerchipToolInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<MakerchipToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const filePath = options.input.filePath;
    
    return {
      invocationMessage: filePath 
        ? `Opening Makerchip IDE for ${filePath}...`
        : 'Opening Makerchip IDE with current file...'
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MakerchipToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const filePath = options.input.filePath;
      
      // If a specific file was requested, open it first
      if (filePath) {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      }
      
      // Check if there's an active editor
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No active file to compile. Please open a TL-Verilog (.tlv) file first.')
        ]);
      }
      
      // Execute the Makerchip run command
      await vscode.commands.executeCommand('makerchip.run');
      
      const fileName = editor.document.fileName;
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully opened Makerchip IDE and started compiling ${fileName}. ` +
          `The Makerchip panel should now be visible beside your editor with the compilation results and diagram visualization.`
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to launch Makerchip: ${error.message}`
        )
      ]);
    }
  }
}

/**
 * Register the Makerchip tool with the Language Model API
 */
export function registerMakerchipTool(context: vscode.ExtensionContext): void {
  console.log('Registering Makerchip tool...');
  console.log('vscode.lm:', vscode.lm);
  console.log('vscode.lm.registerTool:', vscode.lm?.registerTool);
  
  const tool = vscode.lm.registerTool('makerchip_run', new MakerchipTool());
  console.log('Tool registered:', tool);
  context.subscriptions.push(tool);
  
  // Verify tool is in the list
  setTimeout(() => {
    console.log('All registered tools:', vscode.lm.tools);
    const ourTool = vscode.lm.tools.find(t => t.name === 'makerchip_run');
    console.log('Found our tool:', ourTool);
  }, 1000);
}
