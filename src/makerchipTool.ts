import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log, showOutputChannel } from './logger';

interface MakerchipToolInput {
  /** Optional file path to open and compile. If not provided, uses the active editor. */
  filePath?: string;
  /** Optional TL-Verilog code to compile. If provided, creates a new unsaved file with this code. */
  code?: string;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

interface IdeFunctionCallInput {
  /** The IDE method to invoke (e.g., 'compile', 'activatePane', 'setCode', etc.) */
  method: string;
  /** Arguments to pass to the IDE method */
  args?: any[];
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
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
      const { method, args = [], panelName } = options.input;
      
      // Invoke the IDE method via command
      await vscode.commands.executeCommand('makerchip.invokeIdeMethod', method, args, panelName);
      
      const panelInfo = panelName ? ` on panel '${panelName}'` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully invoked IDE method '${method}'${panelInfo} with arguments: ${JSON.stringify(args)}`
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
      const { filePath, code, panelName } = options.input;
      
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
      
      // Get the code and invoke IDE directly with panel name
      const sourceCode = editor.document.getText();
      await vscode.commands.executeCommand('makerchip.invokeIdeMethod', 'compile', [sourceCode], panelName);
      
      const fileName = code ? 'example code' : editor.document.fileName;
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully opened Makerchip IDE${panelInfo} and started compiling ${fileName}. ` +
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

interface GetVizImageInput {
  /** Image format: 'png', 'jpeg', or 'webp' (default: 'png') */
  format?: 'png' | 'jpeg' | 'webp';
  /** Image quality for jpeg/webp (0.0-1.0, default: 1.0) */
  quality?: number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
  /** Save to file for user visibility. If true, saves to /tmp. If string, uses as file path. */
  saveToFile?: boolean | string;
}

/**
 * Language Model tool to capture the current VIZ visualization as an image
 */
export class GetVizImageTool implements vscode.LanguageModelTool<GetVizImageInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetVizImageInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { format = 'png' } = options.input;
    return {
      invocationMessage: `Capturing VIZ visualization as ${format.toUpperCase()} image...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetVizImageInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    log('[GetVizImageTool] ========== TOOL INVOKED ==========');
    try {
      const { format = 'png', quality = 1.0, panelName, saveToFile } = options.input;
      log('[GetVizImageTool] Invoked with:', { format, quality, panelName, saveToFile });
      
      // Call the IDE method to get the image
      const imageOptions = { format, quality };
      log('[GetVizImageTool] Calling getVizImage with options:', imageOptions);
      
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'getVizImage', 
        [imageOptions], 
        panelName
      ) as string | null;
      
      log('[GetVizImageTool] Result received:', result ? `data URL (${result.length} chars)` : 'null');
      
      if (!result) {
        log('[GetVizImageTool] No result - VIZ canvas not available');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'VIZ canvas is not available. Make sure you have compiled code with VIZ visualization.'
          )
        ]);
      }
      
      // Extract base64 data from data URL (format: data:image/png;base64,...)
      const base64Match = result.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) {
        log('[GetVizImageTool] Invalid data URL format');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Failed to extract image data from result')
        ]);
      }
      
      const base64Data = base64Match[1];
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const imageBytes = new Uint8Array(imageBuffer);
      
      // Determine MIME type
      const mimeType = `image/${format}`;
      // Panel info for logging
      const panelInfo = panelName ? ` from panel '${panelName}'` : '';
      
      // Optionally save to file for user visibility
      let savedPath: string | undefined;
      if (saveToFile) {
        if (typeof saveToFile === 'string') {
          // Use provided path
          savedPath = saveToFile;
        } else {
          // Auto-generate path in /tmp
          const timestamp = Date.now();
          const filename = `makerchip-viz-${timestamp}.${format}`;
          savedPath = path.join(os.tmpdir(), filename);
        }
        fs.writeFileSync(savedPath, imageBuffer);
        log('[GetVizImageTool] Saved image to file:', savedPath);
      }
      
      // Try to use the proposed API for direct image return
      // LanguageModelToolResult2 and LanguageModelDataPart are proposed APIs
      const LanguageModelToolResult2 = (vscode as any).LanguageModelToolResult2;
      const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;
      
      if (LanguageModelToolResult2 && LanguageModelDataPart && LanguageModelDataPart.image) {
        // Use proposed API to return image directly
        log('[GetVizImageTool] Using proposed API (LanguageModelDataPart) to return image directly');
        try {
          const message = savedPath 
            ? `Successfully captured VIZ visualization${panelInfo} as ${format.toUpperCase()} image (${Math.round(imageBytes.length / 1024)}KB).\nSaved to: ${savedPath}`
            : `Successfully captured VIZ visualization${panelInfo} as ${format.toUpperCase()} image (${Math.round(imageBytes.length / 1024)}KB).`;
          
          return new LanguageModelToolResult2([
            new vscode.LanguageModelTextPart(message),
            LanguageModelDataPart.image(imageBytes, mimeType)
          ]);
        } catch (error) {
          log('[GetVizImageTool] Failed to use proposed API, falling back to file:', error);
        }
      }
      
      // Fallback: Save to file for older VS Code versions (if not already saved)
      if (!savedPath) {
        const timestamp = Date.now();
        const filename = `makerchip-viz-${timestamp}.${format}`;
        savedPath = path.join(os.tmpdir(), filename);
        fs.writeFileSync(savedPath, imageBuffer);
      }
      log('[GetVizImageTool] Proposed API not available, using file fallback:', savedPath);
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully captured VIZ visualization${panelInfo} as ${format.toUpperCase()} image.\n` +
          `Image saved to: ${savedPath}\n` +
          `Size: ${Math.round(imageBuffer.length / 1024)}KB\n\n` +
          `The image file is available for viewing.`
        )
      ]);
      
    } catch (error: any) {
      log('[GetVizImageTool] ERROR:', error);
      log('[GetVizImageTool] Error message:', error?.message);
      log('[GetVizImageTool] Error stack:', error?.stack);
      
      // Check for specific error cases
      if (error?.message?.includes('Method getVizImage not found')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'The getVizImage method is not available. This could mean:\n\n' +
            '1. No Makerchip panel is currently open - open one with Ctrl+Shift+P → "Makerchip: Open Panel"\n' +
            '2. The Makerchip IDE hasn\'t fully loaded yet - wait a moment and try again\n' +
            '3. You\'re using a server that doesn\'t have the getVizImage method yet\n\n' +
            'Try opening a Makerchip panel and compiling a design first.'
          )
        ]);
      }
      
      if (error?.message?.includes('Panel') && error?.message?.includes('not found')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No Makerchip panel is open. Please open one first:\n' +
            'Ctrl+Shift+P → "Makerchip: Open Panel"'
          )
        ]);
      }
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to capture VIZ image: ${error?.message || 'Unknown error'}`
        )
      ]);
    }
  }
}

/**
 * Register the Makerchip tools with the Language Model API
 */
export function registerMakerchipTool(context: vscode.ExtensionContext): void {
  log('========== Registering Makerchip Tools ==========');
  log('vscode.lm available:', !!vscode.lm);
  log('vscode.lm.registerTool available:', !!vscode.lm?.registerTool);
  
  // Register the basic compile/simulate tool
  const runTool = vscode.lm.registerTool('makerchip_compile', new MakerchipTool());
  log('Compile tool registered:', !!runTool);
  context.subscriptions.push(runTool);
  
  // Register the generic IDE method invocation tool
  const ideTool = vscode.lm.registerTool('makerchip_ide_call', new IdeFunctionCallTool());
  log('IDE call tool registered:', !!ideTool);
  context.subscriptions.push(ideTool);
  
  // Register the VIZ image capture tool
  const vizImageTool = vscode.lm.registerTool('makerchip_get_viz_image', new GetVizImageTool());
  log('VIZ image tool registered:', !!vizImageTool);
  context.subscriptions.push(vizImageTool);
  
  // Verify tools are in the list
  setTimeout(() => {
    log('All registered tools:', vscode.lm.tools.map(t => t.name));
    const ourRunTool = vscode.lm.tools.find(t => t.name === 'makerchip_compile');
    const ourIdeTool = vscode.lm.tools.find(t => t.name === 'makerchip_ide_call');
    const ourVizImageTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_viz_image');
    log('Found our compile tool:', !!ourRunTool);
    log('Found our IDE tool:', !!ourIdeTool);
    log('Found our VIZ image tool:', !!ourVizImageTool);
    
    showOutputChannel(); // Show output channel on startup
  }, 1000);
}
