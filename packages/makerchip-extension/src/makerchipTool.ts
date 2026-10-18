import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import * as compileCache from './compileCache';
import { MAKERCHIP_DIR, RESOURCES_DIR, CACHE_DIR } from './populateResources';
import { CeCompileTool } from './ceCompile';
import { EnableToolsTool, getToolActivation } from './toolActivation';

interface MakerchipToolInput {
  /**
   * Optional file path to open and compile. Read from disk if provided (not the editor buffer,
   * so be sure to save the editor buffer to disk first). If not provided, uses the active editor buffer.
   */
  filePath?: string;
  /**
   * Inline TL-Verilog code to compile (or `true` for default code). If a string is provided,
   * creates a new unsaved document with this code. Pass `true` to instead open the bundled
   * minimal scratch design (`~/.vscode-makerchip/minimal.tlv`) — the easy way to just open a
   * panel (e.g. to work with custom panes, the layout, or IDE tooling) without creating a
   * throwaway `.tlv` file.
   */
  code?: string | boolean;
  /**
   * One-shot mode: compile the given `code`/`filePath` directly into the panel WITHOUT opening
   * an editor (so there is nothing to edit). Use it to open a panel for pane/layout/IDE-tooling
   * work, or to run a design once, without leaving an editor tab behind.
   */
  oneShot?: boolean;
  /**
   * Optional paths to additional TL-Verilog source files to compile alongside the top file
   * (e.g. files pulled in via `m4_include_lib`). Each is read from disk (so be sure to save first)
   * and made available to the compiler under its basename, so `m4_include_lib(['./lib.tlv'])`
   * in the top file resolves. The basenames must be unique and none may be `top.tlv` (reserved
   * for the top file).
   */
  additionalFiles?: string[];
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
  /**
   * Development hook: open the panel against this explicit sandhost/server base URL
   * (e.g. `https://beta.makerchip.com`), overriding the normal resolution (clone tunnel /
   * `makerchip.serverUrl` / default). Only applies when a NEW panel is created for this
   * call; the URL is pinned to the panel so reloads keep it. Must be an `https://` origin
   * (webviews require TLS). Omit to use the normal server resolution.
   */
  serverUrl?: string;
  /**
   * Seconds to wait (in-process) for the compilation to complete before returning.
   * When > 0 (default 30), the tool blocks up to this long and returns a status
   * summary (exit codes, pass/fail, and a log excerpt on failure) so agents don't
   * need to poll `metadata.json` via the shell. If the compile is still running when
   * the timeout elapses, use `makerchip_wait_compile` with the returned compile ID to
   * keep waiting. Set to 0 to return immediately with just the compile ID.
   */
  waitSeconds?: number;
  /**
   * When false (default), the wait returns as soon as the core results (compile +
   * simulation) are settled, WITHOUT waiting for the diagram (SVG), whose render
   * can lag or time out well after the compile finishes. Set true to also wait for
   * the diagram (e.g. before capturing it or ensuring IDE shows it).
   */
  waitForDiagram?: boolean;
  /**
   * A `compile` option, forwarded in the plugin's `compile(code, opts, settings)` `opts` object:
   * whether to run the Verilator simulation after Verilog generation (default true). Pass false
   * for a faster Verilog-only (model) run — the diagram and emitted (System)Verilog are still
   * produced, but no waveform (vlt_dump.vcd) is generated.
   */
  sim?: boolean;
  /**
   * A `compile` option, forwarded in the plugin's `compile(code, opts, settings)` `opts` object:
   * whether to generate the diagram/SVG (default true). No other results are affected.
   * The IDE's diagram pane shows no-result status.
   * Note: If more options are added to `opts`, consider exposing `opts` (with `sim`/`dot` inside).
   */
  dot?: boolean;
  /**
   * After the compile settles, fetch its SandPiper intermediate/output files (top.m4.pre,
   * top.m4, top.sv, top_gen.sv) from the server into the compile's cache dir so the emitted
   * M5 output and (System)Verilog can be read locally, and report their paths. Only fetched
   * when the compile completes within this call's wait (`waitSeconds` > 0 and not timed out);
   * otherwise use `makerchip_wait_compile` with the same option once it finishes. The files
   * are always announced (with cache paths and descriptions) in metadata.json regardless.
   */
  fetchIntermediateFiles?: boolean;
}

interface IdeFunctionCallInput {
  /** The IDE method to invoke (e.g., 'compile', 'activatePane', 'setCode', 'getKeyframe', etc.) */
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

      // Methods with dedicated tools, which also gate PDF content (see the Live Doc skill).
      // captureVideo: its tool sizes the render timeout to the request (here, a 30s timeout leaves
      // long renders running, uncancelled) and saves correctly (here, `filename` triggers a browser
      // download / Save dialog). getVizImage: its tool returns the image inline, not as a base64
      // data URL dumped into the context.
      const dedicated: Record<string, string> = {
        captureVideo: 'makerchip_capture_video',
        getVizImage: 'makerchip_get_viz_image',
        extractPdfFigure: 'makerchip_extract_pdf_figure',
      };
      if (Object.hasOwn(dedicated, method)) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
          `'${method}' is not supported via makerchip_ide_call. Use ${dedicated[method]}.`
        )]);
      }

      // Invoke the IDE method and capture its return value. Using the result-returning command
      // (rather than fire-and-forget invokeIdeMethod) lets methods like getKeyframe/getCode surface
      // their data to the model. The webview always replies when a requestId is present, so void
      // methods resolve to `undefined` without timing out.
      //
      // The 30s cap only stops us WAITING for the reply; it does NOT cancel the in-progress IDE
      // operation.
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        method,
        args,
        panelName,
        false,
        30000
      );

      const panelInfo = panelName ? ` on panel '${panelName}'` : '';

      // A Blob result arrives as a base64 envelope; persist it to a file instead of dumping
      // base64 into the model context (though there's no case that hits this).
      if (result && typeof result === 'object' && (result as any).__makerchipBlob && typeof (result as any).base64 === 'string') {
        const blob = result as { base64: string; mimeType?: string };
        const buffer = Buffer.from(blob.base64, 'base64');
        const ext = (blob.mimeType && blob.mimeType.split('/')[1]) || 'bin';
        const savedPath = path.join(os.tmpdir(), `makerchip-${method}-${Date.now()}.${ext}`);
        fs.writeFileSync(savedPath, buffer);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Invoked IDE method '${method}'${panelInfo}. Returned binary data ` +
            `(${Math.round(buffer.length / 1024)}KB, ${blob.mimeType ?? 'application/octet-stream'}), saved to: ${savedPath}`
          )
        ]);
      }

      // Plain (JSON-serializable) result or void.
      let resultText: string;
      if (result === undefined) {
        resultText = '(no return value)';
      } else {
        try {
          resultText = JSON.stringify(result);
        } catch {
          resultText = String(result);
        }
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Invoked IDE method '${method}'${panelInfo} with arguments ${JSON.stringify(args)}.\nResult: ${resultText}`
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
 * Language Model tool to retrieve a reply that arrived after its IDE call timed out.
 * Only meant to be used when a timeout error explicitly points here.
 */
export class GetLateReplyTool implements vscode.LanguageModelTool<{}> {

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<{}>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const late = await vscode.commands.executeCommand('makerchip.getLateReply');
    const text = late
      ? `Late reply: ${JSON.stringify(late)}`
      : 'No late reply has been captured.';
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}

/**
 * Combined character budget for the log head surfaced on failure. Sized at
 * roughly 3x a typical clean compile log (~3.5 KB) so the combined SandPiper +
 * Verilator head almost always reaches the first real error (the root cause)
 * even when the SandPiper log is HTML-wrapped. The head (not tail) is preferred
 * because later errors usually ripple from the first.
 */
const LOG_HEAD_CHARS = 10000;

/**
 * Report a compilation's status from its cached metadata. The metadata JSON is
 * emitted verbatim (every field, zero interpretation to maintain), and on failure
 * the head of the combined compiler/simulator log is appended as text. Lets tools
 * return compile status directly instead of agents reading `metadata.json` and
 * logs via the shell.
 *
 * `waitedForDiagram` reflects what the caller waited on so the "still running"
 * messaging aligns: by default completion means the core results (compile +
 * simulation) are settled and the diagram (SVG) may still be rendering; when the
 * caller opted to wait for the diagram, completion means everything is settled.
 */
async function formatCompileStatus(compileId: string, timedOut: boolean, waitedForDiagram = false): Promise<string> {
  const metadata = await compileCache.loadMetadata(compileId);
  const cacheDir = compileCache.getCompileDir(compileId);
  if (!metadata) {
    return `**Compile ID:** ${compileId}\nNo metadata found yet at ${cacheDir}.`;
  }

  // Core results (compile + simulation) settled, excluding the diagram; falls
  // back to `complete` for metadata written before `resultsComplete` existed.
  const resultsDone = metadata.resultsComplete ?? metadata.complete;
  const diagramSettled = !!(
    metadata.fileComplete?.['graph.svg'] ||
    metadata.fileError?.['graph.svg'] ||
    metadata.fileSkipped?.['graph.svg']
  );
  const diagramError = metadata.fileError?.['graph.svg'];
  // The primary "done" signal depends on what the caller waited for.
  const primaryDone = waitedForDiagram ? metadata.complete : resultsDone;

  const lines: string[] = [];
  lines.push(`**Compile ID:** ${compileId}`);
  if (timedOut && !primaryDone) {
    lines.push(`_Wait timed out; compilation is still running._`);
  }
  lines.push(`\n**Metadata:**\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\``);

  // On failure, surface the head of the combined compiler/simulator log so it
  // doesn't have to be fetched separately (agents historically skipped the log).
  const sandpiper = metadata.exitStatus?.sandpiper;
  const verilator = metadata.exitStatus?.verilator;
  // A diagram (graph.svg) timeout/error is NOT a compile/sim failure — exclude it.
  const nonDiagramFileError =
    !!metadata.fileError && Object.keys(metadata.fileError).some(f => f !== 'graph.svg');
  const failed =
    metadata.passed === false ||
    (sandpiper !== undefined && sandpiper !== 0) ||
    (verilator !== undefined && verilator !== 0) ||
    !!metadata.error ||
    nonDiagramFileError;
  if (failed) {
    const segments: string[] = [];
    // Skip the SandPiper log only when SandPiper succeeded (exit 0): its
    // INFORM/STATS output is just noise then, and the meaningful failure is
    // downstream in Verilator. When SandPiper failed, its log holds the root
    // cause, so lead with it.
    if (sandpiper === undefined || sandpiper !== 0) {
      const sandpiperLog = await compileCache.readResultFileHead(compileId, 'stdall', LOG_HEAD_CHARS);
      if (sandpiperLog && sandpiperLog.trim()) {
        segments.push(`=== SandPiper (TL-Verilog compiler) ===\n${sandpiperLog.trim()}`);
      }
    }
    // Include the Verilator log when Verilator itself errored or the simulation
    // failed (its build-command noise isn't worth showing otherwise).
    if ((verilator !== undefined && verilator !== 0) || metadata.passed === false) {
      const verilatorLog = await compileCache.readResultFileHead(compileId, 'make.out', LOG_HEAD_CHARS);
      if (verilatorLog && verilatorLog.trim()) {
        segments.push(`=== Verilator (C++ simulator) ===\n${verilatorLog.trim()}`);
      }
    }
    if (segments.length > 0) {
      // Apply a single combined cap across both segments (approximate — the
      // per-segment reads are already bounded, so this only trims the join).
      let combined = segments.join('\n\n');
      if (combined.length > LOG_HEAD_CHARS) {
        combined = `${combined.slice(0, LOG_HEAD_CHARS)}\n…(truncated)`;
      }
      lines.push(`\n**Compile log (from start):**\n\`\`\`\n${combined}\n\`\`\``);
    }
  }

  lines.push(`\n**Cache dir:** ${cacheDir}`);
  if (!primaryDone) {
    lines.push(
      `\nCompilation is still running. Call \`makerchip_wait_compile\` with this compile ID to keep waiting.`
    );
  } else if (!waitedForDiagram && !diagramSettled) {
    // Core results are in; only the diagram is still pending.
    lines.push(
      `\nResults are complete (compile and simulation finished). The diagram (SVG) is still rendering — ` +
      `pass \`waitForDiagram: true\` to \`makerchip_wait_compile\` if you need it.`
    );
  } else if (diagramError) {
    lines.push(
      `\nNote: the diagram (SVG) did not complete (${diagramError.type}). This does not affect the ` +
      `compile/simulation result.`
    );
  }
  return lines.join('\n');
}

/**
 * Fetch a compile's announced SandPiper intermediate/output files into its cache dir (via the
 * `makerchip.fetchIntermediateFiles` command, which resolves the server URL) and return a short
 * markdown summary listing each file's local cache path (or that it was absent). Optional files
 * (e.g. top_gen.sv when generation is inlined) that 404 are reported as not produced.
 */
async function fetchAndSummarizeIntermediateFiles(compileId: string, panelName?: string): Promise<string> {
  type Info = { description: string; url: string; optional?: boolean; cached?: boolean };
  let files: Record<string, Info> | undefined;
  try {
    files = await vscode.commands.executeCommand<Record<string, Info> | undefined>(
      'makerchip.fetchIntermediateFiles',
      compileId,
      panelName
    );
  } catch (error: any) {
    return `\n\n**Intermediate files:** fetch failed: ${error?.message ?? error}`;
  }
  if (!files || Object.keys(files).length === 0) {
    return `\n\n**Intermediate files:** none announced for this compile.`;
  }
  const cacheDir = compileCache.getCompileDir(compileId);
  const lines = ['\n\n**Intermediate files** (fetched into the cache dir):'];
  for (const [name, info] of Object.entries(files)) {
    if (info.cached) {
      lines.push(`- \`${path.join(cacheDir, name)}\` — ${info.description}`);
    } else {
      lines.push(`- ${name} — not produced${info.optional ? ' (optional)' : ''}. ${info.description}`);
    }
  }
  return lines.join('\n');
}

/** Path to the bundled minimal scratch design deployed by `populateResources`. */
const MINIMAL_SCRATCH_PATH = path.join(RESOURCES_DIR, 'minimal.tlv');

/**
 * Read the bundled minimal scratch design (loaded when `makerchip_compile` is
 * called with `code: true`). Throws a clear, actionable error if the reference
 * data has not been populated yet.
 */
async function readMinimalScratchDesign(): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(MINIMAL_SCRATCH_PATH));
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    throw new Error(
      `Minimal scratch design not found at ${MINIMAL_SCRATCH_PATH}. ` +
      `Run "Makerchip: Update Reference Data" to populate it, or pass explicit code/filePath.`
    );
  }
}

/**
 * Language Model tool that allows an AI agent to launch Makerchip IDE
 * and compile TL-Verilog code.
 */
export class MakerchipTool implements vscode.LanguageModelTool<MakerchipToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<MakerchipToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { filePath, code, oneShot } = options.input;
    const suffix = oneShot ? ' (one-shot, no editor)' : '';

    if (code === true) {
      return { invocationMessage: `Opening minimal scratch design in Makerchip IDE${suffix}...` };
    } else if (code) {
      return { invocationMessage: `Opening example code in Makerchip IDE${suffix}...` };
    } else if (filePath) {
      return { invocationMessage: `Opening Makerchip IDE for ${filePath}${suffix}...` };
    } else {
      return { invocationMessage: 'Opening Makerchip IDE with current file...' };
    }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MakerchipToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { filePath, code, panelName, additionalFiles, oneShot, serverUrl } = options.input;

      // Determine if we should create a new panel (only if code/filePath/files provided)
      const createIfNeeded = !!(code || filePath || (additionalFiles && additionalFiles.length > 0));

      let sourceCode: string;
      let fileName: string;
      let staleBufferWarning = '';

      // If code is provided as a string, use it as the source. `code: true` loads the bundled minimal
      // scratch design. Unless one-shot, also open it in a new unsaved document so the user can view/edit it.
      if (code) {
        const wantMinimal = code === true;
        sourceCode = wantMinimal ? await readMinimalScratchDesign() : (code as string);
        fileName = wantMinimal ? 'minimal scratch design' : 'example code';
        if (!oneShot) {
          const doc = await vscode.workspace.openTextDocument({
            content: sourceCode,
            language: 'tlverilog'
          });
          await vscode.window.showTextDocument(doc);
        }
      }
      // If a specific file was requested, read it from disk. Reading directly from
      // disk (rather than the editor buffer) avoids compiling a stale in-memory
      // document when the file has been changed on disk but VS Code hasn't yet
      // reloaded the cached TextDocument.
      else if (filePath) {
        const uri = vscode.Uri.file(filePath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        sourceCode = Buffer.from(bytes).toString('utf-8');
        fileName = path.basename(filePath);

        // One-shot mode compiles the on-disk content without opening/showing an editor.
        // Otherwise keep the editor display consistent with what we compile: if the file
        // is already open with a stale but UNMODIFIED buffer, revert it to sync with disk.
        // Never revert a dirty document (that would discard unsaved edits) — instead warn
        // that the compiled disk content differs from the buffer.
        if (!oneShot) {
          const openDoc = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === uri.toString()
          );
          if (openDoc && openDoc.isDirty && openDoc.getText() !== sourceCode) {
            staleBufferWarning =
              `\n\n⚠️ Compiled the on-disk content of ${fileName}, but the open editor ` +
              `has unsaved changes that were NOT compiled. Save the file to compile your edits.`;
            await vscode.window.showTextDocument(openDoc);
          } else if (openDoc && !openDoc.isDirty && openDoc.getText() !== sourceCode) {
            await vscode.window.showTextDocument(openDoc);
            try {
              await vscode.commands.executeCommand('workbench.action.files.revert');
            } catch {
              // Best-effort display sync; compilation already uses fresh disk content.
            }
          } else {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
          }
        }
      }
      // Otherwise compile the active editor's current content.
      else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('No active file to compile. Please open a TL-Verilog (.tlv) file first.')
          ]);
        }
        sourceCode = editor.document.getText();
        fileName = path.basename(editor.document.fileName);
      }

      // Assemble the compile argument. With additionalFiles, build a multi-file
      // {files, top} payload keyed by basename; the top file is keyed 'top.tlv'
      // for inline code, otherwise by its own basename. Otherwise pass the single
      // source string unchanged.
      let compileArg: string | { files: Record<string, string>; top: string } = sourceCode;
      let multiFileInfo = '';
      if (additionalFiles && additionalFiles.length > 0) {
        const topKey = code ? 'top.tlv' : fileName;
        const files: Record<string, string> = { [topKey]: sourceCode };
        for (const p of additionalFiles) {
          const base = path.basename(p);
          if (base === 'top.tlv') {
            throw new Error(`Additional file name 'top.tlv' is reserved for the top file.`);
          }
          if (base === topKey || files[base] != null) {
            throw new Error(`Duplicate compile file name '${base}'. File basenames must be unique.`);
          }
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
          files[base] = Buffer.from(bytes).toString('utf-8');
        }
        compileArg = { files, top: topKey };
        multiFileInfo = ` (+${additionalFiles.length} additional file(s))`;
      }

      // The plugin's `compile(code, opts, settings)` takes an `opts` object. Build it from the agent's
      // compile options. Any future sanitization or verification (e.g. dropping unknown keys or clamping values)
      // belongs here. `settings` (the user's session
      // settings) is not currently supplied by the agent, so it is left to the plugin's default.
      const opts: { sim?: boolean; dot?: boolean } = {};
      if (options.input.sim !== undefined) opts.sim = options.input.sim;
      if (options.input.dot !== undefined) opts.dot = options.input.dot;

      const compileId = await vscode.commands.executeCommand<string>(
        'makerchip.callIdeMethodWithResult',
        'compile',
        [compileArg, opts],
        panelName,
        createIfNeeded,
        undefined, // timeoutMs — use the command's default
        serverUrl
      );

      if (!compileId) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Failed to start compilation - no compile ID returned')
        ]);
      }

      // Build non-blocking response message with compile ID and log path
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const cacheDir = path.join(CACHE_DIR, compileId);
      const metadataPath = path.join(cacheDir, 'metadata.json');
      const stdallPath = path.join(cacheDir, 'stdall');

      const waitSeconds = options.input.waitSeconds ?? 30;
      const waitForDiagram = options.input.waitForDiagram ?? false;

      let resultMessage: string;
      if (waitSeconds > 0) {
        // Wait in-process for the compile to settle (no shell polling) and return
        // a status summary directly. By default this returns once the core results
        // are in, without blocking on the diagram (SVG) render.
        const { timedOut } = await compileCache.waitForComplete(
          compileId,
          waitSeconds * 1000,
          400,
          token,
          waitForDiagram
        );
        resultMessage = `Compilation of ${fileName}${multiFileInfo}${panelInfo}\n\n`;
        resultMessage += await formatCompileStatus(compileId, timedOut, waitForDiagram);
        // Intermediate files only exist once the compile has settled; skip the fetch (with a
        // pointer to makerchip_wait_compile) if it's still running. panelName is the compile
        // target, so the fetch resolves the same server.
        if (options.input.fetchIntermediateFiles) {
          if (timedOut) {
            resultMessage += `\n\n**Intermediate files:** not yet available (compile still running). ` +
              `Call \`makerchip_wait_compile\` with \`fetchIntermediateFiles: true\` once it completes.`;
          } else {
            resultMessage += await fetchAndSummarizeIntermediateFiles(compileId, panelName);
          }
        }
      } else {
        // Immediate return (waitSeconds: 0): report the compile ID and cache paths.
        resultMessage = `Compilation started for ${fileName}${multiFileInfo}${panelInfo}\n\n`;
        resultMessage += `**Compile ID:** ${compileId}\n`;
        resultMessage += `**Cache Directory:** ${cacheDir}\n`;
        resultMessage += `\nCompilation is running asynchronously. To check status:\n`;
        resultMessage += `1. Call \`makerchip_wait_compile\` with this compile ID (preferred), or\n`;
        resultMessage += `2. Open metadata: ${metadataPath}\n`;
        resultMessage += `3. Check for errors in stdall: ${stdallPath}\n`;
        resultMessage += `\nLook for \`"complete": true\` and \`"passed": true/false\` in metadata.`;
        if (options.input.fetchIntermediateFiles) {
          resultMessage += `\n\n**Intermediate files:** not fetched (no in-process wait). Call ` +
            `\`makerchip_wait_compile\` with \`fetchIntermediateFiles: true\` once the compile completes.`;
        }
      }
      resultMessage += `\n\nThe Makerchip IDE panel shows live compilation results and visualizations.`;
      resultMessage += staleBufferWarning;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(resultMessage)
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

interface WaitCompileInput {
  /** The compile ID returned by makerchip_compile. */
  compileId: string;
  /**
   * Seconds to wait for the compilation to complete before returning (default 30).
   * If it is still running when the timeout elapses, call this tool again with the
   * same compile ID to keep waiting.
   */
  waitSeconds?: number;
  /**
   * When false (default), returns once the core results (compile + simulation) are
   * settled, WITHOUT waiting for the diagram (SVG). Set true to also wait for the
   * diagram (e.g. before capturing it).
   */
  waitForDiagram?: boolean;
  /**
   * When the compile/simulation has completed, fetch its SandPiper intermediate/output files (top.m4.pre,
   * top.m4, top.sv, top_gen.sv) from the server into the compile's cache dir so the emitted M5
   * output and (System)Verilog can be read locally. Works independent of `waitForDiagram`. This is the
   * way to obtain the intermediate files for debugging. Skipped if the wait times out (compile/simulation
   * still running) — call again once it finishes. The files are always announced
   * (with cache paths and descriptions) in metadata.json regardless.
   */
  fetchIntermediateFiles?: boolean;
}

/**
 * Language Model tool to wait for (resume waiting on) a compilation and return its
 * status. Pairs with `makerchip_compile` so agents can await completion without
 * polling `metadata.json` through the shell.
 */
export class WaitCompileTool implements vscode.LanguageModelTool<WaitCompileInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WaitCompileInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { compileId } = options.input;
    return {
      invocationMessage: `Waiting for compilation ${compileId} to complete...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WaitCompileInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { compileId, waitSeconds = 30, waitForDiagram = false } = options.input;
      if (!compileId) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No compileId provided. Pass the compile ID returned by makerchip_compile.')
        ]);
      }
      const { timedOut } = await compileCache.waitForComplete(
        compileId,
        Math.max(0, waitSeconds) * 1000,
        400,
        token,
        waitForDiagram
      );
      let message = await formatCompileStatus(compileId, timedOut, waitForDiagram);
      if (options.input.fetchIntermediateFiles) {
        // Intermediate files exist on the server only once the compile has settled. If the wait
        // timed out, skip the fetch and prompt to retry rather than reporting them all absent.
        if (timedOut) {
          message += `\n\n**Intermediate files:** not yet available (compile still running). ` +
            `Call this tool again with \`fetchIntermediateFiles: true\` once it completes.`;
        } else {
          message += await fetchAndSummarizeIntermediateFiles(compileId);
        }
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message)
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to wait for compilation: ${error.message}`)
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
  /** When true, do not return the image to the model (skip the inline image part) — capture it to a file only, for the user. Spends no vision tokens; a file is always written even if `saveToFile` is unset. */
  blind?: boolean;
  /** What to return: 'image' (image only), 'keyframe' (the current view's absolute keyframe only — no render), or 'both' (default). */
  response?: 'image' | 'keyframe' | 'both';
  /** See vizCaptureRefusal(). */
  clearance?: Clearance;
}

/**
 * Why the agent may not capture the VIZ, given the PDFs whose content it shows (see the Live Doc
 * skill), or undefined if it may. `toFile`: the capture would be saved to a non-temp path.
 */
async function vizCaptureRefusal(panelName: string | undefined, clearance: Clearance | undefined, toFile: boolean) {
  // A server predating getVizPdfDocuments cannot say; treat it as showing no PDF content. The
  // timeout allows for in-flight extractions, which the IDE waits for.
  const docs: any[] = await (vscode.commands.executeCommand(
    'makerchip.callIdeMethodWithResult', 'getVizPdfDocuments', [], panelName, false, 120000
  ) as Promise<any[]>).catch(() => []) ?? [];
  if (!docs.length) { return undefined; }
  const shows = `The VIZ shows content from:\n${docs.map(describePdf).join('\n')}\n\n`;
  if (docs.some((d) => d.rights?.copyDenied)) {
    return `${shows}A PDF whose permissions deny copying: this VIZ cannot be captured, whatever the clearance. Tell the user.`;
  }
  if (!clearance) { return `${shows}Without \`clearance\`, this tool does not capture it. ${ASK_CLEARANCE}`; }
  if (clearance === 'chat' && toFile) {
    return `${shows}With "chat" clearance, a capture can come back to you, or go to a temp file, but not to a file for the user.`;
  }
  return undefined;
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
      const { format = 'png', quality = 1.0, panelName, saveToFile, blind, response = 'both', clearance } = options.input;
      log('[GetVizImageTool] Invoked with:', { format, quality, panelName, saveToFile, blind, response });

      // The string "true" is a stringified boolean (a recurring LLM slip), not a real path. Reject
      // it rather than writing the capture to a file literally named "true"; use boolean true for
      // an auto-named temp file, or a real path string.
      if (saveToFile === 'true') {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'saveToFile was the string "true"; pass the boolean true for an auto-named temp file, or a real file path string.'
          )
        ]);
      }

      const wantImage = response !== 'keyframe';
      const wantKeyframe = response !== 'image';
      const panelInfo = panelName ? ` from panel '${panelName}'` : '';

      // Fetch the current view's absolute keyframe when requested. This is cheap (no render) and is
      // returned as text alongside any image, saving a separate getKeyframe round-trip.
      let keyframeText = '';
      if (wantKeyframe) {
        const kf = await vscode.commands.executeCommand(
          'makerchip.callIdeMethodWithResult', 'getKeyframe', [], panelName
        );
        keyframeText = kf && typeof kf === 'object'
          ? `Current view as an absolute keyframe (drop into makerchip_capture_video \`keyframes\` with \`mode: 'absolute'\`):\n${JSON.stringify(kf)}`
          : 'Keyframe unavailable (no VIZ view).';
      }
      // Fold the keyframe into an image result's text (when both are requested).
      const withKeyframe = (msg: string) => keyframeText ? `${msg}\n\n${keyframeText}` : msg;

      // Keyframe-only: no image capture/render at all.
      if (!wantImage) {
        log('[GetVizImageTool] Returning keyframe only (no image capture)');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(keyframeText)
        ]);
      }

      const refusal = await vizCaptureRefusal(panelName, clearance, typeof saveToFile === 'string');
      if (refusal) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(withKeyframe(refusal))]);
      }

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

      // Decide whether to hand the image to the model inline. `blind` opts out entirely (the
      // capture is for the user, not the agent), so we never spend vision tokens on it. Inlining
      // also requires the proposed image API; without it we fall back to a file (never base64 text).
      const LanguageModelToolResult2 = (vscode as any).LanguageModelToolResult2;
      const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;
      const canInline = !blind && LanguageModelToolResult2 && LanguageModelDataPart && LanguageModelDataPart.image;

      // Save to a file when explicitly requested, or whenever the model won't receive the image
      // inline (blind, or the inline API is unavailable) so the capture isn't lost.
      let savedPath: string | undefined;
      if (saveToFile || !canInline) {
        savedPath = typeof saveToFile === 'string'
          ? saveToFile
          : path.join(os.tmpdir(), `makerchip-viz-${Date.now()}.${format}`);
        fs.writeFileSync(savedPath, imageBuffer);
        log('[GetVizImageTool] Saved image to file:', savedPath);
      }

      if (canInline) {
        log('[GetVizImageTool] Returning image inline (spending vision tokens)');
        try {
          const message = withKeyframe(
             `Successfully captured VIZ visualization${panelInfo} as ${format.toUpperCase()} image (${Math.round(imageBytes.length / 1024)}KB).`
               + (savedPath ? `\nSaved to: ${savedPath}` : ''));

          return new LanguageModelToolResult2([
            new vscode.LanguageModelTextPart(message),
            LanguageModelDataPart.image(imageBytes, mimeType)
          ]);
        } catch (error) {
          log('[GetVizImageTool] Inline image API threw, falling back to file:', error);
          // Ensure a file exists for the fallback text result below.
          if (!savedPath) {
            savedPath = path.join(os.tmpdir(), `makerchip-viz-${Date.now()}.${format}`);
            fs.writeFileSync(savedPath, imageBuffer);
          }
        }
      }

      // Not inlined (blind, unavailable API, or the inline call threw): return the file path only.
      log('[GetVizImageTool] Returning file path (no inline image):', savedPath);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          withKeyframe(
            `Successfully captured VIZ visualization${panelInfo} as ${format.toUpperCase()} image.\n` +
            `Image saved to: ${savedPath}\n` +
            `Size: ${Math.round(imageBuffer.length / 1024)}KB\n\n` +
            (blind
              ? 'Captured in blind mode — the image was not returned to the model.'
              : 'The image file is available for viewing.'))
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

interface ExtractPdfFigureInput {
  /** URL of the PDF, reachable from the IDE (directly or through its CORS proxy, as for \viz_js code). One of `source` or `filePath`. */
  source?: string;
  /**
   * Absolute path to a local PDF (e.g. a licensed copy). The extension sends its bytes to the IDE,
   * so no URL is needed. A tool input only: `\viz_js` code references a URL or a reader-supplied
   * PDF view. One of `source` or `filePath`.
   */
  filePath?: string;
  /** As `extractFigure`'s `page`: 1-based, default 1. */
  page?: number;
  /**
   * As `extractFigure`'s `select` (Live Doc docs): `{mode}` of "largest" (default), "cluster" with
   * `index`, "clusterAt" with `at:[x,y]`, "region" with `rect:[x0,y0,x1,y1]`, or "all". `at`/`rect`
   * are page coordinates.
   */
  select?: any;
  /** As `extractFigure`'s `gap`: cluster-join distance, px, default 12. */
  gap?: number;
  /** As `extractFigure`'s `ignore`: page primitives (by `{mode: "all"}` index) that join no cluster. */
  ignore?: number[];
  /** As `extractFigure`'s `text`. Default "labels". */
  text?: 'labels' | 'all' | 'none';
  /** As `extractFigure`'s `clip`: true (pad 4), a pad in px, or omitted for none. */
  clip?: boolean | number;
  /** Include each primitive's SVG path `d`. Default false, keeping the records compact. */
  includePaths?: boolean;
  /**
   * The extraction's records: `true` inline, `false` omitted, or `{file: true}` written to a temp
   * file. Default: inline unless `summary`.
   */
  extraction?: boolean | { file: true };
  /**
   * Collapse each set of primitives that reads as one shape (a wire net, a fill drawn in pieces)
   * into one `groups` record, omitting its members from `primitives`. See `analyzePrimitives` in
   * mono's PdfExtractor.js.
   */
  group?: boolean;
  /** A compact preview of the extraction, and of the page; see the input schema. As `extraction`. */
  summary?: boolean | { file: true };
  /**
   * EXPERIMENTAL, AUTHORING ONLY. Find the figure whose caption matches this text (e.g.
   * "Figure 3.7") instead of passing `select`. Resolved here in the extension, not by the VIZ
   * runtime: the result reports the equivalent `select` rect to hardcode. No backward
   * compatibility is promised, and `caption` is NOT a `\viz_js` option.
   */
  caption?: string;
  /** With `caption`, pick among reported candidates (0 = best). Default 0. */
  captionIndex?: number;
  /**
   * Also the figure box as pdf.js draws it, as a PNG: `true` (2 pixels per px), or
   * `{scale, annotate}` (`annotate` to outline each primitive and label, tagged with its id, or
   * each group, with `group`).
   */
  render?: boolean | { scale?: number; annotate?: boolean };
  /**
   * The user's answer to the Live Doc skill's copy question: "copy" (they may copy the PDF's
   * content) or "chat" (their LLM provider neither retains nor trains on this conversation).
   * Omitted: document information only.
   */
  clearance?: Clearance;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/** JSON with each top-level key, and each record of an array of records, on its own line. */
function toLineJson(obj: Record<string, any>): string {
  const val = (v: any) => Array.isArray(v) && v.some((e) => e && typeof e === 'object')
    ? `[\n${v.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]`
    : JSON.stringify(v);
  return `{\n${Object.entries(obj).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${val(v)}`).join(',\n')}\n}\n`;
}

/** The user's answer to the Live Doc skill's copy question; see live-doc-agent.md. */
type Clearance = 'copy' | 'chat';
const ASK_CLEARANCE =
  'Share this with the user and ask, as the Live Doc skill describes, whether they may copy this PDF\'s ' +
  'content ("copy"), or whether their LLM provider neither retains nor trains on this conversation ' +
  '("chat"). Then end your turn, and pass `clearance` only on their answer.';

/**
 * A line describing documentInfo() (mono's PdfExtractor.js), or the `{title?, rights}` the IDE's
 * getVizPdfDocuments gives: what the user needs to answer the copy question.
 */
function describePdf(info: any): string {
  const r = info.rights ?? {};
  return `PDF${info.title ? ` "${info.title}"` : ''}${info.author ? ` by ${info.author}` : ''}` +
    `${info.numPages ? `, ${info.numPages} pages` : ''}` +
    `${info.fingerprints?.[0] ? `, fingerprint ${info.fingerprints[0]}` : ''}. ` +
    `Its permissions ${r.copyDenied ? 'DENY' : 'allow'} copying. ` +
    `Copyright notice: ${r.notice ? JSON.stringify(r.notice) : 'none found'}.` +
    (r.usageTerms ? ` Usage terms: ${JSON.stringify(r.usageTerms)}.` : '') +
    (r.webStatement ? ` Rights statement: ${r.webStatement}.` : '');
}

/**
 * Language Model tool that extracts a figure's vector geometry + text labels from a PDF page.
 *
 * Runs PdfExtractor.extractFigure (mono) inside the IDE, as \viz_js Live Doc code does, with its
 * `inspect` option shaping the result for this tool, so coordinates/labels match exactly what a
 * VIZ overlay will see. Use it to
 * inspect a PDF before writing Live Doc VIZ code (find label positions to anchor overlays, choose
 * a select mode / cluster index, read the figure bbox).
 *
 * Content is gated: without `clearance`, or for a PDF whose permissions deny copying, only
 * document information comes back (enforced by the extractor itself for the latter).
 */
export class ExtractPdfFigureTool implements vscode.LanguageModelTool<ExtractPdfFigureInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ExtractPdfFigureInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Extracting PDF figure geometry from ${options.input.source ?? options.input.filePath ?? 'PDF'}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExtractPdfFigureInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    log('[ExtractPdfFigureTool] ========== TOOL INVOKED ==========');
    try {
      const { source, filePath, page, select, gap, ignore, text, clip, includePaths = false,
              extraction, group, summary, caption, captionIndex, render, clearance, panelName } = options.input;
      // The three outputs, each undefined if not requested.
      type Output = { file?: true; scale?: number; annotate?: boolean };
      const output = (spec: boolean | Output | undefined): Output | undefined =>
        spec === true ? {} : spec || undefined;
      const recordsOut = output(extraction ?? !summary);
      const summaryOut = output(summary);
      const renderOut = output(render);

      if (!source && !filePath) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No PDF provided. Pass `source` (a URL reachable from the Makerchip IDE) or `filePath` (an absolute path to a local PDF).'
          )
        ]);
      }
      if (source && filePath) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Pass either `source` or `filePath`, not both.')
        ]);
      }

      // A local file is read here and shipped as base64: extension->webview messages are
      // JSON-serialized, so a Uint8Array would not survive the hop. The IDE decodes it back to
      // bytes before extraction (see IDE.coffee's extractPdfFigure).
      let pdfSource: any = source;
      if (filePath) {
        if (!path.isAbsolute(filePath)) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`filePath must be an absolute path, got: ${filePath}`)
          ]);
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`File not found: ${filePath}`)
          ]);
        }
        pdfSource = { base64: fs.readFileSync(filePath).toString('base64') };
      }

      // Generous timeout: the command default is 10s, which a large document would blow through
      // -- a local PDF crosses three hops as base64 before pdf.js even parses it. Matches the
      // 120s used for pushing a PDF into a pane.
      const PDF_EXTRACT_TIMEOUT_MS = 120000;
      const callExtract = (o: Record<string, any>) => vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'extractPdfFigure',
        [pdfSource, o],
        panelName,
        true,  // Open the panel if needed; extraction needs no compiled design.
        PDF_EXTRACT_TIMEOUT_MS
      ) as Promise<any>;
      const textResult = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

      if (!clearance) {
        return textResult(
          `${describePdf(await callExtract({ page, inspect: { info: true } }))}\n\n` +
          `Without \`clearance\`, this is all the tool returns. ${ASK_CLEARANCE}`);
      }
      // The extractor returns only document information for a PDF whose permissions deny copying.
      const denied = (info: any) => textResult(
        `${describePdf(info)}\n\nSo this tool returns no content from it, whatever the clearance. Do not work ` +
        'around this (e.g. by reading the PDF another way); tell the user.');

      // `caption` is resolved HERE rather than in the extractor, deliberately. Matching a caption
      // is a heuristic -- a page's "Figure 2.24" is far more often a cross-reference in body prose
      // than a caption -- and a heuristic on the runtime path would silently animate the wrong
      // figure on a reader's machine. Resolving it in the tool keeps it to authoring time and
      // makes the output a plain `region` rect, which IS a stable runtime selector.
      let captionNote = '';
      let resolvedSelect: any = select;
      if (caption !== undefined) {
        if (select !== undefined) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Pass either `caption` or `select`, not both.')
          ]);
        }
        // The page's text by line, `{bbox, text}`, from figure to page coordinates.
        const located = await callExtract({ page, select: { mode: 'all' }, text: 'all', inspect: { summary: true } });
        if (!located?.counts) return denied(located);
        const [ox, oy] = located?.bbox ?? [0, 0];
        const items: any[] = (located?.summary?.lines ?? [])
          .map((l: any) => ({ text: l.text, bbox: [l.bbox[0] + ox, l.bbox[1] + oy] }));
        const at = (l: any) => `[${Math.round(l.bbox[0])}, ${Math.round(l.bbox[1])}]`;
        const norm = (t: string) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
        const q = norm(caption);
        // Rank by how standalone the match is: an exact item beats one that starts with the
        // query, which beats one that merely contains it (that is the body-prose case). Shorter
        // wins within a rank, since a caption is a short run and a sentence is not.
        const ranked = items
          .map((l, i) => {
            const t = norm(l.text);
            const rank = t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) ? 1 : 0;
            return { rank, len: t.length, item: l, i };
          })
          .filter((c) => c.rank > 0)
          .sort((a, b) => b.rank - a.rank || a.len - b.len || a.item.bbox[1] - b.item.bbox[1]);

        if (ranked.length === 0) {
          const hints = items
            .filter((l) => /fig|abb|table|chart/i.test(l.text))
            .slice(0, 8)
            .map((l) => `  "${String(l.text).slice(0, 70)}" at ${at(l)}`);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `No text on this page matches caption ${JSON.stringify(caption)}.` +
              (hints.length
                ? `\n\nCaption-like text found:\n${hints.join('\n')}`
                : '\n\nNo caption-like text at all — this page may have none (lecture slides often do not). Use `select` with a region rect instead.')
            )
          ]);
        }

        const pick = ranked[Math.min(Math.max(captionIndex ?? 0, 0), ranked.length - 1)];
        const RANKS = ['', 'contains', 'starts with', 'exact'];
        resolvedSelect = { mode: 'clusterAt', at: pick.item.bbox.slice(0, 2) };
        captionNote =
          `Caption match (${RANKS[pick.rank]}): "${String(pick.item.text).slice(0, 90)}" ` +
          `at page ${at(pick.item)}.`;
        if (ranked.length > 1) {
          captionNote +=
            `\n${ranked.length} candidates — a running header or a cross-reference can match too. ` +
            `Pass captionIndex to choose another:\n` +
            ranked
              .slice(0, 6)
              .map((c, n) => `  [${n}] ${RANKS[c.rank]}: "${String(c.item.text).slice(0, 70)}" at ${at(c.item)}`)
              .join('\n');
        }
        captionNote +=
          `\nResolved to select: ${JSON.stringify(resolvedSelect)} — the nearest vector cluster to that text.`;
      }

      const opts = {
        page, select: resolvedSelect, gap, ignore, text, clip,
        inspect: {
          records: !!recordsOut, summary: !!summaryOut, group, paths: includePaths,
          render: renderOut && { scale: renderOut.scale, annotate: renderOut.annotate },
        },
      };
      log('[ExtractPdfFigureTool] Calling extractPdfFigure with source/opts:',
        filePath ? `filePath=${filePath}` : source, opts);
      const result = await callExtract(opts);

      if (!result) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'PDF extraction returned no result. For a `source` URL, check that it is reachable.'
          )
        ]);
      }
      if (!result.counts) return denied(result);
      log('[ExtractPdfFigureTool] Content returned under clearance:', clearance);

      const { summary: sum, png, ...ext } = result;
      const notice = ext.rights?.notice;
      const notes = [
        `Clearance: ${clearance}. Copyright notice: ${notice ? JSON.stringify(notice) : 'none found'} ` +
        '(`extractToFabric` draws it below the figure; see `build.notice`).'];
      if (sum) {
        notes.push(
          'Summary: `rows`, `images` and `lines` preview this extraction, in figure coordinates as its records; ' +
          '`clusters` and `largest` survey the page, in page coordinates as `select` and `ignore` take them.');
      }
      if (ext.groups) {
        notes.push(
          `${ext.groups.reduce((n: number, g: any) => n + g.count, 0)} primitives collapsed into ` +
          `${ext.groups.length} \`groups\` ` +
          `(members as inclusive index runs; ids keep their pool numbering, so name a run in \`\\viz_js\` ` +
          `as \`{nth: [{from, to}, ...]}\`).`);
      }

      const meta = ext.meta || {};
      const clusterCount = sum?.clusterCount ?? meta.clusterCount;
      // With a caption, hand back the STABLE selector to hardcode. `caption` is an authoring
      // convenience with no compatibility promise and is not a `\viz_js` option; a region rect is.
      const dev = ext.bbox;
      const stable = caption !== undefined && Array.isArray(dev)
        ? `\n\nFor the \`.tlv\`, hardcode the equivalent stable selector (\`caption\` is authoring-only ` +
          `and must NOT appear in \`\\viz_js\` code):\n` +
          `    extract: {page: ${page ?? 1}, clip: true, select: {mode: "region", ` +
          `rect: [${dev.join(', ')}]}}\n` +
          `Verify it selects the same figure before relying on it.`
        : '';
      const header =
        `Extracted PDF figure (page ${page ?? 1} of ${meta.numPages ?? '?'}): ` +
        `${ext.counts.primitives} primitives, ${ext.counts.labels} labels, ${ext.counts.images} images, ` +
        `${clusterCount != null ? `${clusterCount} clusters, ` : ''}` +
        `figure box ${JSON.stringify(dev)} in page coordinates ` +
        `(the records' figure coordinates are relative to its origin).` +
        (!recordsOut || includePaths ? '' : ' (SVG path `d` strings omitted — set includePaths=true to include them.)') +
        notes.map((n) => ` ${n}`).join('') +
        (captionNote ? `\n\n${captionNote}` : '') +
        stable +
        '\n\n';

      // Each requested output, inline or written to a temp file (for size; what is read from it
      // counts as returned).
      const ToolResult = (vscode as any).LanguageModelToolResult2 ?? vscode.LanguageModelToolResult;
      const parts: any[] = [new vscode.LanguageModelTextPart(header)];
      const put = (name: string, file: true | undefined, ext: string, data: string | Buffer, inline: () => any[]) => {
        if (!file) return parts.push(...inline());
        const p = path.join(os.tmpdir(), `makerchip-pdf-${name.replace(/ /g, '-')}-${Date.now()}.${ext}`);
        fs.writeFileSync(p, data);
        parts.push(new vscode.LanguageModelTextPart(
          `The ${name} (${data.length} ${ext === 'json' ? 'chars' : 'bytes'}) was written to: ${p}\n`));
      };
      // JSON in its own, pure-JSON part: when large, Copilot spills it as `content.json` (with a
      // derived schema) that can be queried directly, rather than JSON buried in markdown.
      const putJson = (name: string, out: Output | undefined, obj: any) => {
        if (!out) return;
        const json = toLineJson(obj);
        put(name, out.file, 'json', json, () => [
          new vscode.LanguageModelTextPart(`The ${name} JSON follows as a separate part.\n`),
          new vscode.LanguageModelTextPart(json),
        ]);
      };
      putJson('summary', summaryOut, sum);
      putJson('extraction', recordsOut, ext);
      if (renderOut) {
        // Inline where the image API exists, else a file.
        const bytes = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
        const DataPart = (vscode as any).LanguageModelDataPart;
        const canInline = (vscode as any).LanguageModelToolResult2 && DataPart?.image;
        put('rendered figure', canInline ? undefined : true, 'png', bytes,
          () => [DataPart.image(new Uint8Array(bytes), 'image/png')]);
      }
      log('[ExtractPdfFigureTool] Returning', parts.length, 'parts');
      return new ToolResult(parts);

    } catch (error: any) {
      log('[ExtractPdfFigureTool] ERROR:', error?.message);
      if (/extractPdfFigure/.test(error?.message ?? '')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `The IDE method is not available (${error.message}). This requires a Makerchip server with current Live Doc support. Open a Makerchip panel connected to such a server and try again.`
          )
        ]);
      }
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to extract PDF figure: ${error?.message || 'Unknown error'}`)
      ]);
    }
  }
}

interface CaptureVideoInput {
  /** Starting cycle (inclusive) */
  startCyc: number;
  /** Ending cycle (inclusive) */
  endCyc: number;
  /**
   * Output format: 'auto' (default) lets the IDE choose (GIF for one frame/cycle, MP4 otherwise);
   * set explicitly to force a codec. Independent of saving, so it selects the codec even when the
   * video is returned without writing a file. Mirrors the IDE `captureVideo` `format` option.
   */
  format?: 'auto' | 'gif' | 'mp4' | 'webm' | 'apng';
  /**
   * Output frame rate in frames per second. When omitted, one frame is rendered per cycle (the
   * settled final state — no intra-cycle animation). Mirrors the IDE `captureVideo` `fps` option;
   * the IDE derives frames-per-cycle = ceil(fps / cyclesPerSecond).
   */
  fps?: number;
  /**
   * Playback speed in simulation cycles per second (default: 1). Higher is faster — e.g. 20 plays
   * each cycle for 50ms. Mirrors the IDE `captureVideo` `cyclesPerSecond` option.
   */
  cyclesPerSecond?: number;
  /** Video bitrate in Mbps for MP4 output; ignored for GIF (default: 2.5, recommended: 10 for high quality) */
  Mbps?: number;
  /** Recording width in pixels. Defaults to the live VIZ pane canvas width. Set this (with height) to record at a fixed resolution/aspect independent of the pane size. */
  width?: number;
  /** Recording height in pixels. Defaults to the live VIZ pane canvas height. Set this (with width) to record at a fixed resolution/aspect independent of the pane size. */
  height?: number;
  /** CSS canvas background color (e.g. 'white' or '#1e1e1e'). Defaults to the VIZ default. */
  backgroundColor?: string;
  /**
   * Override the automatically computed RPC timeout, in seconds (capped at 3600 = 1 hour). Use this
   * only when a capture legitimately runs slower than the estimate allows; supplying it bypasses the
   * automatic refusal for large jobs. WARNING: capture is NOT real-time, and the video encode path
   * runs ffmpeg compiled to WebAssembly, which buffers every rendered frame in memory before/while
   * encoding. A long timeout combined with many frames and/or a high resolution can accumulate
   * gigabytes in the webview's heap and crash it (out-of-memory). Prefer reducing the cycle range,
   * fps, or resolution over raising the timeout.
   */
  timeout?: number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
  /** Optional output file path. If omitted, a timestamped file is written to the OS temp dir. The video is always saved to a file (never inlined into the conversation). */
  filename?: string;
  /** See vizCaptureRefusal(). */
  clearance?: Clearance;
  /**
   * Camera keyframes for pan/zoom motion over the cycle range. Each keyframe is
   * {cycle?, scale?, focus?: {x, y}, width?, height?}. With a single keyframe the camera is
   * static; multiple keyframes animate the camera (Catmull-Rom interpolated). In the relative
   * modes (see `mode`) keyframes may be omitted for no camera motion (records the current view for 'viz-relative' or
   * the whole-design fit for 'fit-relative'); in 'absolute' mode the current view is not used, so
   * keyframes are REQUIRED (at least one entry) and `default` only fills in omitted per-keyframe
   * properties. See VizPane.captureVideo for the full model.
   */
  keyframes?: Array<{ cycle?: number; scale?: number; focus?: { x: number; y: number }; width?: number; height?: number }>;
  /**
   * Keyframe reference frame:
   * - 'viz-relative': (default; scale/focus relative to the current VIZ view)
   * - 'fit-relative' (relative to the whole-design contain-fit at the recording size — the
   *   reliable way to frame a capture without hand-tuning scale; scale 1 / focus 0 = whole design)
   * - 'absolute' (absolute VIZ scale/coordinates, as returned by getKeyframe / get_viz_image).
   */
  mode?: 'viz-relative' | 'fit-relative' | 'absolute';
  /** Default keyframe values (scale/focus/width/height) applied to any keyframe that omits them. */
  default?: { scale?: number; focus?: { x: number; y: number }; width?: number; height?: number };
}

/**
 * Language Model tool to capture VIZ simulation as video (GIF or MP4)
 */
export class CaptureVideoTool implements vscode.LanguageModelTool<CaptureVideoInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CaptureVideoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { startCyc, endCyc, format = 'auto' } = options.input;
    const cycles = endCyc - startCyc + 1;
    const formatInfo = format === 'auto' ? '' : ` ${format.toUpperCase()}`;
    return {
      invocationMessage: `Capturing VIZ simulation (cycles ${startCyc}-${endCyc}, ${cycles} frames) as${formatInfo} video...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CaptureVideoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    log('[CaptureVideoTool] ========== TOOL INVOKED ==========');
    try {
      const {
        startCyc,
        endCyc,
        format = 'auto',
        fps,
        cyclesPerSecond = 1,
        Mbps = 2.5,
        width,
        height,
        backgroundColor,
        timeout,
        panelName,
        filename,
        keyframes,
        mode,
        default: keyframeDefault,
        clearance
      } = options.input;

      // Mirror the IDE's derivation (framesPerCycle = ceil(fps / cyclesPerSecond), else 1) so our
      // local frame-count / format-selection / timeout math matches what the IDE actually renders.
      const framesPerCycle = fps != null ? Math.ceil(fps / cyclesPerSecond) : 1;

      log('[CaptureVideoTool] Invoked with:', {
        startCyc, endCyc, format, fps, cyclesPerSecond, framesPerCycle, Mbps, width, height, backgroundColor, timeout, panelName, filename,
        keyframes: Array.isArray(keyframes) ? `${keyframes.length} keyframe(s)` : keyframes, mode, default: keyframeDefault
      });

      // Validate cycle range
      if (typeof startCyc !== 'number' || typeof endCyc !== 'number' || startCyc > endCyc) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid cycle range. startCyc must be less than or equal to endCyc.')
        ]);
      }
      const refusal = await vizCaptureRefusal(panelName, clearance, !!filename);
      if (refusal) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(refusal)]);
      }

      // Build options for IDE method (exclude panelName and filename).
      const videoOptions: any = {
        cyclesPerSecond,
        Mbps,
        filename: null  // Don't download in IDE, we'll handle it here
      };
      // 'auto' means let the IDE pick (GIF for one frame/cycle, H.264 MP4 otherwise).
      if (format !== 'auto') videoOptions.format = format;
      if (fps != null) videoOptions.fps = fps;
      // Optional fixed recording resolution / aspect, independent of the live VIZ pane size.
      // VizPane.captureVideo renders in its own offscreen (headless) VizRecorder canvas at
      // these dimensions; when omitted it defaults to the live pane canvas size.
      if (typeof width === 'number') videoOptions.width = width;
      if (typeof height === 'number') videoOptions.height = height;
      if (typeof backgroundColor === 'string') videoOptions.backgroundColor = backgroundColor;
      // Camera motion: forward keyframes / mode / default to the IDE method. Without this the
      // camera options are dropped and captureVideo renders a static, auto-fit view.
      if (Array.isArray(keyframes)) videoOptions.keyframes = keyframes;
      if (typeof mode === 'string') videoOptions.mode = mode;
      if (keyframeDefault && typeof keyframeDefault === 'object') videoOptions.default = keyframeDefault;

      log('[CaptureVideoTool] Calling captureVideo with options:', videoOptions);

      // captureVideo can exceed the default 10s IDE-method RPC timeout.
      // Estimate the render/encode: a per-frame budget that scales with the frame's resolution (megapixels), plus a
      // setup/encoding floor. The RPC timeout is that estimate times a generous safety margin plus a
      // fixed floor (so a slower-than-expected render isn't killed prematurely), clamped to a hard
      // ceiling. The caller can override this check with an explicit `timeout`.
      const MAX_TIMEOUT_MS = 60 * 60 * 1000; // 1-hour ceiling on timeout
      const TIMEOUT_MARGIN = 4; // safety factor applied to the estimate
      const TIMEOUT_FLOOR_MS = 2 * 60 * 1000; // added to the margined estimate (also acts as a min timeout)
      const MAX_EST_MS = 30 * 60 * 1000; // refuse jobs whose estimate exceeds this (before margin/floor)
      const totalFrames = (endCyc - startCyc + 1) * Math.max(1, framesPerCycle);
      // Resolution defaults to the live pane size when width/height are omitted; assume ~2 MP in that case.
      const megapixels =
        typeof width === 'number' && typeof height === 'number'
          ? Math.max(0.1, (width * height) / 1e6)
          : 2;
      const perFrameMs = 500 + megapixels * 1500; // base render/encode + resolution-dependent cost
      const estimatedMs = 30000 + totalFrames * perFrameMs;

      let captureTimeoutMs: number;
      if (typeof timeout === 'number' && timeout > 0) {
        // Explicit override: trust the caller - no time estimate check (but do clamp to the timeout cap).
        captureTimeoutMs = Math.min(MAX_TIMEOUT_MS, timeout * 1000);
        log(
          '[CaptureVideoTool] Using explicit RPC timeout (ms):',
          captureTimeoutMs,
          '(estimate ~',
          Math.round(estimatedMs),
          'ms) for',
          totalFrames,
          'frame(s) at ~',
          megapixels.toFixed(2),
          'MP'
        );
      } else {
        // Refuse jobs with large estimated time.
        // Report the estimate, the knobs the caller can turn down, and the `timeout` override.
        if (estimatedMs > MAX_EST_MS) {
          const estMin = (estimatedMs / 60000).toFixed(1);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Refusing to capture: estimated render time is ~${estMin} min (> ${MAX_EST_MS / 60000} min limit) ` +
              `for ${totalFrames} frame(s) at ~${megapixels.toFixed(2)} megapixels each. ` +
              `Reduce the cycle range (${startCyc}-${endCyc}), ` +
              `lower fps (currently ${framesPerCycle} frame(s)/cycle), or reduce the recording resolution (width/height). ` +
              `To override this protection, supply an explicit 'timeout' (capped at ${MAX_TIMEOUT_MS / 60000} minutes). ` +
              `Note that long, high-resolution captures can exhaust the webview's memory.`
            )
          ]);
        }

        captureTimeoutMs = Math.min(MAX_TIMEOUT_MS, estimatedMs * TIMEOUT_MARGIN + TIMEOUT_FLOOR_MS);
        log(
          '[CaptureVideoTool] Using RPC timeout (ms):',
          captureTimeoutMs,
          '(estimate ~',
          Math.round(estimatedMs),
          'ms) for',
          totalFrames,
          'frame(s) at ~',
          megapixels.toFixed(2),
          'MP'
        );
      }

      // Call the IDE method to get the video blob
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'captureVideo',
        [startCyc, endCyc, videoOptions],
        panelName,
        false,
        captureTimeoutMs
      ) as { __makerchipBlob?: true; base64?: string; mimeType?: string } | null;

      log('[CaptureVideoTool] Result received:', result ? `SerializedBlob (${result.base64?.length ?? 0} base64 chars, type: ${result.mimeType})` : 'null');

      if (!result || !result.__makerchipBlob || typeof result.base64 !== 'string') {
        log('[CaptureVideoTool] No result - VIZ canvas not available');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'VIZ canvas is not available or has no simulation data. Make sure you have compiled code with VIZ visualization.'
          )
        ]);
      }

      // The IDE encodes with the requested `format`, else it chooses the codec (GIF for one
      // frame/cycle, H.264 MP4 otherwise). Trust the returned MIME type for the real format, and
      // fall back to `format`/frame-count only when the blob didn't report a type.
      const formatMime: Record<string, string> = {
        gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', apng: 'image/apng'
      };
      const fallbackMime =
        (format !== 'auto' && formatMime[format]) || (framesPerCycle === 1 ? 'image/gif' : 'video/mp4');
      const mimeType = result.mimeType || fallbackMime;
      const mimeSubtype = (mimeType.split('/')[1] || '').replace(/^x-/, '');
      // Prefer an explicit `filename` extension; else derive from the MIME subtype.
      const saveExt = typeof filename === 'string' ? path.extname(filename).slice(1).toLowerCase() : '';
      const ext = saveExt || (mimeSubtype === 'jpeg' ? 'jpg' : (mimeSubtype || (framesPerCycle === 1 ? 'gif' : 'mp4')));
      const actualFormat = ext;

      // Decode the base64 envelope produced by the webview into a buffer.
      const videoBuffer = Buffer.from(result.base64, 'base64');

      // Panel info for logging
      const panelInfo = panelName ? ` from panel '${panelName}'` : '';
      const cycles = endCyc - startCyc + 1;

      // Always persist to a file. Video bytes are never inlined into the conversation: models
      // can't consume a video, and a multi-MB data part would only bloat the context. Use the
      // caller's `filename` when given, else a timestamped file in the OS temp dir.
      const savedPath = typeof filename === 'string' && filename.length > 0
        ? filename
        : path.join(os.tmpdir(), `makerchip-viz-${startCyc}-${endCyc}-${Date.now()}.${ext}`);
      fs.writeFileSync(savedPath, videoBuffer);
      log('[CaptureVideoTool] Saved video to file:', savedPath);

      // For image formats (single-frame GIF/APNG, e.g. a calibration capture) the saved file can be
      // viewed directly to inspect the frame; real videos are only referenced by path.
      const isImageFormat = actualFormat === 'gif' || actualFormat === 'apng' || actualFormat === 'png';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully captured VIZ simulation${panelInfo} as ${actualFormat.toUpperCase()} video.\n` +
          `Cycles: ${startCyc}-${endCyc} (${cycles} total)\n` +
          `Format: ${actualFormat.toUpperCase()} (${framesPerCycle} frame(s)/cycle)\n` +
          `Duration: ${(cycles / cyclesPerSecond).toFixed(2)}s at ${cyclesPerSecond} cycle(s)/s (${Math.round(1000 / cyclesPerSecond)}ms/cycle)\n` +
          `File: ${savedPath}\n` +
          `Size: ${Math.round(videoBuffer.length / 1024)}KB` +
          (isImageFormat ? `\n\nThis is an image format — view ${savedPath} to inspect the frame(s).` : '')
        )
      ]);

    } catch (error: any) {
      log('[CaptureVideoTool] ERROR:', error);
      log('[CaptureVideoTool] Error message:', error?.message);
      log('[CaptureVideoTool] Error stack:', error?.stack);

      // Check for specific error cases
      if (error?.message?.includes('Method captureVideo not found')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'The captureVideo method is not available. This could mean:\n\n' +
            '1. No Makerchip panel is currently open - open one with Ctrl+Shift+P → "Makerchip: Open Panel"\n' +
            '2. The Makerchip IDE hasn\'t fully loaded yet - wait a moment and try again\n' +
            '3. You\'re using a server that doesn\'t have the captureVideo method yet\n\n' +
            'Try opening a Makerchip panel and compiling a design with VIZ first.'
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

      if (error?.message?.includes('No simulation data available')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No simulation data available. Make sure you have:\n' +
            '1. Compiled TL-Verilog code with VIZ\n' +
            '2. The compilation completed successfully\n' +
            '3. The VIZ pane is visible and showing simulation results'
          )
        ]);
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to capture VIZ video: ${error?.message || 'Unknown error'}`
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
  /** Content parameters - must include either contentUrl or filePath */
  contentParams: {
    /**
     * URL to the content. The IDE sandbox CSP governs what is actually reachable:
     * `https:` and `blob:` (and same-origin) work. `file://` does NOT -- browsers block
     * local-file loads from an https document beneath CSP, so no CSP change can enable it.
     * `http://` is blocked/upgraded, and `data:` is permitted for `iframe` panes (frame-src)
     * but NOT for `pdf` panes, whose viewer FETCHES the file (connect-src).
     * To show a local file, use `filePath` -- do not hand-build a file:// or data: URL.
     */
    contentUrl?: string;
    /**
     * Absolute path to a local file to load. Read by the extension, so the (potentially large)
     * contents never pass through the model context window. Takes precedence over contentUrl.
     *
     * This is the supported way to display a local document -- including a licensed PDF that is
     * not publicly reachable. For `iframe` panes the extension builds a `data:` URI (permitted by
     * frame-src, and its opaque origin isolates the content). For `pdf` panes a data: URI does not
     * work (see contentUrl above); those are delivered as raw bytes over the pane channel instead.
     */
    filePath?: string;
  };
  /** Optional settings for the pane */
  options?: {
    /** If true, don't activate the pane immediately (default: false) */
    background?: boolean;
    /** If true, pane data won't be stored for layout recovery (default: false) */
    nonTransferrable?: boolean;
    /**
     * Optional channel contract wiring this pane onto the IDE communication bus. Declares the
     * event types the pane `produces` and `subscribes` to (optionally scoped to specific source
     * agents), and whether the pane may issue bounded IDE RPC (`rpc`). This is what enables
     * connected multi-pane flows — e.g. a Compiler Explorer pane that `produces: ["sourceAsm"]`
     * and a WARP-V pane that `subscribes: [{type: "sourceAsm", sources: [<CE mnemonic>]}]`.
     */
    channel?: {
      produces?: string[];
      subscribes?: Array<{ type: string; sources?: string[] }>;
      rpc?: boolean;
    };
    /**
     * Optional opaque parameters delivered to the pane via its `getContext` RPC. Shape is
     * pane-defined (e.g. Compiler Explorer expects `{ce: {language, compiler, options, filters,
     * source}}`).
     */
    params?: any;
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

interface FitPaneInput {
  /** The mnemonic of the pane to fit (e.g. "Viz", "Diagram", "Waveform"). */
  mnemonic: string;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to fit a pane's content to its viewport ("fit content").
 *
 * Sends a fit request to the pane identified by `mnemonic`; it is up to the pane whether it
 * acts on it (VIZ/Diagram fit their scalable content, Waveform zooms to the full time range,
 * other panes ignore it). See the IDE-side `fitPane`/`Pane#fit`. Reports whether the pane acted
 * (success defaults to `false` when the pane doesn't exist or doesn't handle fitting).
 */
export class FitPaneTool implements vscode.LanguageModelTool<FitPaneInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FitPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { mnemonic, panelName } = options.input;
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    return {
      invocationMessage: `Fitting pane '${mnemonic}' to content${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FitPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, panelName } = options.input;

      if (!mnemonic) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No pane mnemonic provided')
        ]);
      }

      // Ask the IDE to fit the pane. The pane decides whether to act; the IDE returns a
      // boolean success flag (false if the pane doesn't exist or doesn't handle fitting).
      const acted = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'fitPane',
        [mnemonic],
        panelName
      ) as boolean;

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const message = acted
        ? `Fit pane '${mnemonic}' to content${panelInfo}`
        : `Pane '${mnemonic}' did not fit to content${panelInfo} (pane not found or does not support fitting)`;
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message)
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to fit pane: ${error.message}`
        )
      ]);
    }
  }
}

/**
 * Infer a MIME type from a file's extension for use in `data:` URIs.
 * Falls back to application/octet-stream for unknown types.
 */
function mimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: { [ext: string]: string } = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.xml': 'application/xml'
  };
  return map[ext] ?? 'application/octet-stream';
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

      if (!contentParams || (!contentParams.contentUrl && !contentParams.filePath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('contentParams must include either contentUrl or filePath')
        ]);
      }

      // When a local filePath is provided, read it here so the (potentially large) file contents
      // never pass through the model context window.
      //
      // Delivery differs by pane type, because the sandbox CSP treats them differently:
      //   iframe -- a `data:` URI works (permitted by frame-src) and its opaque origin isolates
      //             the content, which is what we want for untrusted local HTML.
      //   pdf    -- a `data:` URI CANNOT work: the bundled viewer FETCHES the file, and
      //             connect-src is `'self' https: blob:`. A blob: URL is no good either (it is
      //             minted in the IDE frame and unreachable across the pane's sandbox boundary).
      //             So the bytes are pushed to the viewer over the pane channel instead, via the
      //             bridge's `openData` -- as base64, since extension->webview messages are
      //             JSON-serialized and a Uint8Array would not survive that hop.
      const resolvedParams: { contentUrl?: string } = {};
      if (contentParams.contentUrl) { resolvedParams.contentUrl = contentParams.contentUrl; }
      let pdfBase64: string | null = null;
      let fileBaseName: string | null = null;
      if (contentParams.filePath) {
        const filePath = contentParams.filePath;
        if (!path.isAbsolute(filePath)) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`filePath must be an absolute path, got: ${filePath}`)
          ]);
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`File not found: ${filePath}`)
          ]);
        }
        const base64 = fs.readFileSync(filePath).toString('base64');
        fileBaseName = path.basename(filePath);
        if (contentType === 'pdf') {
          pdfBase64 = base64;
          // No contentUrl: the viewer opens empty and we feed it below.
          delete resolvedParams.contentUrl;
        } else {
          resolvedParams.contentUrl = `data:${mimeTypeForFile(filePath)};base64,${base64}`;
        }
      }

      // A data-fed pdf pane needs the channel (to receive the bytes) and cannot be recreated from
      // serialized layout state, so it must not claim to be transferrable.
      const resolvedOptions: Record<string, any> = { ...(paneOptions || {}) };
      if (pdfBase64) {
        resolvedOptions.channel = { ...(resolvedOptions.channel || {}), rpc: true };
        resolvedOptions.nonTransferrable = true;
      }

      // Call the IDE method to open the third-party pane
      const actualMnemonic = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'openThirdPartyPane',
        [mnemonic, contentType, resolvedParams, resolvedOptions],
        panelName
      ) as string;

      if (pdfBase64) {
        if (!actualMnemonic) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Failed to open a pdf pane for '${mnemonic}'`)
          ]);
        }
        // Push the document into the now-open viewer. A failure here leaves an empty pane, so say
        // so rather than reporting success.
        try {
          // Generous timeouts on BOTH legs: a large PDF has to cross three hops as base64 and
          // then be parsed by pdf.js. The command's own default is 10s, and callPane's pane-RPC
          // default is 30s -- either would spuriously fail a big document.
          const PDF_LOAD_TIMEOUT_MS = 120000;
          await vscode.commands.executeCommand(
            'makerchip.callIdeMethodWithResult',
            'callPane',
            [actualMnemonic, 'openData', [pdfBase64, fileBaseName], PDF_LOAD_TIMEOUT_MS],
            panelName,
            false,
            PDF_LOAD_TIMEOUT_MS
          );
        } catch (e: any) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Opened pane '${actualMnemonic}' but failed to load ${fileBaseName}: ${e?.message ?? e}`
            )
          ]);
        }
      }

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

interface GetCycleInput {
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to get the active cycle/time step
 */
export class GetCycleTool implements vscode.LanguageModelTool<GetCycleInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetCycleInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { panelName } = options.input;
    const panelInfo = panelName ? ` from panel '${panelName}'` : '';
    return {
      invocationMessage: `Getting active cycle${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetCycleInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { panelName } = options.input;

      // Call the IDE method and get the result
      const cycle = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'getCycle',
        [],
        panelName
      ) as number;

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Active cycle${panelInfo}: ${cycle}`
        )
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to get current cycle: ${error.message}`
        )
      ]);
    }
  }
}

interface SetCycleInput {
  /** Absolute cycle to jump to (0-based, will be clamped to [0, endCycle]). Mutually exclusive with offset. */
  cycle?: number;
  /** Relative offset from current cycle (can be negative). Mutually exclusive with cycle. */
  offset?: number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool to set the active cycle/time step
 */
export class SetCycleTool implements vscode.LanguageModelTool<SetCycleInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SetCycleInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { cycle, offset, panelName } = options.input;
    const panelInfo = panelName ? ` in panel '${panelName}'` : '';
    const action = offset !== undefined
      ? `Advancing active cycle by ${offset}`
      : `Setting active cycle to ${cycle}`;
    return {
      invocationMessage: `${action}${panelInfo}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetCycleInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { cycle, offset, panelName } = options.input;

      // Validate that exactly one of cycle or offset is provided
      if ((cycle === undefined && offset === undefined) ||
          (cycle !== undefined && offset !== undefined)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'Must provide exactly one of "cycle" (absolute) or "offset" (relative), not both or neither.'
          )
        ]);
      }

      let targetCycle: number;

      // If offset provided, get current cycle and add offset
      if (offset !== undefined) {
        const currentCycle = await vscode.commands.executeCommand(
          'makerchip.callIdeMethodWithResult',
          'getCycle',
          [],
          panelName
        ) as number;

        targetCycle = currentCycle + offset;
      } else {
        targetCycle = cycle!;
      }

      // Call the IDE method and wait for completion (setCycle returns Promise<void>)
      await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'setCycle',
        [targetCycle],
        panelName
      );

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const message = offset !== undefined
        ? `Advanced active cycle by ${offset} to ${targetCycle}${panelInfo}`
        : `Set active cycle to ${cycle}${panelInfo}`;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message)
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to set cycle: ${error.message}`
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

interface HighlightToolInput {
  /**
   * The TL-Verilog path identifier to highlight.
   * Examples:
   * - Signal: '/cpu|my_pipe$data'
   * - Scope/hierarchy: '/cpu', '/cpu|my_pipe', '/cpu|my_pipe/reg'
   * - Pipeline stage: '|my_pipe@2'
   */
  id: string;
  /**
   * If true, adds to existing highlights (like Ctrl+click).
   * If false or omitted, replaces all existing highlights.
   */
  accumulate?: boolean;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool for highlighting logical entities in the IDE
 */
export class HighlightTool implements vscode.LanguageModelTool<HighlightToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<HighlightToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { id, accumulate } = options.input;
    const action = accumulate ? 'Adding highlight' : 'Highlighting';
    return {
      invocationMessage: `${action} ${id}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<HighlightToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { id, accumulate = false, panelName } = options.input;

      // Call the IDE highlight method and wait for result
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'highlight',
        [id, accumulate],
        panelName
      );

      // Check if highlight was successful (IDE returns boolean: true on success, false on failure)
      if (result === false) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Failed to highlight ${id}: Entity not found or invalid path. Check the entity path syntax and ensure the design has been compiled.`
          )
        ]);
      }

      const action = accumulate ? 'Added highlight for' : 'Highlighted';
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `${action} ${id}${panelInfo}. The entity is now highlighted in all IDE views (Diagram, Waveform, Nav-TLV).`
        )
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to highlight entity: ${error.message}`
        )
      ]);
    }
  }
}

interface ClearHighlightsToolInput {
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool for clearing all highlights in the IDE
 */
export class ClearHighlightsTool implements vscode.LanguageModelTool<ClearHighlightsToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ClearHighlightsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Clearing all highlights...'
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ClearHighlightsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { panelName } = options.input;

      // Call the IDE clearHighlights method
      await vscode.commands.executeCommand(
        'makerchip.invokeIdeMethod',
        'clearHighlights',
        [],
        panelName
      );

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Cleared all highlights${panelInfo}. All highlighted entities have been removed from IDE views.`
        )
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to clear highlights: ${error.message}`
        )
      ]);
    }
  }
}

interface SetDarkModeToolInput {
  /** Enable or disable dark mode (true for dark, false for light) */
  enabled: boolean;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool for setting dark mode in the Makerchip IDE
 */
export class SetDarkModeTool implements vscode.LanguageModelTool<SetDarkModeToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SetDarkModeToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { enabled } = options.input;
    const mode = enabled ? 'dark' : 'light';
    return {
      invocationMessage: `Setting IDE to ${mode} mode...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetDarkModeToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { enabled, panelName } = options.input;

      // Call the IDE setDarkMode method
      await vscode.commands.executeCommand(
        'makerchip.invokeIdeMethod',
        'setDarkMode',
        [enabled],
        panelName
      );

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const mode = enabled ? 'dark' : 'light';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully set IDE to ${mode} mode${panelInfo}. The editor, diagram, waveform, and all IDE views have been updated.`
        )
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to set dark mode: ${error.message}`
        )
      ]);
    }
  }
}

interface SetLiveModeToolInput {
  /** The mnemonic of the pane to control (e.g., "Diagram", "Nav-TLV") */
  mnemonic: string;
  /** Enable or disable live mode (true for live, false for dead/frozen) */
  enabled: boolean;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool for setting live mode in specific Makerchip IDE panes
 */
export class SetLiveModeTool implements vscode.LanguageModelTool<SetLiveModeToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SetLiveModeToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { mnemonic, enabled } = options.input;
    const mode = enabled ? 'live' : 'dead';
    return {
      invocationMessage: `Setting ${mnemonic} pane to ${mode} mode...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetLiveModeToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, enabled, panelName } = options.input;

      // Call the IDE setLiveMode method with result to check success
      const success = await vscode.commands.executeCommand<boolean>(
        'makerchip.callIdeMethodWithResult',
        'setLiveMode',
        [mnemonic, enabled],
        panelName
      );

      if (!success) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Failed to set live mode for pane '${mnemonic}'. The pane may not exist, is not open, or does not support live mode. Only Diagram and Nav-TLV support live mode (VIZ is always live).`
          )
        ]);
      }

      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const mode = enabled ? 'live' : 'dead (frozen)';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully set '${mnemonic}' pane to ${mode} mode${panelInfo}. ${enabled ? 'The pane will now update automatically as the cycle changes.' : 'The pane is frozen at the current cycle.'}`
        )
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to set live mode: ${error.message}`
        )
      ]);
    }
  }
}

interface ListPanelsToolInput {
  // No parameters needed - lists all open panels
}

/**
 * Language Model tool for listing all open Makerchip panels
 */
export class ListPanelsTool implements vscode.LanguageModelTool<ListPanelsToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ListPanelsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Listing open Makerchip panels...'
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListPanelsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      // Get list of panels from the extension
      const panels = await vscode.commands.executeCommand<string[]>(
        'makerchip.getPanelNames'
      );

      if (!panels || panels.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No Makerchip panels are currently open. Use makerchip_compile with code or filePath to open a new panel.'
          )
        ]);
      }

      let result = `**Open Makerchip Panels (${panels.length}):**\n\n`;
      for (const panel of panels) {
        result += `- ${panel}\n`;
      }
      result += `\nUse the \`panelName\` parameter in other tools to target a specific panel.`;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(result)
      ]);

    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to list panels: ${error.message}`
        )
      ]);
    }
  }
}

interface ReloadPanelsToolInput {
  // No parameters needed - reloads all open panels against the current server URL
}

/**
 * Language Model tool that reloads all open Makerchip panels, reconnecting them
 * to the current Makerchip server/tunnel URL. Use it to recover already-open
 * panels after a restart:
 *   - the sandserv backend was restarted (connections dropped), or
 *   - `./launch :port` created a new tunnel after the old one died (new URL).
 * Lighter than a full "Developer: Reload Window"; affects only Makerchip panels.
 */
export class ReloadPanelsTool implements vscode.LanguageModelTool<ReloadPanelsToolInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReloadPanelsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Reloading Makerchip panels...'
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReloadPanelsToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const result = await vscode.commands.executeCommand<{ serverUrl: string; panels: string[] }>(
        'makerchip.reloadPanels'
      );
      const serverUrl = result?.serverUrl ?? '(unknown)';
      const reloaded = result?.panels ?? [];

      const message = reloaded.length === 0
        ? `No open Makerchip panels to reload. New panels will use the current server URL: ${serverUrl}`
        : `Reloaded ${reloaded.length} panel(s) (${reloaded.join(', ')}), reconnecting to ${serverUrl}.`;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message)
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Failed to reload panels: ${error.message}`
        )
      ]);
    }
  }
}

interface BusEmitInput {
  /**
   * The application-event type to publish (e.g. 'sourceAsm'). Panes subscribe by this type;
   * the event rides the shared `ext/<type>` application-bus channel. Because this tool is driven
   * by an AI agent, the platform stamps the source `platform.ai` (a recipient can accept
   * `platform.ai` exactly, or accept the whole platform family via a startsWith check).
   */
  type: string;
  /** The event payload delivered to subscribers. Any JSON-serializable value. */
  payload?: any;
  /**
   * Optional recipient filter: a pane mnemonic (or 'ide'), or an array of them. When omitted the
   * event is broadcast to every matching subscriber.
   */
  target?: string | string[];
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Publish an application event onto the IDE bus as the `platform.ai` participant (an AI-relayed
 * emit). Panes that subscribe to the event `type` receive it (subject to their optional source
 * filter, which may name `platform.ai`).
 */
export class BusEmitTool implements vscode.LanguageModelTool<BusEmitInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BusEmitInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Emitting bus event '${options.input.type}'...` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BusEmitInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { type, payload, target, panelName } = options.input;
      // This tool is invoked by an AI agent, so the platform tags the emit with agent "ai"
      // (source "platform.ai"). The AI cannot choose the agent tag (so it can't pose as the
      // bare platform).
      await vscode.commands.executeCommand('makerchip.busEmit', type, payload, target, 'ai', panelName);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Emitted '${type}' onto the bus.`)
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to emit bus event: ${error.message}`)
      ]);
    }
  }
}

interface PaneCallInput {
  /** The target pane's mnemonic (as returned by opening/reserving a third-party pane). */
  mnemonic: string;
  /** The pane method to invoke. The pane must have declared `rpc: true` and implement this method. */
  method: string;
  /** Positional arguments passed to the pane method. Any JSON-serializable values. */
  args?: any[];
  /** Optional response timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Call a method on a connected third-party pane and await its result (host->pane RPC). This is the
 * request/response complement to makerchip_emit's fire-and-forget broadcast: use it when you need a
 * value back from a pane you opened (e.g. tell the Compiler Explorer pane to run and wait for the
 * outcome). The pane must have declared `rpc: true` and implemented a handler for the method.
 */
export class PaneCallTool implements vscode.LanguageModelTool<PaneCallInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<PaneCallInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { mnemonic, method } = options.input;
    return { invocationMessage: `Calling '${method}' on pane '${mnemonic}'...` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<PaneCallInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, method, args = [], timeoutMs = 30000, panelName } = options.input;
      if (!mnemonic || !method) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Both a pane mnemonic and a method name are required.')
        ]);
      }
      // The IDE forwards this over the named pane's channel (callPane). Give the outer IDE call a
      // slightly longer deadline than the inner pane-RPC timeout so the pane-RPC timeout fires
      // first with a clearer, pane-specific error.
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'callPane',
        [mnemonic, method, args, timeoutMs],
        panelName,
        false,
        timeoutMs + 5000
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Pane '${mnemonic}' method '${method}' returned:\n${JSON.stringify(result, null, 2)}`
        )
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to call pane method: ${error.message}`)
      ]);
    }
  }
}

// Default mnemonic of the WARP-V configurator pane (opened via makerchip_open_third_party_pane).
const WARPV_PANE_DEFAULT = 'WARP-V';

// Shared host->pane RPC call to the WARP-V configurator pane. Returns the pane method's result.
async function callWarpvPane(
  method: string,
  args: any[],
  mnemonic: string | undefined,
  panelName: string | undefined,
  timeoutMs: number = 30000
): Promise<any> {
  const pane = mnemonic || WARPV_PANE_DEFAULT;
  return vscode.commands.executeCommand(
    'makerchip.callIdeMethodWithResult',
    'callPane',
    [pane, method, args, timeoutMs],
    panelName,
    false,
    timeoutMs + 5000
  );
}

interface WarpvPaneInput {
  /** Target WARP-V pane mnemonic. Default: `WARP-V`. */
  mnemonic?: string;
  /** Optional panel name to target. Default: `default`. */
  panelName?: string;
}

/**
 * Read the WARP-V configurator's current configuration. The returned shape ({ general, pipeline,
 * programText }) doubles as the schema for set_warpv_config.
 */
export class GetWarpvConfigTool implements vscode.LanguageModelTool<WarpvPaneInput> {
  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<WarpvPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Reading WARP-V configuration...' };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WarpvPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, panelName } = options.input;
      const result = await callWarpvPane('getConfig', [], mnemonic, panelName);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`WARP-V configuration:\n${JSON.stringify(result, null, 2)}`)
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to read WARP-V configuration: ${error.message}`)
      ]);
    }
  }
}

interface SetWarpvConfigInput extends WarpvPaneInput {
  /** Top-of-form settings to merge (warpVVersion, isa, depth, custom-program flags, ...). */
  general?: Record<string, any>;
  /** Pipeline parameters to merge, keyed by ConfigurationParameter jsonKey. */
  pipeline?: Record<string, any>;
  /** The (assembly) program source to set. */
  programText?: string;
}

/**
 * Apply a partial configuration to the WARP-V configurator. Objects shallow-merge; arrays/scalars
 * replace. Returns { applied, rejected }.
 */
export class SetWarpvConfigTool implements vscode.LanguageModelTool<SetWarpvConfigInput> {
  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<SetWarpvConfigInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Updating WARP-V configuration...' };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetWarpvConfigInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, panelName, general, pipeline, programText } = options.input;
      const patch: Record<string, any> = {};
      if (general !== undefined) patch.general = general;
      if (pipeline !== undefined) patch.pipeline = pipeline;
      if (programText !== undefined) patch.programText = programText;
      const result = await callWarpvPane('setConfig', [patch], mnemonic, panelName);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`WARP-V setConfig result:\n${JSON.stringify(result, null, 2)}`)
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to update WARP-V configuration: ${error.message}`)
      ]);
    }
  }
}

/**
 * Return the TL-Verilog the WARP-V configurator generates for its current configuration.
 */
export class GetWarpvTlvTool implements vscode.LanguageModelTool<WarpvPaneInput> {
  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<WarpvPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Generating WARP-V TL-Verilog...' };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WarpvPaneInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { mnemonic, panelName } = options.input;
      const result = await callWarpvPane('getTlv', [], mnemonic, panelName);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      ]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to generate WARP-V TL-Verilog: ${error.message}`)
      ]);
    }
  }
}

/**
 * Register the Makerchip tools with the Language Model API
 */
/** One tool call: the unit both the single and batched forms of makerchip_invoke_tool execute. */
interface InvokeToolCall {
  /** Name of the target tool to invoke (or to describe). Omit with `describe` to list all Makerchip tools. */
  name?: string;
  /** Arguments object forwarded to the target tool (must match its inputSchema). */
  input?: any;
  /**
   * When true, do not invoke: return the target tool's contract
   * ({name, description, inputSchema, tags}), or — with no `name` — a catalog of every
   * Makerchip tool. Use this to discover a gated tool's schema before calling it.
   */
  describe?: boolean;
  /**
   * Batched form only. Whether a failure of THIS entry aborts the entries after it. Defaults to
   * true, because Makerchip batches are usually dependent sequences (compile -> wait -> inspect).
   * Set `fatal: false` for an entry whose failure the rest does not depend on.
   */
  fatal?: boolean;
}

interface InvokeToolInput extends InvokeToolCall {
  /**
   * Batched form: run these calls in order, in a single invocation. Mutually exclusive with the
   * top-level `name`/`input`/`describe`. See BATCHING on InvokeToolTool for why this exists.
   */
  calls?: InvokeToolCall[];
}

/** Upper bound on a batch, so a runaway list cannot produce an unbounded single result. */
const MAX_BATCH_CALLS = 100;

/**
 * Universal fallback tool: invoke (or describe) any registered Language Model tool by name —
 * including Makerchip tools that are not currently offered to the model because their activation
 * set is gated off. `vscode.lm.invokeTool` is not gated by picker/`when` state, so this keeps every
 * capability reachable even when tool-cap pressure hides it. It can also `describe` a tool (return
 * its inputSchema) so the model can construct a valid call before invoking.
 *
 * BATCHING (`calls`)
 * Microsoft's Claude harness bridge dispatches one tool call per execution round: if the agent
 * issues two or more Makerchip calls in a single round, the first returns and the rest never reach
 * the extension, so the call HANGS rather than failing. The agent's own general guidance pushes it
 * toward batching independent calls, so the rule it must follow here is against its default and
 * the penalty for slipping is a hang.
 *
 * `calls: [{name, input}, ...]` gives it a sanctioned way to batch: the harness sees exactly ONE
 * tool call, and the list is executed serially inside the extension. The concurrency limit is in
 * the bridge, not in us, so a single call carrying N invocations never trips it.
 *
 * This also defeats the gating lag for free. `makerchip_enable_tools` normally only takes effect
 * on the agent's next turn because the harness fixes the offered tool list per round — but a batch
 * runs entirely in-process with no harness round trip between entries, and no enablement requirement
 * so `[enable_tools(video), capture_video(...)]` works in one call.
 *
 * Results are concatenated with a delimiting header per call, preserving non-text parts verbatim
 * (so image parts from e.g. makerchip_get_viz_image survive batching) and merging each run of
 * adjacent text into ONE part. The merge matters: Copilot spills a large text part to
 * `<session>/<toolCallId>/content.txt`, keyed only by the (outer) call id, so several large text
 * parts in one result overwrite each other's spill file. Per-call output is NOT truncated; keep
 * batches small, and note MAX_BATCH_CALLS.
 *
 * Keep this deliberately dumb — a serial list, no data flow, no control flow. It cannot chain
 * (feed one call's result into the next), and it should not learn how: parallelism, nesting or
 * result interpolation would each be a step toward reimplementing a programming language inside a
 * tool input. Agent-authored code that needs real control flow belongs in an ephemeral headless
 * component instead. See issues/010-headless-components.md.
 */
export class InvokeToolTool implements vscode.LanguageModelTool<InvokeToolInput> {

  private makerchipTools(): readonly vscode.LanguageModelToolInformation[] {
    return vscode.lm.tools.filter(t => t.name.startsWith('makerchip_'));
  }

  private catalogText(): string {
    const lines = this.makerchipTools().map(t => `- ${t.name}: ${t.description}`).join('\n');
    return `Available Makerchip tools:\n${lines}`;
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<InvokeToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { name, describe, calls } = options.input;
    if (calls && calls.length > 0) {
      const names = calls.map(c => c.name ?? 'catalog').join(', ');
      return { invocationMessage: `Invoking ${calls.length} Makerchip tools (${names})...` };
    }
    const target = name ?? 'Makerchip tools';
    return {
      invocationMessage: describe ? `Describing '${target}'...` : `Invoking tool '${target}'...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<InvokeToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { calls } = options.input;
    if (calls !== undefined) {
      return this.invokeBatch(calls, options, token);
    }
    // Single call: return the target's result verbatim, unchanged from before batching existed.
    return (await this.runCall(options.input, options, token)).result;
  }

  /**
   * Run `calls` in order, concatenating their results with a per-call header.
   *
   * A failing entry aborts the rest unless it is marked `fatal: false`. That default is
   * deliberate: these batches are typically dependent sequences, so carrying on after a failure
   * yields cascading secondary failures rather than useful work. There is no batch-wide override —
   * "tolerate everything" is expressible by marking the entries, which keeps one local knob
   * instead of two that can contradict each other.
   *
   * Stops between calls if cancellation is requested.
   */
  private async invokeBatch(
    calls: InvokeToolCall[],
    options: vscode.LanguageModelToolInvocationOptions<InvokeToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const text = (s: string) =>
      new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

    if (calls.length === 0) {
      return text('`calls` was empty. Provide at least one {name, input}, or use `name` directly.');
    }
    if (calls.length > MAX_BATCH_CALLS) {
      return text(
        `Too many calls in one batch (${calls.length} > ${MAX_BATCH_CALLS}). Split it; ` +
        'results are concatenated into a single reply and would otherwise grow unbounded.'
      );
    }

    const parts: vscode.LanguageModelToolResult['content'] = [];
    let ok = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const label = `${i + 1}/${calls.length}: ${call.name ?? 'catalog'}`;

      if (token.isCancellationRequested) {
        skipped = calls.length - i;
        parts.push(new vscode.LanguageModelTextPart(`\n=== cancelled before call ${label} ===\n`));
        break;
      }

      const { result, error } = await this.runCall(call, options, token);
      if (error) {
        failed++;
      } else {
        ok++;
      }

      const fatal = error !== undefined && call.fatal !== false;
      parts.push(new vscode.LanguageModelTextPart(
        `\n=== call ${label} — ${error ? (fatal ? 'FAILED' : 'failed (non-fatal)') : 'ok'} ===\n`
      ));
      // Splice the target's own parts in, rather than stringifying, so non-text parts survive.
      parts.push(...result.content);

      if (fatal) {
        skipped = calls.length - i - 1;
        if (skipped > 0) {
          parts.push(new vscode.LanguageModelTextPart(
            `\n=== stopped: call ${label} failed and was fatal; ${skipped} remaining call(s) not run. ` +
            'Mark an entry `fatal: false` if the rest does not depend on it. ===\n'
          ));
        }
        break;
      }
    }

    const summary =
      `Batch of ${calls.length} call(s): ${ok} ok, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} not run` : '') + '.\n';
    // Merge adjacent text parts (see BATCHING for why).
    const merged: vscode.LanguageModelToolResult['content'] = [];
    for (const part of [new vscode.LanguageModelTextPart(summary), ...parts]) {
      const last = merged[merged.length - 1];
      if (part instanceof vscode.LanguageModelTextPart && last instanceof vscode.LanguageModelTextPart) {
        merged[merged.length - 1] = new vscode.LanguageModelTextPart(last.value + part.value);
      } else {
        merged.push(part);
      }
    }
    return new vscode.LanguageModelToolResult(merged);
  }

  /**
   * Execute one call. Returns the result plus an `error` string when the call could not be
   * completed, so the batch path can count failures — the single path just returns the result,
   * whose text already carries the explanation.
   */
  private async runCall(
    call: InvokeToolCall,
    options: vscode.LanguageModelToolInvocationOptions<InvokeToolInput>,
    token: vscode.CancellationToken
  ): Promise<{ result: vscode.LanguageModelToolResult; error?: string }> {
    const { name, input, describe } = call;
    const text = (s: string) =>
      new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

    // Describe mode (or a bare call with no name): return schema(s) instead of invoking.
    if (describe || !name) {
      if (!name) {
        return { result: text(
          (describe ? '' : 'Provide `name` to invoke a tool, or `describe: true` to fetch a schema.\n\n') +
          this.catalogText()
        ) };
      }
      const info = vscode.lm.tools.find(t => t.name === name);
      if (!info) {
        return {
          result: text(`Unknown tool '${name}'.\n\n${this.catalogText()}`),
          error: `unknown tool '${name}'`,
        };
      }
      return { result: text(JSON.stringify({
        name: info.name,
        description: info.description,
        inputSchema: info.inputSchema ?? null,
        tags: info.tags
      }, null, 2)) };
    }

    // Invoke mode.
    if (name === 'makerchip_invoke_tool') {
      // Also blocks nesting a batch inside a batch, which would defeat MAX_BATCH_CALLS.
      return {
        result: text('makerchip_invoke_tool cannot invoke itself. Pass the name of the tool you want to run.'),
        error: 'self-invocation refused',
      };
    }

    const target = vscode.lm.tools.find(t => t.name === name);
    if (!target) {
      return {
        result: text(`Unknown tool '${name}'.\n\n${this.catalogText()}`),
        error: `unknown tool '${name}'`,
      };
    }

    const args = input ?? {};

    // Minimal validation: surface missing required fields (with the schema) before forwarding, so
    // the model gets an actionable error rather than a cryptic downstream failure.
    const schema = target.inputSchema as any;
    const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
    const missing = required.filter(k => !(args && typeof args === 'object' && k in args));
    if (missing.length > 0) {
      return {
        result: text(
          `Invalid input for '${name}': missing required field(s): ${missing.join(', ')}.\n` +
          `Expected input schema:\n${JSON.stringify(target.inputSchema ?? {}, null, 2)}`
        ),
        error: `missing required field(s): ${missing.join(', ')}`,
      };
    }

    try {
      // invokeTool is not gated by picker/`when` state, so gated tools remain reachable here.
      const result = await vscode.lm.invokeTool(
        name,
        { input: args, toolInvocationToken: options.toolInvocationToken },
        token
      );
      return { result };
    } catch (error: any) {
      return {
        result: text(
          `Failed to invoke '${name}': ${error?.message ?? String(error)}\n` +
          `Expected input schema:\n${JSON.stringify(target.inputSchema ?? {}, null, 2)}`
        ),
        error: error?.message ?? String(error),
      };
    }
  }
}

export function registerMakerchipTool(context: vscode.ExtensionContext): void {
  // Register each tool through a wrapper that (a) bumps the activity clock on every invocation so
  // active use keeps enabled tools alive (see toolActivation.ts), and (b) disposes with the
  // extension. Proxied makerchip_invoke_tool calls dispatch through the same wrapped impl, so they
  // touch too.
  let count = 0;
  const reg = (name: string, tool: vscode.LanguageModelTool<any>): void => {
    const invoke = tool.invoke.bind(tool);
    tool.invoke = (options, token) => { getToolActivation()?.touch(); return invoke(options, token); };
    context.subscriptions.push(vscode.lm.registerTool(name, tool));
    count++;
  };

  reg('makerchip_compile', new MakerchipTool());
  reg('makerchip_wait_compile', new WaitCompileTool());
  reg('makerchip_ide_call', new IdeFunctionCallTool());

  reg('makerchip_get_late_reply', new GetLateReplyTool());
  reg('makerchip_get_viz_image', new GetVizImageTool());
  reg('makerchip_extract_pdf_figure', new ExtractPdfFigureTool());
  reg('makerchip_capture_video', new CaptureVideoTool());

  reg('makerchip_get_layout_state', new GetLayoutStateTool());
  reg('makerchip_set_layout_state', new SetLayoutStateTool());
  reg('makerchip_get_available_panes', new GetAvailablePanesTool());
  reg('makerchip_open_pane', new OpenPaneTool());
  reg('makerchip_fit_pane', new FitPaneTool());
  reg('makerchip_open_third_party_pane', new OpenThirdPartyPaneTool());

  reg('makerchip_get_cycle', new GetCycleTool());
  reg('makerchip_set_cycle', new SetCycleTool());
  reg('makerchip_update_play_state', new UpdatePlayStateTool());
  reg('makerchip_highlight', new HighlightTool());
  reg('makerchip_clear_highlights', new ClearHighlightsTool());
  reg('makerchip_set_dark_mode', new SetDarkModeTool());
  reg('makerchip_set_live_mode', new SetLiveModeTool());

  reg('makerchip_list_panels', new ListPanelsTool());
  reg('makerchip_reload_panels', new ReloadPanelsTool());
  reg('makerchip_emit', new BusEmitTool());
  reg('makerchip_pane_call', new PaneCallTool());
  reg('makerchip_get_warpv_config', new GetWarpvConfigTool());
  reg('makerchip_set_warpv_config', new SetWarpvConfigTool());
  reg('makerchip_get_warpv_tlv', new GetWarpvTlvTool());
  reg('makerchip_ce_compile', new CeCompileTool());
  reg('makerchip_invoke_tool', new InvokeToolTool());
  reg('makerchip_enable_tools', new EnableToolsTool());

  log(`All ${count} Makerchip extension tools registered.`);
}
