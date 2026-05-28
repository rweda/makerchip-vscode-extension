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

interface GetAvailablePanesInput {
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to get all available pane mnemonics
 */
export class GetAvailablePanesTool implements vscode.LanguageModelTool<GetAvailablePanesInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetAvailablePanesInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Getting available panes...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetAvailablePanesInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { panelName } = options.input;
      
      // Call the IDE method to get available panes
      const panes = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'getAvailablePanes', 
        [], 
        panelName
      ) as Array<{mnemonic: string, displayName: string, description: string, isStatic: boolean, isThirdParty: boolean, available: boolean, contentType?: string}>;
      
      if (!panes || panes.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No panes available')
        ]);
      }
      
      // Format the output
      const mainPanes = panes.filter(p => !p.isStatic && !p.isThirdParty);
      const staticPanes = panes.filter(p => p.isStatic);
      const thirdPartyPanes = panes.filter(p => p.isThirdParty);
      
      let result = '**Available Panes:**\n\n';
      
      if (mainPanes.length > 0) {
        result += '**Main IDE Panes:**\n';
        for (const pane of mainPanes) {
          const status = pane.available ? '' : ' *(not available in this instance)*';
          result += `- **${pane.mnemonic}**${status}: ${pane.description}\n`;
        }
        result += '\n';
      }
      
      if (staticPanes.length > 0) {
        result += '**Static Panes (tutorials, docs, etc.):**\n';
        for (const pane of staticPanes) {
          result += `- **${pane.mnemonic}**: ${pane.description}\n`;
        }
        result += '\n';
      }
      
      if (thirdPartyPanes.length > 0) {
        result += '**Third-Party Panes:**\n';
        for (const pane of thirdPartyPanes) {
          const contentInfo = pane.contentType ? ` (${pane.contentType})` : '';
          result += `- **${pane.mnemonic}**${contentInfo}: ${pane.description}\n`;
        }
      }
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(result)
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to get available panes: ${error.message}`
        )
      ]);
    }
  }
}

/**
 * Third-party pane object stored inline in the panes array (recoverable panes only).
 * Non-recoverable third-party panes are stored as simple strings (mnemonics).
 */
interface ThirdPartyPaneObject {
  mnemonic: string;      // Tab title
  contentType: string;   // "pdf" or "iframe"
  contentParams: {
    contentUrl: string;
    // Future pane-specific parameters would go here
    // NOTE: Properties must maintain consistent ordering for state comparison
  };
}

/**
 * Layout state structure matching Makerchip IDE's FlexSplit/TabbedView hierarchy.
 * Pane ordering is preserved. Panes array contains mixed types:
 * - Strings: static panes or non-recoverable third-party panes (mnemonic only)
 * - Objects: recoverable third-party panes (with full creation data)
 */
interface LayoutState {
  // TabbedView state (leaf nodes)
  panes?: Array<string | ThirdPartyPaneObject>;  // Mixed types preserve ordering
  activePane?: string | null;
  path?: string;  // Optional path for restoration
  
  // FlexSplit state (container nodes)
  sides?: {
    left?: LayoutState;
    right?: LayoutState;
    top?: LayoutState;
    bottom?: LayoutState;
  };
  splitAt?: number;  // Split position (0.0-1.0)
}

interface GetLayoutStateInput {
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
  /**
   * If true, include third-party panes in the state for cross-instance recovery.
   * If false (default), exclude third-party panes (useful for same-instance rearrangement).
   * @default false
   */
  forTransfer?: boolean;
}

/**
 * Language Model tool to get the current IDE layout state
 */
export class GetLayoutStateTool implements vscode.LanguageModelTool<GetLayoutStateInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetLayoutStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { panelName } = options.input;
    const panelInfo = panelName ? ` from panel '${panelName}'` : '';
    return {
      invocationMessage: `Getting IDE layout state${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetLayoutStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { panelName, forTransfer } = options.input;
      
      // Call the IDE method to get the layout state
      const state = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'getLayoutState', 
        [{ forTransfer: forTransfer ?? false }],  // Pass forTransfer option
        panelName
      ) as LayoutState;
      
      const panelInfo = panelName ? ` from panel '${panelName}'` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully retrieved IDE layout state${panelInfo}:\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to get layout state: ${error.message}`
        )
      ]);
    }
  }
}

interface SetLayoutStateInput {
  /** The layout state object to restore (matches FlexSplit/TabbedView structure) */
  state: LayoutState;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to set/restore the IDE layout state
 */
export class SetLayoutStateTool implements vscode.LanguageModelTool<SetLayoutStateInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SetLayoutStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { panelName } = options.input;
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    return {
      invocationMessage: `Restoring IDE layout${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetLayoutStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { state, panelName } = options.input;
      
      if (!state) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No layout state provided')
        ]);
      }
      
      // Call the IDE method to set the layout state
      await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'setLayoutState', 
        [state], 
        panelName
      );
      
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully restored IDE layout${panelInfo}`
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to set layout state: ${error.message}`
        )
      ]);
    }
  }
}

interface OpenPaneInput {
  /** The mnemonic (unique identifier) of the pane to open or activate */
  mnemonic: string;
  /** If true, open in background without activating. Default is false (activate). */
  background?: boolean;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to open or activate an IDE pane by mnemonic
 */
interface OpenThirdPartyPaneInput {
  /** The display name for the pane (used as tab label). Will be uniquified if needed. */
  mnemonic: string;
  /** Content type: "pdf" for PDF viewer or "iframe" for embedded web content */
  contentType: 'pdf' | 'iframe';
  /** Content parameters - must include contentUrl */
  contentParams: {
    /** URL to the content (PDF file or web page). Supports https://, http://, file://, data URIs, etc. */
    contentUrl: string;
  };
  /** Optional settings for the pane */
  options?: {
    /** If true, don't activate the pane immediately (default: false) */
    background?: boolean;
    /** If true, pane data won't be stored for layout recovery (default: false) */
    nonTransferrable?: boolean;
  };
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

export class OpenPaneTool implements vscode.LanguageModelTool<OpenPaneInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<OpenPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { mnemonic, background, panelName } = options.input;
    const action = background ? 'Opening' : 'Opening and activating';
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    return {
      invocationMessage: `${action} pane '${mnemonic}'${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OpenPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, background = false, panelName } = options.input;
      
      if (!mnemonic) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No pane mnemonic provided')
        ]);
      }
      
      // Call the IDE method to open the pane and get the result
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'openPane', 
        [mnemonic, background], 
        panelName
      ) as any;
      
      // Check if the pane was actually opened (result should be a pane object, not null)
      if (!result) {
        // Get available panes to show in error message
        const availablePanes = await vscode.commands.executeCommand(
          'makerchip.callIdeMethodWithResult',
          'getAvailablePanes',
          [],
          panelName
        ) as any[];
        
        let errorMessage = `Pane '${mnemonic}' not found.\n\nAvailable panes:`;
        if (availablePanes && availablePanes.length > 0) {
          for (const pane of availablePanes) {
            const status = pane.available ? '✓' : '✗';
            const desc = pane.description ? ` - ${pane.description}` : '';
            errorMessage += `\n  ${status} '${pane.mnemonic}'${desc}`;
          }
        } else {
          errorMessage += '\n  (No panes available)';
        }
        
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(errorMessage)
        ]);
      }
      
      const action = background ? 'opened' : 'opened and activated';
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully ${action} pane '${mnemonic}'${panelInfo}`
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to open pane: ${error.message}`
        )
      ]);
    }
  }
}

/**
 * Language Model tool to open third-party panes (PDFs, iframes) in the IDE
 */
export class OpenThirdPartyPaneTool implements vscode.LanguageModelTool<OpenThirdPartyPaneInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<OpenThirdPartyPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { mnemonic, contentType, panelName } = options.input;
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    return {
      invocationMessage: `Opening ${contentType} pane '${mnemonic}'${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OpenThirdPartyPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, contentType, contentParams, options: paneOptions, panelName } = options.input;
      
      if (!mnemonic) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No pane mnemonic provided')
        ]);
      }
      
      if (!contentType || (contentType !== 'pdf' && contentType !== 'iframe')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid contentType. Must be "pdf" or "iframe"')
        ]);
      }
      
      if (!contentParams || !contentParams.contentUrl) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('contentParams.contentUrl is required')
        ]);
      }
      
      // Call the IDE method to open the third-party pane
      const actualMnemonic = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'openThirdPartyPane', 
        [mnemonic, contentType, contentParams, paneOptions || {}], 
        panelName
      ) as string;
      
      const action = paneOptions?.background ? 'opened' : 'opened and activated';
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const uniquified = actualMnemonic !== mnemonic ? ` (uniquified to '${actualMnemonic}')` : '';
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully ${action} ${contentType} pane '${mnemonic}'${uniquified}${panelInfo}`
        )
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to open third-party pane: ${error.message}`
        )
      ]);
    }
  }
}

interface UpdatePlayStateInput {
  /** Whether to start (true) or stop (false) waveform playback */
  isPlaying: boolean;
  /** Optional delay in milliseconds between cycles. If not provided, keeps current timeout (default 1000ms). */
  cycleTimeout?: number;
  /** Optional starting cycle. If provided, jumps to this cycle before starting playback. */
  startCyc?: number;
  /** Optional ending cycle. If provided, playback stops at this cycle; otherwise plays to end of waveform. */
  endCyc?: number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to control waveform playback in the IDE
 */
export class UpdatePlayStateTool implements vscode.LanguageModelTool<UpdatePlayStateInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<UpdatePlayStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { isPlaying, cycleTimeout, startCyc, endCyc, panelName } = options.input;
    
    let message = isPlaying ? 'Starting' : 'Stopping';
    message += ' waveform playback';
    
    if (isPlaying && startCyc !== undefined) {
      message += ` from cycle ${startCyc}`;
    }
    
    if (isPlaying && endCyc !== undefined) {
      message += ` to cycle ${endCyc}`;
    }
    
    if (isPlaying && cycleTimeout !== undefined) {
      message += ` at ${cycleTimeout}ms per cycle`;
    }
    
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    message += panelInfo + '...';
    
    return { invocationMessage: message };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<UpdatePlayStateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { isPlaying, cycleTimeout, startCyc, endCyc, panelName } = options.input;
      
      // Call the IDE method
      await vscode.commands.executeCommand(
        'makerchip.invokeIdeMethod',
        'updatePlayState',
        [isPlaying, cycleTimeout, startCyc, endCyc],
        panelName
      );
      
      // Build success message
      let message = isPlaying ? 'Started' : 'Stopped';
      message += ' waveform playback';
      
      if (isPlaying && startCyc !== undefined) {
        message += ` from cycle ${startCyc}`;
      }
      
      if (isPlaying && endCyc !== undefined) {
        message += ` to cycle ${endCyc}`;
      } else if (isPlaying) {
        message += ' to end of waveform';
      }
      
      if (isPlaying && cycleTimeout !== undefined) {
        message += ` at ${cycleTimeout}ms per cycle`;
      }
      
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message + panelInfo)
      ]);
      
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to update play state: ${error.message}`
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
  
  // Register the get layout state tool
  const getLayoutTool = vscode.lm.registerTool('makerchip_get_layout_state', new GetLayoutStateTool());
  log('Get layout state tool registered:', !!getLayoutTool);
  context.subscriptions.push(getLayoutTool);
  
  // Register the set layout state tool
  const setLayoutTool = vscode.lm.registerTool('makerchip_set_layout_state', new SetLayoutStateTool());
  log('Set layout state tool registered:', !!setLayoutTool);
  context.subscriptions.push(setLayoutTool);
  
  // Register the get available panes tool
  const availablePanesTool = vscode.lm.registerTool('makerchip_get_available_panes', new GetAvailablePanesTool());
  log('Get available panes tool registered:', !!availablePanesTool);
  context.subscriptions.push(availablePanesTool);
  
  // Register the open pane tool
  const openPaneTool = vscode.lm.registerTool('makerchip_open_pane', new OpenPaneTool());
  log('Open pane tool registered:', !!openPaneTool);
  context.subscriptions.push(openPaneTool);
  
  // Register the open third-party pane tool
  const openThirdPartyPaneTool = vscode.lm.registerTool('makerchip_open_third_party_pane', new OpenThirdPartyPaneTool());
  log('Open third-party pane tool registered:', !!openThirdPartyPaneTool);
  context.subscriptions.push(openThirdPartyPaneTool);
  
  // Register the update play state tool
  const updatePlayStateTool = vscode.lm.registerTool('makerchip_update_play_state', new UpdatePlayStateTool());
  log('Update play state tool registered:', !!updatePlayStateTool);
  context.subscriptions.push(updatePlayStateTool);
  
  // Verify tools are in the list
  setTimeout(() => {
    log('All registered tools:', vscode.lm.tools.map(t => t.name));
    const ourRunTool = vscode.lm.tools.find(t => t.name === 'makerchip_compile');
    const ourIdeTool = vscode.lm.tools.find(t => t.name === 'makerchip_ide_call');
    const ourVizImageTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_viz_image');
    const ourGetLayoutTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_layout_state');
    const ourSetLayoutTool = vscode.lm.tools.find(t => t.name === 'makerchip_set_layout_state');
    const ourAvailablePanesTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_available_panes');
    const ourOpenPaneTool = vscode.lm.tools.find(t => t.name === 'makerchip_open_pane');
    const ourOpenThirdPartyPaneTool = vscode.lm.tools.find(t => t.name === 'makerchip_open_third_party_pane');
    const ourUpdatePlayStateTool = vscode.lm.tools.find(t => t.name === 'makerchip_update_play_state');
    log('Found our compile tool:', !!ourRunTool);
    log('Found our IDE tool:', !!ourIdeTool);
    log('Found our VIZ image tool:', !!ourVizImageTool);
    log('Found our get layout state tool:', !!ourGetLayoutTool);
    log('Found our set layout state tool:', !!ourSetLayoutTool);
    log('Found our get available panes tool:', !!ourAvailablePanesTool);
    log('Found our open pane tool:', !!ourOpenPaneTool);
    log('Found our open third-party pane tool:', !!ourOpenThirdPartyPaneTool);
    log('Found our update play state tool:', !!ourUpdatePlayStateTool);
    
    showOutputChannel(); // Show output channel on startup
  }, 1000);
}
