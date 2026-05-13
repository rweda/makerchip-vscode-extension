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
 * enabling any IdePlugin API method to be called without code changes.
 * Methods are called via ide.api[method](...args) to prevent access to private/internal methods.
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
  requestId?: string;  // Optional request ID for calls that expect results
}

interface IdeResultMessage {
  type: 'ideResult';
  method: string;
  result: any;
  requestId?: string;  // Include request ID if present
}

interface IdeErrorMessage {
  type: 'ideError';
  method: string;
  error: string;
  requestId?: string;  // Include request ID if present
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

interface NotificationMessage {
  type: 'notification';
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** Optional action button label. If provided, extension will show button and send action back to webview */
  action?: string;
  /** Optional context data for logging/debugging */
  context?: any;
}

type ToExtensionMessage = IdeResultMessage | IdeErrorMessage | ReadyMessage | CompileFileChunkMessage | CompileErrorMessage | CompileExitStatusMessage | CompileDeniedMessage | NotificationMessage;

const vscode = acquireVsCodeApi();
console.log('[webview.ts] Script loaded and executing');
console.log('[webview.ts] vscode API acquired:', !!vscode);

// Expected IdePlugin version (semver)
const EXPECTED_IDE_PLUGIN_VERSION = '^1.0.0';

// Helper to check version compatibility (simple semver major version check)
function isVersionCompatible(actual: string, expected: string): boolean {
  const actualMajor = parseInt(actual.split('.')[0], 10);
  const expectedMajor = parseInt(expected.replace('^', '').split('.')[0], 10);
  return actualMajor === expectedMajor;
}

// Convenience functions for sending notifications to extension
function notifyInfo(message: string, action?: string, context?: any): void {
  console.log('[webview notification]', message);
  vscode.postMessage({ type: 'notification', severity: 'info', message, action, context } as NotificationMessage);
}

function notifyWarning(message: string, action?: string, context?: any): void {
  console.warn('[webview notification]', message);
  vscode.postMessage({ type: 'notification', severity: 'warning', message, action, context } as NotificationMessage);
}

function notifyError(message: string, action?: string, context?: any): void {
  console.error('[webview notification]', message);
  vscode.postMessage({ type: 'notification', severity: 'error', message, action, context } as NotificationMessage);
}

// Get server URL from global variable (set by extension)
const serverUrl = (window as any).MAKERCHIP_SERVER_URL;
if (!serverUrl) {
  const errorMsg = 'MAKERCHIP_SERVER_URL not set by extension. Server URL must be explicitly configured.';
  notifyError(errorMsg);
  throw new Error(errorMsg);
}
console.log('[webview.ts] Server URL:', serverUrl);

// @ts-ignore - Dynamic import of external module
console.log('[webview.ts] Loading makerchip-plugin.js from:', `${serverUrl}/dist/makerchip-plugin.js`);
import(`${serverUrl}/dist/makerchip-plugin.js`).then((module: any) => {
  console.log('[webview.ts] makerchip-plugin.js loaded successfully');
  const IdePlugin = module.default as any;
  console.log('[webview.ts] IdePlugin:', !!IdePlugin);
  
  // Check IdePlugin version if available
  const pluginVersion = IdePlugin.version;
  console.log('[webview.ts] IdePlugin version:', pluginVersion);
  if (pluginVersion) {
    if (!isVersionCompatible(pluginVersion, EXPECTED_IDE_PLUGIN_VERSION)) {
      const warningMsg = `IdePlugin version mismatch: expected ${EXPECTED_IDE_PLUGIN_VERSION}, got ${pluginVersion}`;
      notifyWarning(warningMsg, undefined, { expected: EXPECTED_IDE_PLUGIN_VERSION, actual: pluginVersion });
    }
  } else {
    const warningMsg = 'IdePlugin version not found. Internal API features may not work correctly.';
    notifyWarning(warningMsg, undefined, { expected: EXPECTED_IDE_PLUGIN_VERSION, actual: 'unknown' });
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
      console.log('[webview] Received message from extension:', msg);
      
      if (msg.type === 'test') {
        console.log('[webview] Test message received:', msg.data);
        return;
      }
      
      if (msg.type === 'ide') {
        // Generic IDE method invocation: { type: 'ide', method: 'methodName', args: [...], requestId?: '...' }
        const { method, args = [], requestId } = msg as IdeMessage;
        console.log('[webview] Received IDE method call:', { method, args, requestId });
        
        // Call IdePlugin API method via the api property (prevents access to private/internal methods)
        try {
          if (!ide.api || typeof ide.api[method] !== 'function') {
            throw new Error(`API method '${method}' not found or not a function`);
          }
          
          console.log(`[webview] Calling ide.api.${method}(`, ...args, ')');
          const result = await ide.api[method](...args);
          console.log(`[webview] Result from ide.api.${method}:`, result ? (typeof result === 'string' && result.length > 100 ? typeof result + ' (' + result.length + ' chars)' : result) : result);
          
          // Send result back if there is one
          if (result !== undefined) {
            console.log('[webview] Sending ideResult message');
            vscode.postMessage({ 
              type: 'ideResult', 
              method, 
              result,
              requestId  // Include requestId if present
            } as IdeResultMessage);
          } else {
            console.log('[webview] Result is undefined, not sending message');
          }
        } catch (error: any) {
          console.error('[webview] Error calling IDE method:', method, error);
          vscode.postMessage({ 
            type: 'ideError', 
            method, 
            error: error.message,
            requestId  // Include requestId if present
          } as IdeErrorMessage);
        }
      }
    });
  });
}).catch((error: any) => {
  console.error('[webview.ts] Failed to load makerchip-plugin.js:', error);
  console.error('[webview.ts] Server URL was:', serverUrl);
  
  // Notify extension of connection failure
  const errorMsg = error.message || String(error);
  notifyError(
    `Failed to connect to Makerchip server (${serverUrl}): ${errorMsg}`,
    'Open DevTools',
    { serverUrl, error: errorMsg }
  );
});
