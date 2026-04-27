import * as vscode from 'vscode';

interface MakerchipToolInput {
  /** Optional file path to open and compile. If not provided, uses the active editor. */
  filePath?: string;
  /** Optional TL-Verilog code to compile. If provided, creates a new unsaved file with this code. */
  code?: string;
}

interface IdeFunctionCallInput {
  /** The IDE method to invoke (e.g., 'compile', 'activatePane', 'setCode', etc.) */
  method: string;
  /** Arguments to pass to the IDE method */
  args?: any[];
}

/**
 * Helper function to send IDE method invocation to the Makerchip webview panel
 * @param method The IDE method name to invoke
 * @param args Arguments to pass to the method
 * @returns Promise that resolves when the message is sent
 */
export async function invokeIdeMethod(method: string, args: any[] = []): Promise<void> {
  // Find the Makerchip panel
  // Note: This assumes the panel is stored globally. In a real implementation,
  // you might need to export the panel variable from extension.ts
  await vscode.commands.executeCommand('makerchip.invokeIdeMethod', method, args);
}

/**
 * Generic Language Model tool for invoking any IDE method
 */
export class IdeFunctionCallTool implements vscode.LanguageModelTool<IdeFunctionCallInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IdeFunctionCallInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { method, args = [] } = options.input;
    
    return {
      invocationMessage: `Calling IDE method '${method}' with ${args.length} argument(s)...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IdeFunctionCallInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { method, args = [] } = options.input;
      
      // Invoke the IDE method via command
      await vscode.commands.executeCommand('makerchip.invokeIdeMethod', method, args);
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully invoked IDE method '${method}' with arguments: ${JSON.stringify(args)}`
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to invoke IDE method: ${error.message}`
        )
      ]);
    }
  }
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
    const { filePath, code } = options.input;
    
    if (code) {
      return { invocationMessage: 'Opening example code in Makerchip IDE...' };
    } else if (filePath) {
      return { invocationMessage: `Opening Makerchip IDE for ${filePath}...` };
    } else {
      return { invocationMessage: 'Opening Makerchip IDE with current file...' };
    }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MakerchipToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { filePath, code } = options.input;
      
      // If code is provided, create a new unsaved document with it
      if (code) {
        const doc = await vscode.workspace.openTextDocument({
          content: code,
          language: 'tlv'
        });
        await vscode.window.showTextDocument(doc);
      }
      // If a specific file was requested, open it first
      else if (filePath) {
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
      
      const fileName = code ? 'example code' : editor.document.fileName;
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
 * Register the Makerchip tools with the Language Model API
 */
export function registerMakerchipTool(context: vscode.ExtensionContext): void {
  console.log('Registering Makerchip tools...');
  console.log('vscode.lm:', vscode.lm);
  console.log('vscode.lm.registerTool:', vscode.lm?.registerTool);
  
  // Register the basic run tool
  const runTool = vscode.lm.registerTool('makerchip_run', new MakerchipTool());
  console.log('Run tool registered:', runTool);
  context.subscriptions.push(runTool);
  
  // Register the generic IDE method invocation tool
  const ideTool = vscode.lm.registerTool('makerchip_ide_call', new IdeFunctionCallTool());
  console.log('IDE call tool registered:', ideTool);
  context.subscriptions.push(ideTool);
  
  // Verify tools are in the list
  setTimeout(() => {
    console.log('All registered tools:', vscode.lm.tools);
    const ourRunTool = vscode.lm.tools.find(t => t.name === 'makerchip_run');
    const ourIdeTool = vscode.lm.tools.find(t => t.name === 'makerchip_ide_call');
    console.log('Found our run tool:', ourRunTool);
    console.log('Found our IDE tool:', ourIdeTool);
  }, 1000);
}
