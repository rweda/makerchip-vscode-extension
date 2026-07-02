/**
 * Webview script for Makerchip IDE integration
 *
 * This script runs in the browser context inside the VS Code webview panel.
 *
 * ── Architecture: three isolated actors, coordinating only via postMessage ──
 *
 *   1. Extension host (Node process, extension.ts)
 *        - Owns the on-disk compile cache (~/.vscode-makerchip/compile-cache/).
 *        - Hosts the LM tools / chat participant / commands that DRIVE the IDE
 *          (compile a file, set layout, set dark mode, ...). These are sent to
 *          the webview as { type: 'ide', method, args } messages.
 *        - Parks those commands behind a per-panel "ready" promise until the
 *          webview says it's safe to drive the IDE (see readiness gating below).
 *
 *   2. Webview (this file, browser context)
 *        - Orchestrates everything: connects to the Makerchip server (Socket.io),
 *          drives the IDE iframe (via Penpal / IdePlugin), owns vscode.getState()/
 *          setState() for reload persistence.
 *        - Invokes IDE methods via ide.api[method](...args) so only the public
 *          IdePlugin API surface is reachable from the extension.
 *
 *   3. IDE iframe (Makerchip IDE: editor-less panes, layout, waveform, ...)
 *        - Loaded from the server; the actual UI the user interacts with.
 *
 * These are separate contexts with no shared memory; all coordination is by
 * message passing (extension <-> webview via vscode.postMessage; webview <-> IDE
 * via Penpal).
 *
 * ── Reload persistence & restore ────────────────────────────────────────────
 *
 * On a VS Code window reload the webview is destroyed and recreated fresh. We
 * persist { panelKey, compileId, layoutState, cycle } via vscode.setState() and, on
 * recreation, rebuild the previous IDE without recompiling:
 *
 *   a. Reload with a cached compile:
 *        webview posts 'restoreRequest'  ->  extension reads cached result files
 *        + metadata from disk, posts 'restoreData'  ->  webview applies the saved
 *        layout (ide.api.setLayoutState) so the restored panes exist, injects the
 *        payloads into the IDE (ide...ideMethods.compilation*), then restores the
 *        saved current cycle (ide.api.setCycle). Falls back to recompiling cached
 *        source if the cache was pruned.
 *   b. Reload with only a saved layout: apply the layout, nothing to inject.
 *   c. Inform extension that webview is ready (to gate requests from extension)
 *   d. Fresh load: nothing to restore.
 *
 * Layout is captured continuously (poll + drag/resize/hide) rather than only on
 * API calls, because splitter drags / tab moves / resizes never call an ide.api
 * method and would otherwise be lost. getLayoutState is async and can't complete
 * during page unload, so we keep vscode.setState() up to date ahead of reload.
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

// Global variables injected by the extension
declare global {
  interface Window {
    MAKERCHIP_SERVER_URL: string;
    DEFAULT_DARK_MODE: boolean;
    /** Stable key identifying this panel, used to persist/restore state across reloads. */
    MAKERCHIP_PANEL_KEY: string;
  }
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

/**
 * Cached compilation result files.
 *  - stdall / make.out / vlt_dump.vcd are streamed in chunks.
 *  - graph.svg / parse_model.json / navtlv.html arrive as single payloads and
 *    are cached (via a single complete=true chunk) so a reloaded IDE can be
 *    restored by injecting them without a recompile.
 */
type CompileFileName =
  | 'stdall'
  | 'make.out'
  | 'vlt_dump.vcd'
  | 'graph.svg'
  | 'parse_model.json'
  | 'navtlv.html';

interface CompileFileChunkMessage {
  type: 'compileFileChunk';
  id: string;
  fileName: CompileFileName;
  chunk: string;
  complete: boolean;
}

/**
 * Sent when the server accepts a compile (the 'newcompile' event). Carries the
 * compile id and which optional outputs are expected (sim → waveform/vlt_dump.vcd,
 * dot → diagram/graph.svg), so the extension can determine overall completion.
 */
interface CompileStartMessage {
  type: 'compileStart';
  id: string;
  sim: boolean;
  dot: boolean;
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

/**
 * Sent when the webview fails to initialize (plugin load or IdePlugin construction).
 * Lets the extension reject its "panel ready" promise immediately instead of
 * hanging until the ready timeout expires.
 */
interface InitErrorMessage {
  type: 'initError';
  error: string;
}

/**
 * Sent after a reload to ask the extension for cached results so the IDE can be
 * restored (by injection) without recompiling. The extension replies with a
 * RestoreDataMessage.
 */
interface RestoreRequestMessage {
  type: 'restoreRequest';
  compileId: string;
}

/** Reply from the extension carrying cached results (or source for recompile fallback). */
interface RestoreDataMessage {
  type: 'restoreData';
  compileId: string;
  /** True when cached result files are present and can be injected directly. */
  available: boolean;
  files?: Partial<Record<CompileFileName, string>>;
  exitStatus?: { sandpiper?: number; verilator?: number };
  /** Original source for recompile fallback when results were pruned. */
  source?: string;
}

type ToExtensionMessage = IdeResultMessage | IdeErrorMessage | ReadyMessage | CompileFileChunkMessage | CompileStartMessage | CompileErrorMessage | CompileExitStatusMessage | CompileDeniedMessage | NotificationMessage | InitErrorMessage | RestoreRequestMessage;

const vscode = acquireVsCodeApi();
console.log('[webview.ts] Script loaded and executing');
console.log('[webview.ts] vscode API acquired:', !!vscode);

// Expected IdePlugin version (semver). 2.x introduced the static create() factory
// in place of the promise-returning constructor.
const EXPECTED_IDE_PLUGIN_VERSION = '^2.0.0';

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

  // Splash/restore gate.
  //
  // IdePlugin awaits onReady()'s return value before removing its splash screen,
  // and the splash blocks user interaction. So onReady() returns this promise to
  // keep the splash up (input blocked) until reload restore is complete. It's a
  // closure variable rather than a class field because IdePlugin's constructor
  // returns a promise (see IdePlugin.coffee `return @_initialize().then -> instance`),
  // which would bind subclass field initializers to that promise, not the instance.
  //
  // Resolving it is independent of onReady(): the outer .then((ide) => ...) below
  // (which resolves it via signalReady) runs once _initialize() resolves at Penpal
  // handshake, NOT when IDELoaded/onReady fires — so there is no deadlock.
  let resolveRestoreGate: () => void = () => {};
  const restoreGate = new Promise<void>((resolve) => { resolveRestoreGate = resolve; });

  class VSCodeMakerchip extends IdePlugin {
    onReady() {
      console.log("Makerchip ready");
      // Keep the splash up (blocking user input) until restore completes. The
      // plugin removes the splash only after this promise resolves. Resolved by
      // signalReady() once cached results are injected/kicked-off and the layout
      // is applied. This gates the USER; signalReady() also notifies the extension
      // (which gates extension-issued commands) at the same moment.
      return restoreGate;
    }
    
    // Helper to set up a file stream listener (internal API - may not be available)
    private setupFileStreamListener(
      socket: any, 
      eventName: string, 
      fileName: CompileFileName
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

    // Helper to cache a single-payload result event (graph/parse model/navTLV).
    // These arrive once per compile as (id, payload); cache as one complete chunk.
    private setupSinglePayloadListener(
      socket: any,
      eventName: string,
      fileName: CompileFileName
    ) {
      socket.on(eventName, (id: string, payload: string) => {
        vscode.postMessage({
          type: 'compileFileChunk',
          id,
          fileName,
          chunk: payload,
          complete: true
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

        // The server accepts a compile and reports which outputs it will produce
        // (sim → waveform, dot → diagram). Forward this first so the extension can
        // initialize the cache entry and know the expected result set.
        socket.on("newcompile", (data: { id: string; sim: boolean; dot: boolean }) => {
          vscode.postMessage({
            type: 'compileStart',
            id: data.id,
            sim: data.sim,
            dot: data.dot
          } as CompileStartMessage);
        });

        // Set up listeners for all compilation result files
        this.setupFileStreamListener(socket, "stdall", 'stdall');        // SandPiper logs
        this.setupFileStreamListener(socket, "makeout", 'make.out');     // Verilator logs
        this.setupFileStreamListener(socket, "vcd-stream", 'vlt_dump.vcd'); // Waveform data

        // Single-payload results needed to restore the IDE after a reload without
        // recompiling. ServerCompile's own listeners still drive the live IDE; these
        // are additive and only cache the payloads to the extension.
        this.setupSinglePayloadListener(socket, "graph", 'graph.svg');            // Diagram SVG
        this.setupSinglePayloadListener(socket, "parse model", 'parse_model.json'); // VIZ parse model (JSON string)
        this.setupSinglePayloadListener(socket, "navTLV", 'navtlv.html');         // Nav-TLV HTML
        
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

  // Create + initialize the IdePlugin (VSCodeMakerchip). Return the promise so construction failures
  // propagate to the outer .catch() below (otherwise onReady never fires and the
  // extension hangs).
  // @ts-ignore - VSCodeMakerchip derives from an `any`-typed IdePlugin base
  return VSCodeMakerchip.create('webview-makerchip', { hasEditor: false, defaultDarkMode: window.DEFAULT_DARK_MODE }).then((ide: any) => {
    console.log('IdePlugin initialized successfully');

    // ---- Reload persistence / restore -------------------------------------
    // On a VS Code window reload the webview is destroyed and recreated. We
    // persist the last compile ID + layout via vscode.setState() and, on
    // recreation, restore the IDE by injecting cached results (or recompiling
    // from cached source when results were pruned).
    const panelKey: string = window.MAKERCHIP_PANEL_KEY;
    const saved = vscode.getState() || {};
    let currentCompileId: string | undefined = saved.compileId;

    // Compact, safe one-line summary of a layout-state tree for logging.
    const summarizeLayout = (state: any): string => {
      if (state == null) { return 'null'; }
      try {
        const panes: string[] = [];
        const walk = (node: any): void => {
          if (!node || typeof node !== 'object') { return; }
          if (Array.isArray(node.panes)) {
            const names = node.panes.map((p: any) => (typeof p === 'object' ? p?.mnemonic : p));
            panes.push(`[${names.join(',')}${node.activePane ? ` *${node.activePane}` : ''}]`);
          }
          if (node.sides) { for (const k of Object.keys(node.sides)) { walk(node.sides[k]); } }
        };
        walk(state);
        const json = JSON.stringify(state);
        return `panes=${panes.join(' ')} keys=${Object.keys(state).join(',')} bytes=${json.length}`;
      } catch (e) {
        return `<unstringifiable: ${e}>`;
      }
    };
    console.log('[webview][restore] Loaded persisted state:', {
      panelKey,
      hasCompileId: !!saved.compileId,
      compileId: saved.compileId,
      hasLayoutState: !!saved.layoutState,
      cycle: saved.cycle,
      layoutSummary: summarizeLayout(saved.layoutState),
    });

    // Layout persistence.
    //
    // The IDE layout can change from many sources the extension never sees:
    // dragging a splitter, moving/closing a tab, resizing the panel, etc. None
    // of those call an `ide.api.*` method, so persisting only after API calls
    // captured a stale (often the flat default) layout. Instead we capture the
    // *actual* current layout whenever it changes and dedupe by serialized value.
    //
    // Persisting is gated behind `allowPersist` so the transient default layout
    // built during a fresh IDE construction can't overwrite the good saved state
    // before we've had a chance to restore it.
    let allowPersist = false;
    let lastPersistedJson = '';
    const captureAndPersist = async (reason: string) => {
      if (!allowPersist) { return; }
      let layoutState: any;
      try {
        // forTransfer captures the data needed to rebuild the layout in a fresh
        // IDE instance (the reload case), including any third-party panes.
        layoutState = await ide.api.getLayoutState({ forTransfer: true });
      } catch (e) {
        console.warn('[webview][persist] Could not capture layout state:', e);
        return;
      }
      // Also capture the current cycle (time-step position only, NOT play
      // state) so a reload can return the user to the same point. Best-effort:
      // getCycle can reject or return non-number when no waveform is loaded.
      let cycle: number | undefined;
      try {
        const c = await ide.api.getCycle();
        if (typeof c === 'number') { cycle = c; }
      } catch { /* no waveform / cycle unavailable */ }
      const json = JSON.stringify({ compileId: currentCompileId, layoutState, cycle });
      if (json === lastPersistedJson) { return; }
      lastPersistedJson = json;
      vscode.setState({ panelKey, compileId: currentCompileId, layoutState, cycle });
      // Keep the local snapshot current so a later restore uses the freshest values.
      saved.layoutState = layoutState;
      saved.cycle = cycle;
      console.log(`[webview][persist] Saved state (${reason}):`, {
        compileId: currentCompileId,
        cycle,
        layoutSummary: summarizeLayout(layoutState),
      });
    };

    // Debounced capture, used for bursty events (drag/resize) and API calls.
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    const schedulePersist = (reason = 'api') => {
      if (persistTimer) { clearTimeout(persistTimer); }
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void captureAndPersist(reason);
      }, 500);
    };

    // Watch for layout changes the extension can't observe directly. A periodic
    // poll is the reliable catch-all (dedupe makes it cheap when nothing changed);
    // drag-end / resize / hide give faster capture for common interactions.
    const startLayoutWatcher = () => {
      allowPersist = true;
      // Safety-net poll so the persisted state is never more than a couple of
      // seconds behind whatever the user is looking at.
      setInterval(() => { void captureAndPersist('poll'); }, 2000);
      // Capture promptly when the panel is hidden or the page is unwound (reload).
      // These are best-effort: the async round-trip may not finish before unload,
      // but the poll above will usually have captured the latest layout already.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { void captureAndPersist('hidden'); }
      });
      window.addEventListener('pagehide', () => { void captureAndPersist('pagehide'); });
      // Splitter drags and tab moves happen inside the IDE iframe, so listen there
      // for the end of a mouse interaction.
      try {
        const doc = (ide.iframe?.contentWindow as any)?.document;
        if (doc) {
          doc.addEventListener('mouseup', () => schedulePersist('drag'));
        }
      } catch { /* iframe not accessible; poll still covers us */ }
    };

    // Restore a compilation into the freshly-loaded IDE. Prefers injecting cached
    // results (no server round-trip); falls back to recompiling cached source.
    const restoreCompilation = async (data: RestoreDataMessage) => {
      const ideMethods = ide.serverCompile?.instance?.ideMethods;
      const id = data.compileId;
      if (data.available && data.files && ideMethods) {
        try {
          const f = data.files;
          // Order matters: compilationId() sets lastId and resets state; every
          // other compilation* method is ignored unless its id matches lastId.
          await ideMethods.compilationId({ id });
          if (f['stdall'] != null) { await ideMethods.compilationStdall(id, f['stdall'], true); }
          if (f['graph.svg'] != null) { await ideMethods.compilationGraph(id, f['graph.svg']); }
          if (f['parse_model.json'] != null) { await ideMethods.compilationParseModel(id, f['parse_model.json']); }
          if (f['navtlv.html'] != null) { await ideMethods.compilationNavTlv(id, f['navtlv.html']); }
          if (f['make.out'] != null) { await ideMethods.compilationMakeout(id, f['make.out'], true); }
          if (f['vlt_dump.vcd'] != null) { await ideMethods.compilationVcdStream(id, f['vlt_dump.vcd'], true); }
          if (data.exitStatus?.sandpiper != null) { await ideMethods.exitStatus(id, 'sandpiper', data.exitStatus.sandpiper); }
          if (data.exitStatus?.verilator != null) { await ideMethods.exitStatus(id, 'vcd', data.exitStatus.verilator); }
          console.log('[webview] Restored compilation from cache:', id);
          return;
        } catch (e) {
          console.error('[webview] Injection restore failed, will try recompile:', e);
        }
      }
      // Fallback: recompile from cached source. compile() resolves at kick-off
      // (when the server acks with the new id), NOT after results/simulation, so
      // this doesn't gate readiness on the slow part. Capture the new id so state
      // persistence tracks the fresh compile rather than the pruned one.
      if (data.source != null) {
        console.log('[webview] Restoring by recompiling cached source for', id);
        try {
          const newId = await ide.api.compile(data.source);
          if (typeof newId === 'string') { currentCompileId = newId; }
        } catch (e) {
          console.error('[webview] Recompile restore failed:', e);
        }
      } else {
        console.warn('[webview] No cached data available to restore compile', id);
      }
    };

    // Apply the persisted layout. Run this BEFORE injecting results so the
    // restored panes already exist to receive the compilation events. (Result
    // injection only feeds data to existing panes; it neither opens nor activates
    // panes, so it would not disturb the layout in any case.)
    const applyLayout = async () => {
      if (!saved.layoutState) {
        console.log('[webview][applyLayout] No saved layoutState; skipping');
        return;
      }
      console.log('[webview][applyLayout] Applying saved layout:', summarizeLayout(saved.layoutState));
      try {
        let before = 'unavailable';
        try { before = summarizeLayout(await ide.api.getLayoutState()); } catch { /* ignore */ }
        console.log('[webview][applyLayout] Layout BEFORE setLayoutState:', before);

        await ide.api.setLayoutState(saved.layoutState);

        let after = 'unavailable';
        try { after = summarizeLayout(await ide.api.getLayoutState()); } catch { /* ignore */ }
        console.log('[webview][applyLayout] Layout AFTER setLayoutState:', after);
        console.log('[webview][applyLayout] Restored layout state OK');
      } catch (e: any) {
        console.error('[webview][applyLayout] setLayoutState FAILED:', e?.message || e, e?.stack);
      }
    };

    // Restore the persisted current cycle (time-step position only, not play
    // state). Run this AFTER results are injected so the waveform data exists;
    // setCycle clamps to the valid range, so a now-out-of-range saved value is
    // harmless. Best-effort: logged but never fatal to the restore sequence.
    const restoreCycle = async () => {
      if (typeof saved.cycle !== 'number') {
        console.log('[webview][restoreCycle] No saved cycle; skipping');
        return;
      }
      try {
        await ide.api.setCycle(saved.cycle);
        console.log('[webview][restoreCycle] Restored cycle:', saved.cycle);
      } catch (e: any) {
        console.error('[webview][restoreCycle] setCycle FAILED:', e?.message || e);
      }
    };


    // Setup resize event forwarding to iframe
    // VS Code webview doesn't automatically propagate resize events to iframes,
    // so we need to manually trigger resize events in the iframe's window when
    // the parent webview is resized. This ensures jQuery Layout's resizeWithWindow
    // option works correctly and VizPane canvas resizes properly.
    window.addEventListener('resize', () => {
      console.log('[webview] Window resized, triggering iframe resize event');
      schedulePersist('resize');
      const iframe = ide.iframe;
      if (iframe && iframe.contentWindow) {
        // Use setTimeout to let the browser actually resize the iframe first
        setTimeout(() => {
          const iframeWindow = iframe.contentWindow as any;
          console.log('[webview] iframe dimensions:', iframe.clientWidth, 'x', iframe.clientHeight);
          
          // jQuery Layout listens for jQuery's resize event, not native DOM events
          if (iframeWindow && iframeWindow.jQuery) {
            iframeWindow.jQuery(iframeWindow).trigger('resize');
          } else {
            // Fallback to native event if jQuery not available
            if (iframeWindow) {
              const resizeEvent = new Event('resize');
              iframeWindow.dispatchEvent(resizeEvent);
            }
          }
        }, 0);
      }
    });
    
    // Generic IDE method invocation handler
    window.addEventListener('message', async (event: MessageEvent) => {
      const msg = event.data;
      console.log('[webview] Received message from extension:', msg);
      
      if (msg.type === 'test') {
        console.log('[webview] Test message received:', msg.data);
        return;
      }

      if (msg.type === 'restoreData') {
        const rd = msg as RestoreDataMessage;
        console.log('[webview][restore] Received restoreData:', {
          compileId: rd.compileId,
          available: rd.available,
          fileKeys: rd.files ? Object.keys(rd.files) : [],
          hasSource: rd.source != null,
          exitStatus: rd.exitStatus,
        });
        // Apply the saved layout first so the restored panes exist to receive the
        // injected compilation results; then inject the cached results; finally
        // restore the saved current cycle (now that the waveform data exists).
        await applyLayout();
        console.log('[webview][restore] Layout applied; injecting results next');
        await restoreCompilation(rd);
        console.log('[webview][restore] Results injected; restoring cycle next');
        await restoreCycle();
        console.log('[webview][restore] Restore sequence complete');
        // Now that the good layout is applied, start tracking real layout changes.
        startLayoutWatcher();
        // Restore finished: it's now safe to let the extension/user drive the IDE.
        signalReady();
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

          // Track the active compile ID so state can be persisted for reload restore.
          if (method === 'compile' && typeof result === 'string') {
            currentCompileId = result;
          }
          // Persist state after any IDE call (captures compile ID + latest layout).
          schedulePersist('api');
          
          // Send result back if there is one OR if a requestId is present (caller expects response)
          if (result !== undefined || requestId !== undefined) {
            console.log('[webview] Sending ideResult message');
            vscode.postMessage({ 
              type: 'ideResult', 
              method, 
              result,
              requestId  // Include requestId if present
            } as IdeResultMessage);
          } else {
            console.log('[webview] Result is undefined and no requestId, not sending message');
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

    // Kick off restore if this is a reload with a previously-saved compile.
    // The layout is restored by applyLayout() AFTER cached results are injected
    // (see the restoreData handler), so it isn't clobbered by pane activation from
    // the injected results.
    //
    // 'ready' is signaled to the extension only once the relevant branch below
    // has finished (results injected + layout restored, or nothing to restore),
    // so the extension holds its commands and the user interacts only with a
    // fully-restored IDE. Guarded to fire exactly once.
    let readySignaled = false;
    const signalReady = () => {
      if (readySignaled) { return; }
      readySignaled = true;
      console.log('[webview] Restore complete: lifting splash + signaling ready to extension');
      // Lift the splash (allow USER interaction) and notify the extension (allow
      // extension-issued commands) at the same moment.
      resolveRestoreGate();
      vscode.postMessage({ type: 'ready' } as ReadyMessage);
    };

    if (saved.compileId) {
      console.log('[webview][restore] Reload detected, requesting cached results for compile:', saved.compileId);
      vscode.postMessage({ type: 'restoreRequest', compileId: saved.compileId } as RestoreRequestMessage);
    } else if (saved.layoutState) {
      // Reloaded with a saved layout but no compile to restore: apply layout now.
      console.log('[webview][restore] Reload detected, restoring layout only (no compile)');
      applyLayout().finally(() => { startLayoutWatcher(); signalReady(); });
    } else {
      console.log('[webview][restore] Fresh load (no saved compile or layout)');
      startLayoutWatcher();
      signalReady();
    }
  });
}).catch((error: any) => {
  console.error('[webview.ts] Failed to initialize Makerchip webview:', error);
  console.error('[webview.ts] Server URL was:', serverUrl);
  
  // Notify extension of connection failure
  const errorMsg = error.message || String(error);
  notifyError(
    `Failed to connect to Makerchip server (${serverUrl}): ${errorMsg}`,
    'Open DevTools',
    { serverUrl, error: errorMsg }
  );

  // Tell the extension to reject its "panel ready" promise now, so callers
  // fail fast instead of waiting for the ready timeout to elapse.
  vscode.postMessage({ type: 'initError', error: errorMsg } as InitErrorMessage);
});

// Marks this file as an ES module so the `declare global` augmentation above is
// valid (a file with no top-level import/export is otherwise treated as a script).
export {};
