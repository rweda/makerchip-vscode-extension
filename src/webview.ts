/**
 * Webview script for Makerchip IDE integration
 * 
 * This script runs in the browser context inside the VS Code webview panel.
 * It manages communication between:
 *   - The VS Code extension (via vscode.postMessage)
 *   - The Makerchip IDE (loaded in an iframe via PenPal)
 *
 * TODO: This code listens directly to the Makerchip server compile socket, which is an
 *       internal API. We should expose this with a cleanly versioned IdePlugin API.
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

interface CompileFileChunkMessage {
  type: 'compileFileChunk';
  id: string;
  fileName: 'stdall' | 'make.out' | 'vlt_dump.vcd';
  chunk: string;
  complete: boolean;
}

interface CompileErrorMessage {
  type: 'compileError';
  id: string;
  errorType: string;
  message?: string;
  details?: any;
}

interface CompileExitStatusMessage {
  type: 'compileExitStatus';
  id: string;
  stage: 'sandpiper' | 'verilator';
  exitCode: number;
}

interface CompileDeniedMessage {
  type: 'compileDenied';
  reason: string;
  message: string;
  retryAfterSeconds?: number;
}

type ToExtensionMessage = IdeResultMessage | IdeErrorMessage | ReadyMessage | CompileFileChunkMessage | CompileErrorMessage | CompileExitStatusMessage | CompileDeniedMessage;

const vscode = acquireVsCodeApi();

// Expected IdePlugin version (semver)
const EXPECTED_IDE_PLUGIN_VERSION = '^1.0.0';

// Helper to check version compatibility (simple semver major version check)
function isVersionCompatible(actual: string, expected: string): boolean {
  const actualMajor = parseInt(actual.split('.')[0], 10);
  const expectedMajor = parseInt(expected.replace('^', '').split('.')[0], 10);
  return actualMajor === expectedMajor;
}

// @ts-ignore - Dynamic import of external module
import('https://beta.makerchip.com/dist/makerchip-plugin.js').then((module: any) => {
  const IdePlugin = module.default as any;
  
  // Check IdePlugin version if available
  const pluginVersion = IdePlugin.version;
  if (pluginVersion) {
    if (!isVersionCompatible(pluginVersion, EXPECTED_IDE_PLUGIN_VERSION)) {
      console.warn(`IdePlugin version mismatch: expected ${EXPECTED_IDE_PLUGIN_VERSION}, got ${pluginVersion}. Some features may not work correctly.`);
    }
  } else {
    console.warn('IdePlugin version not found. Internal API features may not work correctly.');
  }

  class VSCodeMakerchip extends IdePlugin {
    onReady() {
      console.log("Makerchip ready");
      vscode.postMessage({ type: 'ready' } as ReadyMessage);
    }
    
    // Helper to set up a file stream listener (internal API - may not be available)
    private setupFileStreamListener(
      socket: any, 
      eventName: string, 
      fileName: 'stdall' | 'make.out' | 'vlt_dump.vcd'
    ) {
      socket.on(eventName, (id: string, chunk: string, complete: boolean) => {
        vscode.postMessage({ 
          type: 'compileFileChunk', 
          id, 
          fileName,
          chunk,
          complete 
        } as CompileFileChunkMessage);
      });
    }
    
    // Override _setupCompilationListeners to handle all file streams uniformly
    // Note: This uses internal IdePlugin APIs that may change. Fails gracefully if not available.
    _setupCompilationListeners() {
      console.log('Setting up compilation listeners for unified file streaming...');
      
      // Access internal socket API with graceful failure
      try {
        const serverCompile = (this as any).serverCompile;
        if (!serverCompile || !serverCompile.instance) {
          console.warn('serverCompile not available - compilation results will not be cached');
          return;
        }
        
        const socket = serverCompile.instance.socket;
        if (!socket) {
          console.warn('Socket not available - compilation results will not be cached');
          return;
        }
        
        // Set up listeners for all compilation result files
        this.setupFileStreamListener(socket, "stdall", 'stdall');        // SandPiper logs
        this.setupFileStreamListener(socket, "makeout", 'make.out');     // Verilator logs
        this.setupFileStreamListener(socket, "vcd-stream", 'vlt_dump.vcd'); // Waveform data
        
        // Listen for error events
        socket.on("err", (errorType: string, id: string) => {
          vscode.postMessage({
            type: 'compileError',
            id,
            errorType
          } as CompileErrorMessage);
        });
        
        // Listen for denied compilations
        socket.on("denied", (denial: {reason: string, message: string, retryAfterSeconds?: number}) => {
          vscode.postMessage({
            type: 'compileDenied',
            reason: denial.reason,
            message: denial.message,
            retryAfterSeconds: denial.retryAfterSeconds
          } as CompileDeniedMessage);
        });
        
        // Listen for exit status codes
        socket.on("sp-exitstatus", (id: string, exitCode: number) => {
          vscode.postMessage({
            type: 'compileExitStatus',
            id,
            stage: 'sandpiper',
            exitCode
          } as CompileExitStatusMessage);
        });
        
        socket.on("vcd-exitstatus", (id: string, exitCode: number) => {
          vscode.postMessage({
            type: 'compileExitStatus',
            id,
            stage: 'verilator',
            exitCode
          } as CompileExitStatusMessage);
        });
        
        console.log('Compilation listeners set up successfully');
      } catch (error) {
        console.warn('Failed to set up compilation listeners - compilation results will not be cached:', error);
      }
    }
  }

  // @ts-ignore - IdePlugin constructor signature
  new VSCodeMakerchip('my-makerchip', { hasEditor: false }).then((ide: any) => {
    console.log('IdePlugin initialized successfully');
    
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
