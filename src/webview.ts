/**
 * Webview script for Makerchip IDE integration
 * 
 * This script runs in the browser context inside the VS Code webview panel.
 * It manages communication between:
 *   - The VS Code extension (via vscode.postMessage)
 *   - The Makerchip IDE (loaded in an iframe via PenPal)
 * 
 * Compiled as ES2022 module (not CommonJS) to run in browser environment.
 * See src/tsconfig.webview.json for build configuration.
 * 
 * Generic message protocol: All IDE methods are invoked via { type: 'ide', method, args }
 * enabling any IdePlugin method to be called without code changes.
 */

// Type definitions for VS Code webview API
interface VsCodeApi {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Type for messages sent to the extension
interface IdeMessage {
  type: 'ide';
  method: string;
  args: any[];
}

interface IdeResultMessage {
  type: 'ideResult';
  method: string;
  result: any;
}

interface IdeErrorMessage {
  type: 'ideError';
  method: string;
  error: string;
}

interface ReadyMessage {
  type: 'ready';
}

interface LogMessage {
  type: 'log';
  value: string;
}

interface DoneMessage {
  type: 'done';
  value: string;
}

interface VcdMessage {
  type: 'vcd';
  value: string;
}

type ToExtensionMessage = IdeResultMessage | IdeErrorMessage | ReadyMessage | LogMessage | DoneMessage | VcdMessage;

const vscode = acquireVsCodeApi();

// @ts-ignore - Dynamic import of external module
import('https://beta.makerchip.com/dist/makerchip-plugin.js').then((module: any) => {
  const IdePlugin = module.default as any;

  class VSCodeMakerchip extends IdePlugin {
    onReady() {
      console.log("Makerchip ready");
      //this.activatePane("Diagram");
      vscode.postMessage({ type: 'ready' } as ReadyMessage);
    }
    
    onCompilationLog(id: string, log: string, complete: boolean, type: string) {
      vscode.postMessage({ type: 'log', value: log } as LogMessage);
      if (complete) {
        vscode.postMessage({ type: 'done', value: log } as DoneMessage);
      }
    }
    
    onCompilationVcd(id: string, vcd: string) {
      vscode.postMessage({ type: 'vcd', value: vcd } as VcdMessage);
    }
  }

  // @ts-ignore - IdePlugin constructor signature
  new VSCodeMakerchip('my-makerchip', { hasEditor: false }).then((ide: any) => {
    // Generic IDE method invocation handler
    window.addEventListener('message', async (event: MessageEvent) => {
      const msg = event.data;
      
      if (msg.type === 'ide') {
        // Generic IDE method invocation: { type: 'ide', method: 'methodName', args: [...] }
        const { method, args = [] } = msg as IdeMessage;
        
        if (typeof ide[method] === 'function') {
          try {
            const result = await ide[method](...args);
            // Send result back if there is one
            if (result !== undefined) {
              vscode.postMessage({ 
                type: 'ideResult', 
                method, 
                result 
              } as IdeResultMessage);
            }
          } catch (error: any) {
            console.error('Error calling IDE method:', method, error);
            vscode.postMessage({ 
              type: 'ideError', 
              method, 
              error: error.message 
            } as IdeErrorMessage);
          }
        } else {
          console.warn('IDE method not found or not a function:', method);
          vscode.postMessage({ 
            type: 'ideError', 
            method, 
            error: 'Method ' + method + ' not found' 
          } as IdeErrorMessage);
        }
      }
    });
  });
});
