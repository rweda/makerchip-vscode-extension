/**
 * Makerchip VS Code Extension - Main activation module
 *
 * Provides TL-Verilog development support with:
 *   - Makerchip IDE integration via webview panel(s)
 *   - Language Model tools for AI agents (makerchip_compile, makerchip_ide_call)
 *   - Chat participant (@makerchip)
 *   - Reference data management (clones docs/examples to ~/.vscode-makerchip/resources/)
 *   - Compilation cache (stores results in ~/.vscode-makerchip/compile-cache/)
 *
 * Architecture:
 *   - Global context/panel state for clean API
 *   - Multiple named panels supported
 *   - Generic callIDE() helper for all IDE method invocations
 *   - Unified message protocol: { type: 'ide', method, args }
 *   - Webview compiled separately as ES module (see tsconfig.webview.json)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { initializeResources, updateResources } from './resourceManager';
import { registerMakerchipTool } from './makerchipTool';
import { initToolActivation, getToolActivation } from './toolActivation';
import { registerMakerchipParticipant } from './makerchipParticipant';
import { log } from './logger';
import * as compileCache from './compileCache';

// Default Makerchip server URL
const DEFAULT_SERVER_URL = 'https://beta.makerchip.com';

// How long to wait for a newly opened panel's webview to signal readiness
// before rejecting. Without this, a webview that fails to load (e.g. plugin
// import failure, or a startup race with VS Code) leaves the ready promise
// pending forever, hanging every awaiting caller.
const READY_TIMEOUT_MS = 30_000;

// How long the pre-flight server-reachability probe (see setupPanel) waits for
// any HTTP response before treating the server as unreachable.
const SERVER_PROBE_TIMEOUT_MS = 5_000;

// Track multiple panels by name
const panels = new Map<string, vscode.WebviewPanel>();
const panelReadyPromises = new Map<string, Promise<void>>();
// Explicit server/sandhost URL pinned to a panel when it was opened (the
// imperative "open this panel against this server" hook, e.g. makerchip_compile's
// `serverUrl`). Consulted first by getServerUrl() so the panel — and any later
// reloadPanels of it — stays on the URL it was opened with, overriding tunnel /
// config resolution. Set on open, removed on dispose.
const panelServerUrlOverrides = new Map<string, string>();
// Panels whose server was unreachable at their last render attempt. Such a panel
// stays open (as a placeholder on restore, or on its stale content after a
// failed reloadPanels) but cannot serve IDE calls; ensurePanelReady rejects for
// these with guidance to run "Makerchip: Reload Panels" once the server is back.
// Cleared when a render against a reachable server succeeds.
const degradedPanels = new Set<string>();
// In-flight callIdeMethodWithResult calls, keyed by requestId. Each entry holds the
// resolve/reject of the promise handed back to the caller; the matching 'ideResult'/
// 'ideError' message (or a timeout) settles and removes it. See callIdeMethodWithResult.
const pendingIdeResults = new Map<string, {resolve: (result: any) => void, reject: (error: Error) => void}>();
// Single-slot capture of the most recent reply that arrived AFTER its callIdeMethodWithResult
// call had already timed out (so its pending entry was gone). Overwritten each time; retrieved
// on demand via the 'makerchip.getLateReply' command / makerchip_get_late_reply tool. The
// timestamp + method + requestId let a caller judge whether it is the reply they were awaiting.
let lastLateReply: {requestId: string, method: string, kind: 'result' | 'error', value: any, timestamp: number} | null = null;
let panelCounter = 1;
let requestCounter = 0;
let context: vscode.ExtensionContext;

/**
 * Ensure a Makerchip panel is open and ready to receive messages.
 * @param name Optional panel name. If not provided, uses 'default' for single-panel usage.
 * @param createIfNeeded If true, creates a new panel if it doesn't exist. If false, throws error.
 * @param serverUrl Optional explicit server/sandhost URL to open a NEW panel against
 *   (the imperative open-time hook). Ignored when the panel already exists; pin it
 *   at creation and reloadPanels keeps it. No effect unless createIfNeeded.
 * @returns Promise that resolves when panel is ready
 */
async function ensurePanelReady(name?: string, createIfNeeded: boolean = false, serverUrl?: string): Promise<void> {
  const panelKey = name || 'default';

  if (degradedPanels.has(panelKey)) {
    // The panel exists but its server was unreachable at its last render, so it
    // has no live IDE to talk to. Fail with guidance rather than posting into a
    // placeholder / stale webview where the call would be silently lost.
    throw new Error(
      `Makerchip panel '${panelKey}' is disconnected: its server was unreachable at its last (re)load. ` +
      `Bring the server up and run "Makerchip: Reload Panels" (or ask your AI assistant to reload panels) to reconnect.`
    );
  }

  if (panelReadyPromises.has(panelKey)) {
    // Panel is already open or opening - wait for it. This promise is always
    // bounded: setupPanel arms an overall deadline before any await, so it can
    // never sit pending forever (an interrupted setup rejects and clears itself).
    return panelReadyPromises.get(panelKey)!;
  }

  if (panels.has(panelKey)) {
    // Panel exists but ready promise was cleared - just reveal it. If the panel
    // was disposed without its onDidDispose cleanup completing (e.g. an
    // interrupted setup left a stale entry), reveal() throws "Webview is
    // disposed"; drop the stale tracking and fall through to recreate a fresh
    // panel instead of surfacing the error to the caller.
    try {
      panels.get(panelKey)!.reveal(vscode.ViewColumn.Beside, true);
      return Promise.resolve();
    } catch (err) {
      log(`Makerchip panel '${panelKey}' is stale (${err instanceof Error ? err.message : String(err)}); ` +
          `discarding tracking and recreating.`);
      panels.delete(panelKey);
      panelReadyPromises.delete(panelKey);
      degradedPanels.delete(panelKey);
      panelServerUrlOverrides.delete(panelKey);
      // fall through to (re)create below
    }
  }

  // Panel doesn't exist
  if (!createIfNeeded) {
    const availablePanels = Array.from(panels.keys());
    const panelList = availablePanels.length > 0 ? availablePanels.join(', ') : 'none';
    throw new Error(`Makerchip panel '${panelKey}' is not open. Available panels: ${panelList}. Use makerchip_compile to open a new panel.`);
  }

  // Open new panel and track the ready promise
  const readyPromise = openMakerchipPanel(panelKey, serverUrl);
  panelReadyPromises.set(panelKey, readyPromise);
  return readyPromise;
}

/**
 * Call an IDE method, ensuring the panel is open and ready.
 * @param method IDE method name to invoke
 * @param args Arguments to pass to the method
 * @param panelName Optional panel name to target. Defaults to 'default'.
 * @param createIfNeeded If true, creates panel if it doesn't exist. Default false.
 * @param requestId Optional request ID; when provided, the IDE will echo it back in its reply.
 * @param serverUrl Optional explicit server/sandhost URL to open a NEW panel against
 *   (open-time hook; ignored if the panel already exists).
 */
export async function callIDE(method: string, args?: any[], panelName?: string, createIfNeeded: boolean = false, requestId?: string, serverUrl?: string): Promise<void> {
  const name = panelName || 'default';
  await ensurePanelReady(name, createIfNeeded, serverUrl);
  const panel = panels.get(name);
  if (!panel) {
    throw new Error(`Panel '${name}' not found`);
  }

  const message: Record<string, any> = { type: 'ide', method, args: args || [] };
  if (requestId !== undefined) { message.requestId = requestId; }
  panel.webview.postMessage(message);
}

/**
 * Extension activation entry point called by VS Code.
 * Registers commands, tools, chat participant, and initializes resources.
 * @param ctx Extension context provided by VS Code
 */
export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;  // Store context globally
  log('Makerchip extension activating...');

  // Activation graph (see toolActivation.ts): gates tool availability so the Makerchip suite doesn't
  // pressure the request tool cap. Must init before any env signal or the enable tool is used.
  initToolActivation(context);

  // Environmental holder: base tools auto-activate when the workspace contains any .tlv file.
  const refreshTlvSignal = async () => {
    const found = await vscode.workspace.findFiles('**/*.tlv', undefined, 1);
    getToolActivation()?.setEnv('base', 'tlvFileExists', found.length > 0);
  };
  refreshTlvSignal();
  const tlvWatcher = vscode.workspace.createFileSystemWatcher('**/*.tlv');
  tlvWatcher.onDidCreate(refreshTlvSignal);
  tlvWatcher.onDidDelete(refreshTlvSignal);
  context.subscriptions.push(tlvWatcher);

  // Explicit escape hatch: release everything the agent activated (env holders stay live).
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.releaseAllTools', () => {
      getToolActivation()?.releaseAll();
      vscode.window.showInformationMessage('Makerchip: released all activated tool sets.');
    })
  );

  // Log server configuration on startup
  getServerUrl().then(url => {
    log(`Makerchip Server: ${url}`);
  }).catch(error => {
    log(`⚠ Makerchip server not configured. Panels will not open.`);
  });

  // Register Language Model tool for AI agents (automatic invocation)
  // Both declarative (package.json) and programmatic registration are required
  try {
    registerMakerchipTool(context);
    log('Makerchip tool registered successfully');
  } catch (error) {
    console.error('Failed to register Makerchip tool:', error);
  }

  // Register Chat Participant for @makerchip (user-initiated)
  try {
    registerMakerchipParticipant(context);
  } catch (error) {
    console.error('Failed to register Makerchip chat participant:', error);
  }

  // Initialize resources (clone/update repos and install skill)
  initializeResources(context).catch(error => {
    console.error('Failed to initialize Makerchip reference data:', error);
  });

  // Cleanup old cache entries on activation
  compileCache.cleanupOldEntries().catch(error => {
    console.error('Failed to cleanup old cache entries:', error);
  });

  // Restore Makerchip panels after a VS Code reload. VS Code recreates the
  // webview and hands us its persisted state ({ panelKey, compileId, layoutState });
  // we re-wire it and let the webview inject cached results (or recompile).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('makerchip', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
        const panelKey = state?.panelKey || 'default';
        log(`Restoring Makerchip panel '${panelKey}' after reload`);
        // Keep auto-generated names ('Panel N') unique across reloads: advance the
        // counter past any restored panel so a later compileNew won't collide.
        const numbered = /^Panel (\d+)$/.exec(panelKey);
        if (numbered) {
          const n = parseInt(numbered[1], 10);
          if (n >= panelCounter) { panelCounter = n + 1; }
        }
        const readyPromise = setupPanel(panel, panelKey, true);
        panelReadyPromises.set(panelKey, readyPromise);
        // Swallow rejection so an unhandled promise doesn't surface; callers that
        // need readiness go through ensurePanelReady() which observes this promise.
        readyPromise.catch(err => log(`Restored panel '${panelKey}' failed to become ready: ${err.message}`));
      }
    })
  );

  // COMPILE/SIMULATE COMMAND (uses default panel)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compile', async () => {

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      const code = editor.document.getText();

      // Call IDE to compile the code (default panel, creating it if needed)
      await callIDE('compile', [code], 'default', true);
    })
  );

  // COMPILE/SIMULATE IN AUTO-NAMED PANEL COMMAND (sequential naming)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compileNew', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      const code = editor.document.getText();
      const panelName = `Panel ${panelCounter++}`;
      await callIDE('compile', [code], panelName, true);
    })
  );

  // COMPILE/SIMULATE IN PANEL COMMAND (with panel selection)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.compileNamed', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to compile");
        return;
      }

      // Build QuickPick items: existing panels + new panel option
      const existingPanels = Array.from(panels.keys());
      const items: vscode.QuickPickItem[] = [
        ...existingPanels.map(name => ({
          label: name,
          description: name === 'default' ? '(current)' : ''
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem,
        { label: '$(add) New Panel...', alwaysShow: true }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select panel or create new one'
      });

      if (!selected) return; // User cancelled

      let panelName: string;
      if (selected.label === '$(add) New Panel...') {
        // Prompt for new panel name
        const input = await vscode.window.showInputBox({
          prompt: 'Enter panel name (or leave empty for auto-generated)',
          placeHolder: `Panel ${panelCounter}`
        });
        if (input === undefined) return; // User cancelled
        panelName = input.trim() || `Panel ${panelCounter++}`;
      } else {
        panelName = selected.label;
      }

      const code = editor.document.getText();
      await callIDE('compile', [code], panelName, true);
    })
  );

  // UPDATE REFERENCE DATA COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.updateResources', async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Updating Makerchip reference data...',
            cancellable: false
          },
          async () => {
            await updateResources(context);
          }
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to update reference data: ${error.message}`);
      }
    })
  );

  // INVOKE IDE METHOD COMMAND (used by the Language Model tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.invokeIdeMethod', async (method: string, args: any[] = [], panelName?: string, createIfNeeded: boolean = false) => {
      await callIDE(method, args, panelName, createIfNeeded);
    })
  );

  // BUS EMIT COMMAND (publish an application event onto the IDE bus as a `platform` participant).
  // Optional `agent` tags who the platform emits on behalf of: omitted -> source "platform";
  // otherwise source "platform.<agent>" (e.g. agent "ai" -> "platform.ai").
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.busEmit', async (type: string, payload: any, target?: string | string[], agent?: string, panelName?: string) => {
      await callIDE('busEmit', [type, payload, target, agent], panelName, false);
    })
  );

  // INVOKE IDE METHOD AND RETURN RESULT (used by tools that need return values)
  //
  // The webview bridge is fire-and-forget (postMessage), so obtaining a return value
  // requires correlating a reply with its request. We do that with a unique requestId:
  //   1. Register a promise in `pendingIdeResults` keyed by requestId, BEFORE posting,
  //      so a fast reply can never arrive before its handler entry exists.
  //   2. Post the method call via callIDE with that requestId (the webview echoes it back).
  //   3. The webview runs the IDE method and posts an 'ideResult' / 'ideError' carrying the
  //      same requestId; the onDidReceiveMessage handler below looks the entry up and
  //      resolves / rejects this promise.
  //   4. A timeout rejects and removes the entry if no reply arrives, so a lost or hung
  //      reply neither leaks a map entry nor hangs the caller forever.
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.callIdeMethodWithResult', async (method: string, args: any[] = [], panelName?: string, createIfNeeded: boolean = false, timeoutMs: number = 10000, serverUrl?: string): Promise<any> => {
      const requestId = `req_${++requestCounter}`;
      const resultPromise = new Promise<any>((resolve, reject) => {
        // Step 1: register the callbacks before the call is posted (step 2 below) so the
        // reply handler (step 3) is guaranteed to find this entry.
        pendingIdeResults.set(requestId, { resolve, reject });
        // Step 4: safety net — if no reply arrives, reject and unregister. The default 10s suits
        // synchronous IDE methods; callers awaiting a slow downstream op (e.g. a pane RPC that
        // runs a compile) pass a larger timeoutMs.
        setTimeout(() => {
          if (pendingIdeResults.has(requestId)) {
            pendingIdeResults.delete(requestId);
            console.error(`[callIdeMethodWithResult] Timeout for request ${requestId} (method: ${method})`);
            reject(new Error(`Timeout waiting for IDE method '${method}' result. If a late result arrives it can be retrieved with the makerchip_get_late_reply tool.`));
          }
        }, timeoutMs);
      });

      // Step 2: post the call. callIDE is the single posting site (it also tracks compile
      // source); the requestId travels with the message for the webview to echo back.
      await callIDE(method, args, panelName, createIfNeeded, requestId, serverUrl);

      // Settled later by the 'ideResult'/'ideError' handler (step 3) or the timeout (step 4).
      return resultPromise;
    })
  );

  // RETRIEVE LATE REPLY
  //
  // Returns the most recent reply that arrived after its callIdeMethodWithResult call had
  // already timed out, or null if none has been captured. Single slot, not cleared on read,
  // so a caller can re-check; the timestamp/method/requestId let it confirm the match.
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.getLateReply', async () => lastLateReply)
  );

  // LIST PANELS COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.listPanels', async () => {
      if (panels.size === 0) {
        vscode.window.showInformationMessage('No Makerchip panels currently open');
        return;
      }
      const panelNames = Array.from(panels.keys()).join(', ');
      vscode.window.showInformationMessage(`Open Makerchip panels: ${panelNames}`);
    })
  );

  // GET PANEL NAMES COMMAND (for tools)
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.getPanelNames', async (): Promise<string[]> => {
      return Array.from(panels.keys());
    })
  );

  // HIGHLIGHT ENTITY COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.highlight', async () => {
      const id = await vscode.window.showInputBox({
        prompt: 'Enter TL-Verilog path to highlight',
        placeHolder: 'e.g., /cpu|my_pipe$data, |fetch@1, /cpu',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Path cannot be empty';
          }
          return null;
        }
      });

      if (id) {
        await callIDE('highlight', [id.trim(), false]);
        vscode.window.showInformationMessage(`Highlighted: ${id.trim()}`);
      }
    })
  );

  // CLEAR HIGHLIGHTS COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.clearHighlights', async () => {
      await callIDE('clearHighlights', []);
      vscode.window.showInformationMessage('Cleared all highlights');
    })
  );

  // RELOAD PANELS COMMAND
  //
  // Reload every open Makerchip webview against the freshly-resolved server URL
  // (getServerUrl() reads the clone's sandhost/TUNNEL_INFO / configuration).
  // Recovers already-open panels without a full window reload in two cases:
  //   - the sandserv backend was restarted (same URL, dropped connections), or
  //   - the dev tunnel was recreated by ./launch (new URL after the old died).
  // Also exposed to AI agents as the makerchip_reload_panels tool.
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.reloadPanels', async (): Promise<{ serverUrl: string; panels: string[] }> => {
      const reloaded: string[] = [];
      const failed: string[] = [];
      for (const [key, panel] of panels) {
        // Re-rendering the HTML reloads the IDE iframe (reconnecting to its URL).
        // Resolve per panel so a panel with a dev override keeps its own server.
        // The panel's existing message handler stays attached and handles the fresh
        // 'ready'/results, so no re-wiring is required.
        const url = await getServerUrl(key);
        // Probe first: don't blank a working panel by reloading it against a dead
        // server (e.g. a tunnel that hasn't been recreated yet). Leave unreachable
        // panels on their existing content, mark them degraded, and report them.
        try {
          await probeServerReachable(url);
        } catch (error: any) {
          failed.push(key);
          degradedPanels.add(key);
          const errorMsg = error.message || String(error);
          log(`Skipped reloading panel '${key}': ${errorMsg}`);
          vscode.window.showErrorMessage(errorMsg);
          continue;
        }
        panel.webview.html = buildWebviewHtml(panel, key, url);
        degradedPanels.delete(key);
        log(`Reloaded panel '${key}' against ${url}`);
        reloaded.push(key);
      }
      // Representative URL for the summary (default resolution, no panel override).
      const serverUrl = await getServerUrl();
      log(`Reloaded ${reloaded.length} panel(s)${failed.length ? `, skipped ${failed.length} unreachable` : ''}`);
      return { serverUrl, panels: reloaded };
    })
  );

  // FETCH INTERMEDIATE FILES COMMAND
  //
  // Pull a compile's announced SandPiper intermediate/output files (top.m4.pre, top.m4,
  // top.sv, top_gen.sv) from the server's results route into the compile's cache dir, so
  // agents can read the emitted (System)Verilog locally. Kept here (not in compileCache)
  // so the server URL resolves via getServerUrl(), honoring any per-panel override.
  // Backs the makerchip_compile / makerchip_wait_compile `fetchIntermediateFiles` option.
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.fetchIntermediateFiles', async (compileId: string, panelName?: string) => {
      // Resolve the server the compile ran on. When the caller doesn't name a panel, fall back to
      // the panel recorded in the compile's metadata (initCompile), so intermediate files can be
      // fetched for any prior compile without a caller-supplied panel argument.
      const key = panelName ?? (await compileCache.loadMetadata(compileId))?.panelName ?? undefined;
      const url = await getServerUrl(key);
      return await compileCache.fetchIntermediateFiles(compileId, url);
    })
  );

  // To debug webviews: Help > Toggle Developer Tools, then inspect the webview <iframe> element
}

/**
 * Open a new Makerchip webview panel and initialize it with the IDE.
 * @param panelKey Unique identifier for this panel instance
 * @param serverUrl Optional explicit server/sandhost URL to pin this panel to
 *   (the open-time hook). When given, it is recorded so getServerUrl() — and any
 *   later reloadPanels of this panel — resolve to it, overriding tunnel/config.
 * @returns Promise that resolves when the IDE is ready
 */
async function openMakerchipPanel(panelKey: string, serverUrl?: string): Promise<void> {
  if (serverUrl) {
    panelServerUrlOverrides.set(panelKey, serverUrl);
  }
  const displayName = panelKey === 'default' ? 'Makerchip IDE' : `Makerchip: ${panelKey}`;
  const panel = vscode.window.createWebviewPanel(
    'makerchip', displayName,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true  // Prevent reload on move/hide
    }
  );
  return setupPanel(panel, panelKey);
}

/**
 * Lightweight reachability probe for a Makerchip server/tunnel URL, used to fail
 * fast (before loading a webview) instead of waiting out the readiness timeout.
 * ANY HTTP response counts as "up" (status is ignored); only a connection error,
 * DNS/TLS failure, or no response within {@link SERVER_PROBE_TIMEOUT_MS} throws.
 * Runs in the extension host (Node fetch), so unlike the webview it is NOT
 * subject to webview CSP -- e.g. it will not catch a plain http:// URL that the
 * webview refuses (that surfaces later via the webview's 'initError').
 * @param serverUrl The server/tunnel base URL to probe.
 * @throws Error with a human-readable reason when the server is unreachable.
 */
async function probeServerReachable(serverUrl: string): Promise<void> {
  const controller = new AbortController();
  const probeTimeout = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    await fetch(serverUrl, { method: 'GET', signal: controller.signal });
  } catch (error: any) {
    const reason = error?.name === 'AbortError'
      ? `no response within ${SERVER_PROBE_TIMEOUT_MS / 1000}s`
      : (error?.message || String(error));
    throw new Error(`Makerchip server is not reachable (${serverUrl}): ${reason}`);
  } finally {
    clearTimeout(probeTimeout);
  }
}

/**
 * Build a static placeholder page shown when a panel is RESTORED (after a VS
 * Code reload) while its server is unreachable. Instead of disposing the panel
 * (losing it), we keep it and render this, so bringing the server back and
 * running "Makerchip: Reload Panels" re-renders the real IDE and restores the
 * panel's persisted compile/layout. No script (default-src 'none'); the panel's
 * persisted webview state is untouched because this page never calls setState.
 * @param serverUrl The server/tunnel URL that could not be reached.
 * @param reason Human-readable reason from the reachability probe.
 */
function buildUnreachablePlaceholderHtml(serverUrl: string, reason: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); padding: 2rem; line-height: 1.5; }
    code { background: var(--vscode-textCodeBlock-background); padding: 0.1em 0.35em; border-radius: 3px; }
    .muted { opacity: 0.8; }
  </style>
</head>
<body>
  <h2>Makerchip server unreachable</h2>
  <p>This panel could not reconnect to its server when it was restored:</p>
  <p><code>${esc(serverUrl)}</code></p>
  <p class="muted">${esc(reason)}</p>
  <p>Start (or restore) the server, then run <b>“Makerchip: Reload Panels”</b> from the Command Palette (or ask your AI assistant to reload panels) to reconnect. Your last compilation and layout will be restored.</p>
</body>
</html>`;
}

/**
 * Build the webview HTML for a Makerchip panel, pointed at a given server URL.
 * Setting the returned string as `panel.webview.html` (re)loads the IDE iframe;
 * reusing it with a fresh URL is how {@link makerchip.reconnectTunnel} repoints
 * an already-open panel at a newly created tunnel without reopening the window.
 * @param panel The webview panel the HTML is for (used to resolve the script URI).
 * @param panelKey Unique identifier for this panel instance.
 * @param serverUrl The Makerchip server/tunnel URL the IDE should connect to.
 */
function buildWebviewHtml(panel: vscode.WebviewPanel, panelKey: string, serverUrl: string): string {
  const nonce = getNonce();

  // Get webview URI for the script file
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.js')
  );

  // Detect VS Code theme to match Makerchip IDE dark mode
  const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
                      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

  // Load HTML template and replace placeholders
  const htmlPath = path.join(context.extensionPath, 'out', 'webview.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/{{nonce}}/g, nonce);
  html = html.replace(/{{scriptUri}}/g, scriptUri.toString());
  html = html.replace(/{{serverUrl}}/g, serverUrl);
  html = html.replace(/{{defaultDarkMode}}/g, isDarkTheme.toString());
  html = html.replace(/{{panelKey}}/g, panelKey);
  return html;
}

/**
 * Wire up a Makerchip webview panel (HTML, readiness timeout, message handlers).
 * Shared by {@link openMakerchipPanel} (fresh panels) and the webview panel
 * serializer (panels restored after a VS Code reload).
 * @param panel The webview panel to initialize (freshly created or restored).
 * @param panelKey Unique identifier for this panel instance.
 * @param isRestore True when called from the webview serializer to restore a
 *   panel after a VS Code reload. In that case an unreachable server keeps the
 *   panel as a recoverable placeholder instead of disposing it; for a fresh
 *   open (false) an unreachable server fails fast and disposes.
 * @returns Promise that resolves when the IDE is ready.
 */
function setupPanel(panel: vscode.WebviewPanel, panelKey: string, isRestore: boolean = false): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // Guard so the promise settles exactly once, and a timeout guards against
    // a webview that never signals readiness.
    let settled = false;

    let readyTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearReadyTimeout = () => {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
    };

    const settleResolve = () => {
      if (settled) { return; }
      settled = true;
      clearReadyTimeout();
      resolve();
    };

    // Reject the ready promise and tear down the panel this invocation created,
    // so a later call can retry with a clean slate. We only evict tracking that
    // still refers to THIS panel: a newer open for the same key may have already
    // replaced us in the maps, and disposing/evicting its state would re-corrupt
    // exactly the way an interrupted setup used to. Disposing our own panel is
    // idempotent and triggers onDidDispose (also identity-guarded).
    const settleReject = (err: Error) => {
      if (settled) { return; }
      settled = true;
      clearReadyTimeout();
      if (panels.get(panelKey) === panel) {
        panels.delete(panelKey);
        getToolActivation()?.setEnv('base', 'panelOpen', panels.size > 0);
        panelReadyPromises.delete(panelKey);
        degradedPanels.delete(panelKey);
        panelServerUrlOverrides.delete(panelKey);
      }
      panel.dispose();
      reject(err);
    };

    // Arm an overall readiness deadline UP FRONT, before any await (server-URL
    // resolution, the reachability probe, or waiting for the webview 'ready').
    // Whatever phase stalls, the promise can never sit pending forever;
    // settleResolve/settleReject clear it. (The reachable branch below used to
    // arm this only after the probe, leaving a pre-probe stall unguarded.)
    readyTimeout = setTimeout(() => {
      settleReject(new Error(
        `Makerchip panel '${panelKey}' did not become ready within ${READY_TIMEOUT_MS / 1000}s.`
      ));
    }, READY_TIMEOUT_MS);

    // Create display name
    const displayName = panelKey === 'default' ? 'Makerchip IDE' : `Makerchip: ${panelKey}`;

    // Ensure scripts are enabled. Required for panels restored by the serializer
    // (VS Code does not preserve WebviewOptions across reloads); harmless for
    // freshly-created panels.
    panel.webview.options = { enableScripts: true };

    // Store panel in map
    panels.set(panelKey, panel);
    // Environmental holder: base tools auto-activate while any Makerchip panel is open.
    getToolActivation()?.setEnv('base', 'panelOpen', panels.size > 0);

    // Get server URL - required, no default fallback. Pass panelKey so a
    // per-panel dev override (makerchip.devServerUrls) can apply.
    let serverUrl: string;
    try {
      serverUrl = await getServerUrl(panelKey);
      log(`Opening ${displayName}...`);
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to get server URL';
      vscode.window.showErrorMessage(errorMsg);
      settleReject(error instanceof Error ? error : new Error(errorMsg));
      return;
    }

    // Probe reachability so we don't open a webview against a dead server and
    // wait out the 30s readiness timeout.
    let reachable = true;
    let probeError = '';
    try {
      await probeServerReachable(serverUrl);
    } catch (error: any) {
      reachable = false;
      probeError = error?.message || String(error);
    }

    if (!reachable && !isRestore) {
      // Fresh open (makerchip_compile) against an unreachable server: fail fast
      // and dispose, so the caller gets a clear error and no zombie panel.
      vscode.window.showErrorMessage(probeError);
      settleReject(new Error(probeError));
      return;
    }

    if (reachable) {
      // Server is up: render the real IDE and wait for it to signal 'ready'. The
      // overall readiness deadline was already armed at the top of setupPanel, so
      // a webview that never posts 'ready' still rejects instead of hanging.
      degradedPanels.delete(panelKey);
      panel.webview.html = buildWebviewHtml(panel, panelKey, serverUrl);
    } else {
      // Restoring a panel after a VS Code reload while the server is down: keep
      // the panel as a recoverable placeholder instead of disposing it, so
      // bringing the server back and running "Makerchip: Reload Panels" restores
      // it (its persisted compileId/layout are re-applied on the next render).
      // Mark it degraded so a compile targeted at it meanwhile fails with a
      // clear message. The message handler and onDidDispose below are still
      // wired up, so the recovery re-render (which does not re-run setupPanel)
      // is handled and cleanup still happens.
      degradedPanels.add(panelKey);
      panel.webview.html = buildUnreachablePlaceholderHtml(serverUrl, probeError);
      log(`Restored panel '${panelKey}' is degraded: server unreachable (${serverUrl}). ` +
          `Run "Makerchip: Reload Panels" once it's back to reconnect.`);
      settleResolve();
    }

    // Handle messages from webview: IDE ready state, compilation results, errors, and method responses
    panel.webview.onDidReceiveMessage(async (msg) => {
      // Only log message type, not the entire payload (which can be huge for VCD data)
      if (msg.type !== 'compileFileChunk') {
        log(`[webview → extension] ${msg.type}`);
      }

      if (msg.type === 'ready') {
        log(`✓ Connected to ${serverUrl}`);
        settleResolve();   // 🔹 resolve when IDE is ready
      }

      if (msg.type === 'initError') {
        // Webview reported an initialization failure - reject now rather than
        // waiting for the ready timeout.
        settleReject(new Error(`Makerchip webview failed to initialize: ${msg.error}`));
      }

      if (msg.type === 'notification') {
        // Generic notification message (info/warning/error)
        log(`[${msg.severity.toUpperCase()}] ${msg.message}`);

        if (msg.severity === 'error') {
          vscode.window.showErrorMessage(msg.message);
        } else if (msg.severity === 'warning') {
          vscode.window.showWarningMessage(msg.message);
        } else if (msg.severity === 'info') {
          vscode.window.showInformationMessage(msg.message);
        }
      }

      if (msg.type === 'ideResult') {
        // Step 3 of callIdeMethodWithResult (success): match this reply to the promise registered by
        // callIdeMethodWithResult via its requestId, then resolve and unregister it.
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          const { resolve: resolveResult } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          resolveResult(msg.result);
        } else if (msg.requestId) {
          // No matching entry: the request already timed out (step 4) or was never registered.
          // Capture it as the late reply so a caller that gave up can still retrieve it.
          lastLateReply = {requestId: msg.requestId, method: msg.method, kind: 'result', value: msg.result, timestamp: Date.now()};
          console.warn(`[ideResult] Late result for timed-out request ${msg.requestId} (method: ${msg.method})`);
        }
        // Note: the cache entry for a compile is initialized from the server's
        // 'compileStart' (newcompile) event, which also reports sim/dot.
      }

      if (msg.type === 'ideError') {
        console.error(`[ideError] ${msg.method}: ${msg.error}`);
        // Step 3 of callIdeMethodWithResult (failure): mirror the ideResult path — match by requestId and reject.
        if (msg.requestId && pendingIdeResults.has(msg.requestId)) {
          const { reject } = pendingIdeResults.get(msg.requestId)!;
          pendingIdeResults.delete(msg.requestId);
          reject(new Error(msg.error));
        } else if (msg.requestId) {
          // No matching entry: the request already timed out (step 4) or was never registered.
          // Capture it as the late reply so a caller that gave up can still retrieve it.
          lastLateReply = {requestId: msg.requestId, method: msg.method, kind: 'error', value: msg.error, timestamp: Date.now()};
          console.warn(`[ideError] Late error for timed-out request ${msg.requestId} (method: ${msg.method})`);
        }
      }

      if (msg.type === 'compileStart') {
        // Server accepted a compile (newcompile). Initialize the cache entry with
        // the source (announced by the webview, which captured it at the compile call
        // site) and the expected output set (sim → waveform, dot → diagram).
        log(`Compile started: ${msg.id} (sim=${msg.sim}, dot=${msg.dot})`);
        try {
          await compileCache.initCompile(msg.id, msg.source, {
            sim: msg.sim,
            dot: msg.dot,
            panelName: panelKey
          });
        } catch (error) {
          console.error('Failed to initialize compile cache:', error);
        }
      }

      if (msg.type === 'compileFileChunk') {
        // Cache compilation result file chunks (stdall, make.out, or vlt_dump.vcd)
        try {
          await compileCache.appendFile(msg.id, msg.fileName, msg.chunk);
          if (msg.complete) {
            await compileCache.completeFile(msg.id, msg.fileName);
            log(`✓ ${msg.fileName} complete`);
          }
        } catch (error) {
          console.error(`Failed to cache ${msg.fileName} chunk:`, error);
        }
      }

      if (msg.type === 'compileError') {
        // Record compilation error against the specific file (or compilation level
        // for a SandPiper-stage failure).
        log(`Compile error: ${msg.errorType}`);
        try {
          await compileCache.recordFileError(msg.id, msg.errorType);
        } catch (error) {
          console.error('Failed to record compile error:', error);
        }
      }

      if (msg.type === 'compileExitStatus') {
        // Record exit status from compilation stage
        log(`${msg.stage} exit: ${msg.exitCode}`);
        try {
          await compileCache.recordExitStatus(msg.id, msg.stage, msg.exitCode);
        } catch (error) {
          console.error('Failed to record exit status:', error);
        }
      }

      if (msg.type === 'compileDenied') {
        // Show denial message to user
        log(`Compilation denied: ${msg.reason}`);
        const retryMsg = msg.retryAfterSeconds ? ` Retry after ${msg.retryAfterSeconds} seconds.` : '';
        vscode.window.showWarningMessage(`Compilation denied: ${msg.message}${retryMsg}`);
      }

      if (msg.type === 'restoreRequest') {
        // Webview reloaded and is asking for cached results to restore the IDE.
        log(`Restore requested for compile ${msg.compileId}`);
        try {
          const data = await compileCache.getRestoreData(msg.compileId);
          log(`Restore data for ${msg.compileId}: available=${data.available} files=[${data.files ? Object.keys(data.files).join(',') : ''}] hasSource=${data.source != null} exitStatus=${JSON.stringify(data.exitStatus)}`);
          panel.webview.postMessage({
            type: 'restoreData',
            compileId: msg.compileId,
            available: data.available,
            files: data.files,
            exitStatus: data.exitStatus,
            sandpiperFailed: data.sandpiperFailed,
            source: data.source
          });
        } catch (error) {
          console.error('Failed to load restore data:', error);
          panel.webview.postMessage({ type: 'restoreData', compileId: msg.compileId, available: false });
        }
      }
    });

    panel.onDidDispose(() => {
      clearReadyTimeout();
      // If the panel is closed before it ever became ready, reject any pending
      // waiter so it doesn't hang.
      if (!settled) {
        settled = true;
        reject(new Error(`Makerchip panel '${panelKey}' was closed before it became ready.`));
      }
      // Only clear tracking that still points at THIS panel. Disposing an old,
      // interrupted panel must not evict a newer panel that has already reclaimed
      // the key (that cross-eviction is what corrupted the 'default' panel state).
      if (panels.get(panelKey) === panel) {
        panels.delete(panelKey);
        getToolActivation()?.setEnv('base', 'panelOpen', panels.size > 0);
        panelReadyPromises.delete(panelKey);
        degradedPanels.delete(panelKey);
        panelServerUrlOverrides.delete(panelKey);
      }
    });
  });
}

/**
 * Extension deactivation cleanup.
 * Called by VS Code when the extension is deactivated.
 */
export function deactivate() {}

/**
 * Generate a random nonce for Content Security Policy in webview.
 * @returns 16-character random string
 */
function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/**
 * Read a TUNNEL_URL from a ./launch tunnel state file (a clone's
 * sandhost/TUNNEL_INFO).
 * @param file Absolute path to a tunnel state file.
 * @returns The tunnel URL, or undefined if absent/invalid.
 */
function readTunnelUrl(file: string): string | undefined {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const url = content.match(/TUNNEL_URL=(.+)/)?.[1]?.trim();
    if (url && url.startsWith('http')) return url;
  } catch (err) {
    // A missing file is the normal "no tunnel currently up for this clone" case
    // (e.g. SandHost not started, or tunnel torn down); stay quiet and let the
    // caller fall through. Warn only when the file exists but can't be read
    // (present-but-broken), which is a real problem worth surfacing.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log(`Warning: Failed to read tunnel state file ${file}: ${err}`);
    }
  }
  return undefined;
}

/**
 * Get the Makerchip server URL from (highest priority first):
 * 0. Per-panel dev override (`makerchip.devServerUrls[panelKey]`): a map of
 *    panel name -> server URL for development only. Lets specific panels load
 *    from a different mono clone (e.g. an FDC3 spike) while others resolve
 *    normally. Empty by default, so it is inert in production and adds no
 *    language-model tool surface (panels are still targeted via `panelName`).
 *    Only consulted when a `panelKey` is supplied.
 * 1. MAKERCHIP_SERVER_URL env (set by `./launch <url>`): an explicit, static
 *    server URL (e.g. production). Fine to freeze since it never changes.
 * 2. The clone identified by `./launch <clone>` (clone mode), passed as its
 *    absolute root in MAKERCHIP_MONO_CLONE. `./launch` records the Cloudflare
 *    tunnel in <clone>/sandhost/TUNNEL_INFO, and we read that file directly. Read
 *    FRESH each call, so Reload Panels picks up a tunnel that ./launch recreated
 *    (e.g. on a new URL) without a reopen — the clone path is stable even though
 *    the tunnel URL is not, which is why we key off the clone rather than freezing
 *    a URL into the environment.
 * 3. Discovery fallback for the F5 debug flow: scan the open workspace folders for
 *    a clone's sandhost/TUNNEL_INFO and use the first live one. F5 ("Run Extension")
 *    can't set env vars, so this is the only way to point a breakpoint-capable EDH
 *    at a clone — the developer adds the clone as a workspace folder and reloads.
 *    GATED on MAKERCHIP_LAUNCH being UNSET: when `./launch` opened this EDH it is
 *    authoritative (priorities 1/2 above), so we never second-guess it by scanning
 *    whatever folders happen to be open. Read FRESH each call, like priority 2.
 * 4. VS Code configuration (makerchip.serverUrl)
 * 5. Default: DEFAULT_SERVER_URL
 * @param panelKey Panel name whose dev override (priority 0) should apply, if any.
 */
async function getServerUrl(panelKey?: string): Promise<string> {
  // 0. Imperative per-panel server pinned at open time (makerchip_compile's
  //    `serverUrl` hook). Highest priority so the panel and its reloads stay on
  //    the URL it was opened with.
  if (panelKey) {
    const pinned = panelServerUrlOverrides.get(panelKey);
    if (pinned) {
      log(`Using server URL pinned to panel '${panelKey}' at open: ${pinned}`);
      return pinned;
    }
  }

  // 0b. Per-panel dev override from configuration (makerchip.devServerUrls), keyed by panel name.
  if (panelKey) {
    const overrides = vscode.workspace.getConfiguration('makerchip').get<Record<string, string>>('devServerUrls') ?? {};
    const override = overrides[panelKey];
    if (override) {
      log(`Using dev server URL override for panel '${panelKey}': ${override}`);
      return override;
    }
  }

  // 1. Explicit static server URL pinned by ./launch (url mode).
  const pinnedUrl = process.env.MAKERCHIP_SERVER_URL;
  if (pinnedUrl) {
    log(`Using server URL from MAKERCHIP_SERVER_URL: ${pinnedUrl}`);
    return pinnedUrl;
  }

  // 2. The clone identified by ./launch (clone mode) is passed as its absolute
  //    root in MAKERCHIP_MONO_CLONE. Read <clone>/sandhost/TUNNEL_INFO fresh each
  //    call so Reload Panels tracks a tunnel ./launch recreated; the clone path is
  //    stable even though the tunnel URL changes on recreation. ./launch resolves
  //    the clone, so we read it directly rather than scanning (that scan is the
  //    priority-3 F5 fallback below, deliberately skipped for a ./launch EDH).
  const cloneDir = process.env.MAKERCHIP_MONO_CLONE;
  if (cloneDir) {
    const infoFile = path.join(cloneDir, 'sandhost', 'TUNNEL_INFO');
    const url = readTunnelUrl(infoFile);
    if (url) {
      log(`Using server URL from clone tunnel (${infoFile}): ${url}`);
      return url;
    }
    log(`MAKERCHIP_MONO_CLONE=${cloneDir} but no live tunnel at ${infoFile}; falling through.`);
  }

  // 3. Discovery fallback (F5 debug flow only): ./launch did NOT open this EDH
  //    (MAKERCHIP_LAUNCH unset), so nothing pinned the server via env — scan the
  //    open workspace folders for a clone's sandhost/TUNNEL_INFO. This is how a
  //    breakpoint-capable F5 EDH is pointed at a clone: add the clone as a
  //    workspace folder and reload. Skipped entirely for a ./launch EDH so its
  //    explicit choice is never overridden by whatever folders happen to be open.
  //    readTunnelUrl is silent on ENOENT, so non-clone folders don't warn.
  if (!process.env.MAKERCHIP_LAUNCH) {
    const found: { infoFile: string; url: string }[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const infoFile = path.join(folder.uri.fsPath, 'sandhost', 'TUNNEL_INFO');
      const url = readTunnelUrl(infoFile);
      if (url) {
        found.push({ infoFile, url });
      }
    }
    if (found.length > 0) {
      if (found.length > 1) {
        log(
          `Warning: ${found.length} open workspace folders expose a SandHost tunnel; ` +
            `using the first. Remove the others from the workspace to disambiguate. ` +
            `Candidates: ${found.map((f) => `${f.infoFile} -> ${f.url}`).join(', ')}`,
        );
      }
      log(`Using server URL discovered in workspace folder: ${found[0].url} (${found[0].infoFile})`);
      return found[0].url;
    }
  }

  // 4. Check VS Code configuration
  const config = vscode.workspace.getConfiguration('makerchip');
  const configUrl = config.get<string>('serverUrl');
  if (configUrl) {
    log(`Using server URL from configuration: ${configUrl}`);
    return configUrl;
  }

  // 5. Use default
  log(`Using default server URL: ${DEFAULT_SERVER_URL}`);
  return DEFAULT_SERVER_URL;
}
