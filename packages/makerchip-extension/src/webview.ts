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
 *   3. IDE iframe (Makerchip IDE: editor-less views, layout, waveform, ...)
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
 *        layout (ide.api.setLayoutState) so the restored views exist, injects the
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
    /** ISO time the user accepted the Makerchip terms (see terms.ts); null if never. */
    TERMS_ACCEPTED_AT: string | null;
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

// Envelope used to ferry a Blob result across the webview→extension postMessage
// boundary. VS Code serializes webview messages as plain data, so a Blob would
// arrive on the extension side stripped of its prototype (no .arrayBuffer()).
// We convert Blobs to this base64 envelope here and reconstruct a Buffer there.
interface SerializedBlob {
  __makerchipBlob: true;
  base64: string;
  mimeType: string;
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
 * Sent when the server accepts a compile (once it assigns the compile id, delivered
 * via the platform's onCompilationStart hook). Carries the compile id and which
 * optional outputs are expected (sim → waveform/vlt_dump.vcd, dot → diagram/graph.svg),
 * so the extension can determine overall completion.
 *
 * Also carries the source that was compiled (captured at the compile call site, so
 * this covers editor/delivery/extension-initiated compiles uniformly). `source` is a
 * plain string for single-file compiles or a `{files, top}` payload for multi-file.
 */
interface CompileStartMessage {
  type: 'compileStart';
  id: string;
  sim: boolean;
  dot: boolean;
  source?: string | { files: Record<string, string>; top?: string };
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
  /** Which files were fully received (see compileCache.RestoreData). */
  fileComplete?: Partial<Record<CompileFileName, boolean>>;
  exitStatus?: { sandpiper?: number; verilator?: number };
  /**
   * The server's SandPiper pass/fail verdict, regenerated by the extension from the settled cache
   * (a SandPiper-stage failure was recorded as an 'err' event). Replayed at restore so a cached
   * failing compile restores as a failure.
   */
  sandpiperFailed?: boolean;
  /** Recorded server `err` event types, replayed at restore (see compileCache.RestoreData). */
  errorTypes?: string[];
  /**
   * Original source for recompile fallback when results were pruned. A String for
   * single-file compiles, or a `{files, top}` payload for multi-file compiles.
   */
  source?: string | { files: Record<string, string>; top: string };
}

/** Sent when the user accepts revised Makerchip terms in the IDE (which asks when TERMS_ACCEPTED_AT is stale). */
interface TermsAcceptedMessage {
  type: 'termsAccepted';
  acceptedAt: string;
}

type ToExtensionMessage = IdeResultMessage | IdeErrorMessage | ReadyMessage | CompileFileChunkMessage | CompileStartMessage | CompileErrorMessage | CompileExitStatusMessage | CompileDeniedMessage | NotificationMessage | InitErrorMessage | RestoreRequestMessage | TermsAcceptedMessage;

const vscode = acquireVsCodeApi();

// Expected IdePlugin version (semver). 2.x introduced the static create() factory
// in place of the promise-returning constructor.
const EXPECTED_IDE_PLUGIN_VERSION = '^2.0.0';

// Helper to check version compatibility (simple semver major version check)
function isVersionCompatible(actual: string, expected: string): boolean {
  const actualMajor = parseInt(actual.split('.')[0], 10);
  const expectedMajor = parseInt(expected.replace('^', '').split('.')[0], 10);
  return actualMajor === expectedMajor;
}

// Serialize an IDE method result so it survives the webview→extension postMessage
// boundary. Blobs (e.g. captureVideo output) lose their prototype during
// serialization, so convert them to a base64 SerializedBlob envelope that the
// extension reconstructs into a Buffer. All other values pass through unchanged.
async function serializeIdeResult(result: any): Promise<any> {
  if (result instanceof Blob) {
    const bytes = new Uint8Array(await result.arrayBuffer());
    // Build the binary string in chunks to avoid blowing the call stack on
    // large videos when spreading into String.fromCharCode.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
    }
    return { __makerchipBlob: true, base64: btoa(binary), mimeType: result.type } as SerializedBlob;
  }
  return result;
}

// Servers predating the Pane->View rename (IdePlugin < 2.1.0, mono issues/035-view-nomenclature.md)
// use "pane" names. Adapt their api in place so the extension uses current names everywhere.
// Remove once supported servers are all >= 2.1.0.
function adaptPreViewServerApi(api: any): void {
  if (typeof api.getAvailableViews === 'function') { return; }
  const legacyNames: Record<string, string> = {
    openView: 'openPane', activateView: 'activatePane', openThirdPartyView: 'openThirdPartyPane',
    reserveView: 'reservePane', getAvailableViews: 'getAvailablePanes', fitView: 'fitPane', callView: 'callPane',
  };
  for (const [name, legacy] of Object.entries(legacyNames)) { api[name] = api[legacy]; }
  // Layout state is a tree of {views, activeView} leaves under {sides: {...}} splits.
  const renameKeys = (state: any, keys: Record<string, string>): any => {
    if (!state || typeof state !== 'object') { return state; }
    const out: any = {};
    for (const [k, v] of Object.entries(state)) { out[keys[k] ?? k] = v; }
    if (out.sides) {
      out.sides = Object.fromEntries(Object.entries(out.sides).map(([k, v]) => [k, renameKeys(v, keys)]));
    }
    return out;
  };
  const { getLayoutState, setLayoutState } = api;
  api.getLayoutState = async (...args: any[]) =>
    renameKeys(await getLayoutState(...args), { panes: 'views', activePane: 'activeView' });
  api.setLayoutState = (state: any, ...args: any[]) =>
    setLayoutState(renameKeys(state, { views: 'panes', activeView: 'activePane' }), ...args);
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
import(`${serverUrl}/dist/makerchip-plugin.js`).then((module: any) => {
  const IdePlugin = module.default as any;

  // Check IdePlugin version if available
  const pluginVersion = IdePlugin.version;
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
    // Base-class properties (typed here for access; `declare` emits no initializer so
    // it won't clobber what IdePlugin sets). The real fields below are plain class
    // fields.
    declare readonly api: any;
    declare readonly iframe: HTMLIFrameElement | null;

    // Reload-persistence state, initialized from vscode storage at construction time.
    readonly panelKey: string = window.MAKERCHIP_PANEL_KEY;
    readonly saved: any = vscode.getState() || {};
    currentCompileId: string | undefined = this.saved.compileId;

    // Layout-watcher state.
    private allowPersist = false;
    private lastPersistedJson = '';
    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    // Resolved at the end of kickoffRestore(). IdePlugin holds the splash screen until
    // onReady() returns this promise; it also gates extension-issued 'ide' commands.
    // These should be gated anyway by `callIDE()`'s use of `ensurePanelReady()`, so
    // this is belt-and-suspenders.
    private _resolveRestoreGate!: () => void;
    readonly restoreGate = new Promise<void>(r => { this._resolveRestoreGate = r; });

    // Resolved when the extension replies to 'restoreRequest' with 'restoreData'.
    private _resolveRestoreData!: (data: RestoreDataMessage) => void;
    private _restoreDataReceived = new Promise<RestoreDataMessage>(r => { this._resolveRestoreData = r; });

    onTermsAccepted(acceptedAt: string) {
      vscode.postMessage({ type: 'termsAccepted', acceptedAt } as TermsAcceptedMessage);
    }

    onReady() {
      console.log("Makerchip ready");
      adaptPreViewServerApi(this.api);
      // All views have attached their Session listeners. Kick off restore (or just
      // signal ready for a fresh load), then release the splash when done.
      void this.kickoffRestore();
      return this.restoreGate;
    }

    /** Called by the message handler when the extension sends 'restoreData'. */
    receiveRestoreData(data: RestoreDataMessage) {
      this._resolveRestoreData(data);
    }

    // Perform any needed restore, then signal readiness to the user (splash) and
    // extension. Single exit point: startLayoutWatcher + restoreGate + 'ready' always here.
    private async kickoffRestore() {
      if (this.saved.compileId) {
        console.log('[webview][restore] Reload detected, requesting cached results for compile:', this.saved.compileId);
        vscode.postMessage({ type: 'restoreRequest', compileId: this.saved.compileId } as RestoreRequestMessage);
        const data = await this._restoreDataReceived;
        await this.applyLayout();
        await this.restoreCompilation(data);
        await this.restoreCycle();
      } else if (this.saved.layoutState) {
        console.log('[webview][restore] Reload detected, restoring layout only (no compile)');
        await this.applyLayout();
      } else {
        console.log('[webview][restore] Fresh load (no saved compile or layout)');
      }
      this.startLayoutWatcher();
      console.log('[webview] Restore complete: lifting splash + signaling ready to extension');
      this._resolveRestoreGate();
      vscode.postMessage({ type: 'ready' } as ReadyMessage);
    }

    // Apply the persisted layout. Run this BEFORE injecting results so the
    // restored views already exist to receive the compilation events. (Result
    // injection only feeds data to existing views; it neither opens nor activates
    // views, so it would not disturb the layout in any case.)
    private async applyLayout() {
      if (!this.saved.layoutState) { return; }
      try {
        await this.api.setLayoutState(this.saved.layoutState);
      } catch (e: any) {
        console.error('[webview][applyLayout] setLayoutState FAILED:', e?.message || e, e?.stack);
      }
    }

    // Restore a compilation into the freshly-loaded IDE. Prefers injecting cached
    // results (no server round-trip); falls back to recompiling cached source.
    private async restoreCompilation(data: RestoreDataMessage) {
      const ideMethods = (this as any).serverCompile?.instance?.ideMethods;
      const id = data.compileId;
      if (data.available && data.files && ideMethods) {
        try {
          const f = data.files;
          const done = (name: CompileFileName) => !!data.fileComplete?.[name];
          // Order matters: compilationId() sets lastId and resets state; every
          // other compilation* method is ignored unless its id matches lastId.
          await ideMethods.compilationId({ id });
          if (f['stdall'] != null) { await ideMethods.compilationStdall(id, f['stdall'], done('stdall')); }
          if (f['graph.svg'] != null) { await ideMethods.compilationGraph(id, f['graph.svg']); }
          if (f['parse_model.json'] != null) { await ideMethods.compilationParseModel(id, f['parse_model.json']); }
          if (f['navtlv.html'] != null) { await ideMethods.compilationNavTlv(id, f['navtlv.html']); }
          if (f['make.out'] != null) { await ideMethods.compilationMakeout(id, f['make.out'], done('make.out')); }
          if (f['vlt_dump.vcd'] != null) { await ideMethods.compilationVcdStream(id, f['vlt_dump.vcd'], done('vlt_dump.vcd')); }
          // Replay the server's regenerated verdict (sandpiperFailed) so a cached failing compile
          // restores as a failure; the client no longer re-derives failure from the exit code.
          if (data.exitStatus?.sandpiper != null) { await ideMethods.exitStatus(id, 'sandpiper', data.exitStatus.sandpiper, data.sandpiperFailed); }
          if (data.exitStatus?.verilator != null) { await ideMethods.exitStatus(id, 'vcd', data.exitStatus.verilator); }
          for (const type of data.errorTypes ?? []) { await ideMethods.compilationError(id, type); }
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
          const newId = await this.api.compile(data.source);
          if (typeof newId === 'string') { this.currentCompileId = newId; }
        } catch (e) {
          console.error('[webview] Recompile restore failed:', e);
        }
      } else {
        console.warn('[webview] No cached data available to restore compile', id);
      }
    }

    // Restore the persisted current cycle (time-step position only, not play
    // state). Run this AFTER results are injected so the waveform data exists;
    // setCycle clamps to the valid range, so a now-out-of-range saved value is
    // harmless. Best-effort: logged but never fatal to the restore sequence.
    private async restoreCycle() {
      if (typeof this.saved.cycle !== 'number') { return; }
      try {
        await this.api.setCycle(this.saved.cycle);
      } catch (e: any) {
        console.error('[webview][restoreCycle] setCycle FAILED:', e?.message || e);
      }
    }

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
    private async captureAndPersist() {
      if (!this.allowPersist) { return; }
      let layoutState: any;
      try {
        // forTransfer captures the data needed to rebuild the layout in a fresh
        // IDE instance (the reload case), including any third-party views.
        layoutState = await this.api.getLayoutState({ forTransfer: true });
      } catch (e) {
        console.warn('[webview][persist] Could not capture layout state:', e);
        return;
      }
      // Also capture the current cycle (time-step position only, NOT play
      // state) so a reload can return the user to the same point. Best-effort:
      // getCycle can reject or return non-number when no waveform is loaded.
      let cycle: number | undefined;
      try {
        const c = await this.api.getCycle();
        if (typeof c === 'number') { cycle = c; }
      } catch { /* no waveform / cycle unavailable */ }
      const json = JSON.stringify({ compileId: this.currentCompileId, layoutState, cycle });
      if (json === this.lastPersistedJson) { return; }
      this.lastPersistedJson = json;
      vscode.setState({ panelKey: this.panelKey, compileId: this.currentCompileId, layoutState, cycle });
      // Keep the local snapshot current so a later restore uses the freshest values.
      this.saved.layoutState = layoutState;
      this.saved.cycle = cycle;
    }

    // Debounced capture, used for bursty events (drag/resize) and API calls.
    schedulePersist() {
      if (this.persistTimer) { clearTimeout(this.persistTimer); }
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        void this.captureAndPersist();
      }, 500);
    }

    // Watch for layout changes the extension can't observe directly. A periodic
    // poll is the reliable catch-all (dedupe makes it cheap when nothing changed);
    // drag-end / resize / hide give faster capture for common interactions.
    private startLayoutWatcher() {
      this.allowPersist = true;
      // Safety-net poll so the persisted state is never more than a couple of
      // seconds behind whatever the user is looking at.
      setInterval(() => { void this.captureAndPersist(); }, 2000);
      // Capture promptly when the panel is hidden or the page is unwound (reload).
      // These are best-effort: the async round-trip may not finish before unload,
      // but the poll above will usually have captured the latest layout already.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { void this.captureAndPersist(); }
      });
      window.addEventListener('pagehide', () => { void this.captureAndPersist(); });
      // Splitter drags and tab moves happen inside the IDE iframe, so listen there
      // for the end of a mouse interaction.
      try {
        const doc = (this.iframe?.contentWindow as any)?.document;
        if (doc) {
          doc.addEventListener('mouseup', () => this.schedulePersist());
        }
      } catch { /* iframe not accessible; poll still covers us */ }
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

    // Override the platform's compile-start hook to announce each compile to the
    // extension with the EXACT source that produced it, so the extension can cache
    // it. Fires for every compile — editor / WARP-V delivery / extension-initiated
    // alike — because the platform funnels them all through ServerCompile.compile,
    // which invokes this once the server assigns the id. `source` is forwarded
    // verbatim in whichever shape compile() received: a plain string (single top
    // file) or a `{files, top}` multi-file payload (top plus m4_include'd siblings);
    // the extension's initCompile() splits the latter into top.tlv + src/ siblings,
    // so extra source files are cached too.
    onCompilationStart(info: { id: string; source: string | { files: Record<string, string>; top?: string }; sim: boolean; dot: boolean }) {
      vscode.postMessage({
        type: 'compileStart',
        id: info.id,
        sim: info.sim,
        dot: info.dot,
        source: info.source
      } as CompileStartMessage);
    }

    // Override _setupCompilationListeners to handle all file streams uniformly
    // Note: This uses internal IdePlugin APIs that may change. Fails gracefully if not available.
    _setupCompilationListeners() {
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

      } catch (error) {
        console.warn('Failed to set up compilation listeners - compilation results will not be cached:', error);
      }
    }
  }

  // Create + initialize the IdePlugin (VSCodeMakerchip). Return the promise so construction failures
  // propagate to the outer .catch() below (otherwise onReady never fires and the
  // extension hangs).
  // @ts-ignore - VSCodeMakerchip derives from an `any`-typed IdePlugin base
  return VSCodeMakerchip.create('webview-makerchip', { hasEditor: false, defaultDarkMode: window.DEFAULT_DARK_MODE, termsAcceptedAt: window.TERMS_ACCEPTED_AT }).then((ide: VSCodeMakerchip) => {
    // Capture layout on resize (see header). The IDE iframe (cross-origin) re-lays itself out by
    // observing its own #ide-root.
    window.addEventListener('resize', () => ide.schedulePersist());
    // Handle messages from the extension host.
    window.addEventListener('message', async (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'test') { return; }
      // Extension's reply to 'restoreRequest': hand off to the class to resolve the
      // internal promise that kickoffRestore() is awaiting.
      if (msg.type === 'restoreData') {
        ide.receiveRestoreData(msg as RestoreDataMessage);
        return;
      }
      if (msg.type === 'ide') {
        // Generic IDE method invocation: { type: 'ide', method: 'methodName', args: [...], requestId?: '...' }
        const { method, args = [], requestId } = msg as IdeMessage;
        try {
          if (!ide.api || typeof ide.api[method] !== 'function') {
            throw new Error(`API method '${method}' not found or not a function`);
          }
          // Gate on restore completion: views must be ready and any restore finished
          // before extension-issued commands run (matches Session.loaded assertion).
          await ide.restoreGate;
          const result = await ide.api[method](...args);
          if (method === 'compile' && typeof result === 'string') { ide.currentCompileId = result; }
          ide.schedulePersist();
          if (result !== undefined || requestId !== undefined) {
            const serialized = await serializeIdeResult(result);
            vscode.postMessage({ type: 'ideResult', method, result: serialized, requestId } as IdeResultMessage);
          }
        } catch (error: any) {
          console.error('[webview] Error calling IDE method:', method, error);
          vscode.postMessage({ type: 'ideError', method, error: error.message, requestId } as IdeErrorMessage);
        }
      }
    });
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
