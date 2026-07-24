import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log, showOutputChannel } from './logger';
import * as compileCache from './compileCache';
import { MAKERCHIP_DIR } from './populateResources';

interface MakerchipToolInput {
  /**
   * Optional file path to open and compile. Read from disk if provided (not the editor buffer,
   * so be sure to save the editor buffer to disk first). If not provided, uses the active editor buffer.
   */
  filePath?: string;
  /** Optional TL-Verilog code to compile. If provided, creates a new unsaved file with this code. */
  code?: string;
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
   * Seconds to wait (in-process) for the compilation to complete before returning.
   * When > 0 (default 30), the tool blocks up to this long and returns a status
   * summary (exit codes, pass/fail, and a log excerpt on failure) so agents don't
   * need to poll `metadata.json` via the shell. If the compile is still running when
   * the timeout elapses, use `makerchip_wait_compile` with the returned compile ID to
   * keep waiting. Set to 0 to return immediately with just the compile ID.
   */
  waitSeconds?: number;
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
 * Build a compact, LLM-friendly status summary for a compilation from its cached
 * metadata (and, on failure, a tail of the compiler/simulator logs). Lets tools
 * return compile status directly instead of agents reading `metadata.json` and
 * logs via the shell.
 */
async function formatCompileStatus(compileId: string, timedOut: boolean): Promise<string> {
  const metadata = await compileCache.loadMetadata(compileId);
  const cacheDir = compileCache.getCompileDir(compileId);
  if (!metadata) {
    return `**Compile ID:** ${compileId}\nNo metadata found yet at ${cacheDir}.`;
  }

  const sandpiper = metadata.exitStatus?.sandpiper;
  const verilator = metadata.exitStatus?.verilator;
  const fileErrors = metadata.fileError ? Object.entries(metadata.fileError) : [];

  const lines: string[] = [];
  lines.push(`**Compile ID:** ${compileId}`);
  lines.push(
    `**Complete:** ${metadata.complete ? 'yes' : `no (still running${timedOut ? '; wait timed out' : ''})`}`
  );
  if (metadata.passed !== undefined) {
    lines.push(`**Simulation:** ${metadata.passed ? 'PASSED' : 'FAILED'}`);
  }
  if (sandpiper !== undefined) {
    lines.push(`**SandPiper exit:** ${sandpiper}${sandpiper === 0 ? ' (ok)' : ' (error)'}`);
  }
  if (verilator !== undefined) {
    lines.push(`**Verilator exit:** ${verilator}${verilator === 0 ? ' (ok)' : ' (error)'}`);
  }
  if (metadata.error) {
    const reason = metadata.error.reason ?? metadata.error.message;
    lines.push(
      `**Error:** ${metadata.error.type}${metadata.error.timeout ? ' (timeout)' : ''}${reason ? ` – ${reason}` : ''}`
    );
  }
  if (fileErrors.length > 0) {
    lines.push(`**File errors:** ${fileErrors.map(([f, e]) => `${f} (${e.type})`).join(', ')}`);
  }

  // Surface the relevant log tail on any failure so it doesn't have to be fetched
  // separately (agents historically skipped checking the log).
  const failed =
    metadata.passed === false ||
    (sandpiper !== undefined && sandpiper !== 0) ||
    (verilator !== undefined && verilator !== 0) ||
    !!metadata.error ||
    fileErrors.length > 0;
  if (failed) {
    const sandpiperLog = await compileCache.readResultFileHead(compileId, 'stdall');
    if (sandpiperLog && sandpiperLog.trim()) {
      lines.push(`\n**SandPiper log (from start):**\n\`\`\`\n${sandpiperLog.trim()}\n\`\`\``);
    }
    if (verilator !== undefined && verilator !== 0) {
      const verilatorLog = await compileCache.readResultFileHead(compileId, 'make.out');
      if (verilatorLog && verilatorLog.trim()) {
        lines.push(`\n**Verilator log (from start):**\n\`\`\`\n${verilatorLog.trim()}\n\`\`\``);
      }
    }
  }

  lines.push(`\n**Cache dir:** ${cacheDir}`);
  if (!metadata.complete) {
    lines.push(
      `\nCompilation is still running. Call \`makerchip_wait_compile\` with this compile ID to keep waiting.`
    );
  }
  return lines.join('\n');
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
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { filePath, code, panelName, additionalFiles } = options.input;
      
      // Determine if we should create a new panel (only if code/filePath/files provided)
      const createIfNeeded = !!(code || filePath || (additionalFiles && additionalFiles.length > 0));
      
      let sourceCode: string;
      let fileName: string;
      let staleBufferWarning = '';
      
      // If code is provided, create a new unsaved document with it
      if (code) {
        const doc = await vscode.workspace.openTextDocument({
          content: code,
          language: 'tlverilog'
        });
        await vscode.window.showTextDocument(doc);
        sourceCode = code;
        fileName = 'example code';
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
        
        // Keep the editor display consistent with what we compile. If the file is
        // already open with a stale but UNMODIFIED buffer, revert it to sync with
        // disk. Never revert a dirty document (that would discard unsaved edits) —
        // instead warn that the compiled disk content differs from the buffer.
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
      
      const compileId = await vscode.commands.executeCommand<string>(
        'makerchip.callIdeMethodWithResult',
        'compile',
        [compileArg],
        panelName,
        createIfNeeded
      );
      
      if (!compileId) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Failed to start compilation - no compile ID returned')
        ]);
      }
      
      // Build non-blocking response message with compile ID and log path
      const panelInfo = panelName ? ` in panel '${panelName}'` : '';
      const cacheDir = path.join(MAKERCHIP_DIR, 'compile-cache', compileId);
      const metadataPath = path.join(cacheDir, 'metadata.json');
      const stdallPath = path.join(cacheDir, 'stdall');

      const waitSeconds = options.input.waitSeconds ?? 30;

      let resultMessage: string;
      if (waitSeconds > 0) {
        // Wait in-process for the compile to settle (no shell polling) and return
        // a status summary directly.
        const { timedOut } = await compileCache.waitForComplete(
          compileId,
          waitSeconds * 1000,
          400,
          token
        );
        resultMessage = `Compilation of ${fileName}${multiFileInfo}${panelInfo}\n\n`;
        resultMessage += await formatCompileStatus(compileId, timedOut);
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
      const { compileId, waitSeconds = 30 } = options.input;
      if (!compileId) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No compileId provided. Pass the compile ID returned by makerchip_compile.')
        ]);
      }
      const { timedOut } = await compileCache.waitForComplete(
        compileId,
        Math.max(0, waitSeconds) * 1000,
        400,
        token
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(await formatCompileStatus(compileId, timedOut))
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

interface ExtractPdfFigureInput {
  /** PDF source: a URL string (resolved through the IDE's CORS proxy, like \viz_js code). */
  source: string;
  /** 1-based page number (default: 1). */
  page?: number;
  /**
   * Figure-selection descriptor. One of:
   *   {mode:"largest"}                              densest cluster (default)
   *   {mode:"cluster", index}                       nth-densest cluster (0-based)
   *   {mode:"clusterAt", at:[x,y], space}           cluster at/nearest a point
   *   {mode:"region", rect:[x0,y0,x1,y1], space}    explicit crop rectangle
   *   {mode:"all"}                                  whole page
   * `space` (for at/rect) is "pdf" (default), "device", or "norm".
   */
  select?: any;
  /** Cluster-join distance in device px (default: 12). */
  gap?: number;
  /** Output coordinate space: "figure" (default), "device", or "pdf". */
  space?: 'figure' | 'device' | 'pdf';
  /** Which text to return: "labels" (default, inside the figure), "all", or "none". */
  text?: 'labels' | 'all' | 'none';
  /** Clip primitives to the figure bounds: true (pad 4px), a number (explicit pad), or omit for no clip. */
  clip?: boolean | number;
  /** Include the SVG path `d` string on each primitive. Default false (omitted to keep the result compact). */
  includePaths?: boolean;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
}

/**
 * Language Model tool that extracts a figure's vector geometry + text labels from a PDF page.
 *
 * Runs the same PdfExtractor.extractFigure used by \viz_js Live Doc code, inside the IDE, so the
 * returned coordinates/labels/transforms match exactly what a VIZ overlay will see. Use it to
 * inspect a PDF before writing Live Doc VIZ code (find label positions to anchor overlays, choose
 * a select mode / cluster index, read the figure bbox and coordinate transforms).
 */
export class ExtractPdfFigureTool implements vscode.LanguageModelTool<ExtractPdfFigureInput> {

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ExtractPdfFigureInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Extracting PDF figure geometry from ${options.input.source}...`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExtractPdfFigureInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    log('[ExtractPdfFigureTool] ========== TOOL INVOKED ==========');
    try {
      const { source, page, select, gap, space, text, clip, includePaths = false, panelName } = options.input;

      if (!source) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No PDF `source` provided. Pass a URL to a PDF (reachable from the Makerchip IDE).')
        ]);
      }

      // Assemble extractFigure opts, omitting undefined fields (so extractFigure defaults apply).
      const opts: Record<string, any> = {};
      if (page !== undefined) { opts.page = page; }
      if (select !== undefined) { opts.select = select; }
      if (gap !== undefined) { opts.gap = gap; }
      if (space !== undefined) { opts.space = space; }
      if (text !== undefined) { opts.text = text; }
      if (clip !== undefined) { opts.clip = clip; }

      log('[ExtractPdfFigureTool] Calling extractPdfFigure with source/opts:', source, opts);
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult',
        'extractPdfFigure',
        [source, opts],
        panelName
      ) as any;

      if (!result) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'PDF extraction returned no result. Ensure a Makerchip panel is open (extraction runs inside the IDE) and the `source` URL is reachable.'
          )
        ]);
      }

      // Trim large SVG path `d` strings unless explicitly requested, to keep the result compact.
      let payload = result;
      if (!includePaths && Array.isArray(result.primitives)) {
        payload = {
          ...result,
          primitives: result.primitives.map((p: any) => {
            const rest = { ...p };
            delete rest.d;
            return rest;
          })
        };
      }

      const meta = result.meta || {};
      const json = JSON.stringify(payload, null, 2);
      const summary =
        `Extracted PDF figure: ${result.primitives?.length ?? 0} primitives, ` +
        `${result.labels?.length ?? 0} labels, ${meta.clusterCount ?? '?'} clusters, space="${result.space}".` +
        (includePaths ? '' : ' (SVG path `d` strings omitted — set includePaths=true to include them.)') +
        `\n\n\`\`\`json\n${json}\n\`\`\``;

      log('[ExtractPdfFigureTool] Result received:', summary.length, 'chars');
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(summary)
      ]);

    } catch (error: any) {
      log('[ExtractPdfFigureTool] ERROR:', error?.message);
      if (error?.message?.includes('extractPdfFigure')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'The extractPdfFigure IDE method is not available. This requires a Makerchip server with Live Doc support. Open a Makerchip panel connected to such a server and try again.'
          )
        ]);
      }
      if (error?.message?.includes('Panel') && error?.message?.includes('not found')) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'No Makerchip panel is open. PDF extraction runs inside the IDE. Open one first: Ctrl+Shift+P → "Makerchip: Open Panel".'
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
  /** Video format: 'auto', 'gif', or 'webm' (default: 'auto' - GIF for framesPerCycle=1, WebM otherwise) */
  format?: 'auto' | 'gif' | 'webm';
  /** Number of frames to capture per cycle (default: 1) */
  framesPerCycle?: number;
  /** Milliseconds per cycle in playback (default: 1000) */
  cycleTimeMs?: number;
  /** GIF encoding quality 1-30, lower is better (default: 10) */
  quality?: number;
  /** WebM bitrate in Mbps (default: 2.5, recommended: 10 for high quality) */
  Mbps?: number;
  /** Restore cycle after capture: true for original, false to stay at endCyc, or number for specific cycle (default: true) */
  restoreCycle?: boolean | number;
  /** Optional panel name to target. If not provided, uses the default panel. */
  panelName?: string;
  /** Save to file. If true, auto-generates filename. If string, uses as file path. If false/undefined, only saves if video is large. */
  saveToFile?: boolean | string;
}

/**
 * Language Model tool to capture VIZ simulation as video (GIF or WebM)
 */
export class CaptureVideoTool implements vscode.LanguageModelTool<CaptureVideoInput> {
  
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CaptureVideoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { startCyc, endCyc, format = 'auto' } = options.input;
    const cycles = endCyc - startCyc + 1;
    return {
      invocationMessage: `Capturing VIZ simulation (cycles ${startCyc}-${endCyc}, ${cycles} frames) as ${format.toUpperCase()} video...`
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
        framesPerCycle = 1,
        cycleTimeMs = 1000,
        quality = 10,
        Mbps = 2.5,
        restoreCycle = true,
        panelName,
        saveToFile
      } = options.input;
      
      log('[CaptureVideoTool] Invoked with:', { 
        startCyc, endCyc, format, framesPerCycle, cycleTimeMs, quality, Mbps, restoreCycle, panelName, saveToFile 
      });
      
      // Validate cycle range
      if (typeof startCyc !== 'number' || typeof endCyc !== 'number' || startCyc > endCyc) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid cycle range. startCyc must be less than or equal to endCyc.')
        ]);
      }
      
      // Build options for IDE method (exclude panelName and saveToFile)
      const videoOptions: any = {
        format,
        framesPerCycle,
        cycleTimeMs,
        quality,
        Mbps,
        restoreCycle,
        filename: null  // Don't download in IDE, we'll handle it here
      };
      
      log('[CaptureVideoTool] Calling captureVideo with options:', videoOptions);
      
      // Call the IDE method to get the video blob
      const result = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'captureVideo', 
        [startCyc, endCyc, videoOptions], 
        panelName
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
      
      // Determine actual format (handle auto-selection)
      const actualFormat = format === 'auto' ? (framesPerCycle === 1 ? 'gif' : 'webm') : format;
      const ext = actualFormat === 'gif' ? 'gif' : 'webm';
      
      // Decode the base64 envelope produced by the webview into a buffer.
      const videoBuffer = Buffer.from(result.base64, 'base64');
      const videoBytes = new Uint8Array(videoBuffer);
      
      // Determine MIME type from blob or format
      const mimeType = result.mimeType || `video/${ext}`;
      
      // Panel info for logging
      const panelInfo = panelName ? ` from panel '${panelName}'` : '';
      const cycles = endCyc - startCyc + 1;
      
      // Determine if we should save to file
      // Auto-save for larger files or if explicitly requested
      const shouldSave = saveToFile !== false && (saveToFile || videoBuffer.length > 100 * 1024); // Save if >100KB
      
      let savedPath: string | undefined;
      if (shouldSave) {
        if (typeof saveToFile === 'string') {
          // Use provided path
          savedPath = saveToFile;
        } else {
          // Auto-generate path (timestamped so repeated captures don't overwrite)
          const timestamp = Date.now();
          const filename = `makerchip-viz-${startCyc}-${endCyc}-${timestamp}.${ext}`;
          savedPath = path.join(os.tmpdir(), filename);
        }
        fs.writeFileSync(savedPath, videoBuffer);
        log('[CaptureVideoTool] Saved video to file:', savedPath);
      }
      
      // Try to use the proposed API for direct video return
      const LanguageModelToolResult2 = (vscode as any).LanguageModelToolResult2;
      const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;
      
      if (LanguageModelToolResult2 && LanguageModelDataPart && LanguageModelDataPart.video) {
        log('[CaptureVideoTool] Using proposed API (LanguageModelDataPart) to return video directly');
        try {
          const message =
             `Successfully captured VIZ simulation${panelInfo} as ${actualFormat.toUpperCase()} video (${cycles} cycles, ${Math.round(videoBytes.length / 1024)}KB).`
               + savedPath ? `\nSaved to: ${savedPath}` : '';
          
          return new LanguageModelToolResult2([
            new vscode.LanguageModelTextPart(message),
            LanguageModelDataPart.video(videoBytes, mimeType)
          ]);
        } catch (error) {
          log('[CaptureVideoTool] Failed to use proposed API, falling back to file:', error);
        }
      }
      
      // Fallback: Save to file if not already saved
      if (!savedPath) {
        const timestamp = Date.now();
        const filename = `makerchip-viz-${startCyc}-${endCyc}-${timestamp}.${ext}`;
        savedPath = path.join(os.tmpdir(), filename);
        fs.writeFileSync(savedPath, videoBuffer);
      }
      log('[CaptureVideoTool] Proposed API not available, using file fallback:', savedPath);
      
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully captured VIZ simulation${panelInfo} as ${actualFormat.toUpperCase()} video.\n` +
          `Cycles: ${startCyc}-${endCyc} (${cycles} total)\n` +
          `Format: ${actualFormat.toUpperCase()} (${framesPerCycle} frames/cycle)\n` +
          `Duration: ${cycles * cycleTimeMs / 1000}s at ${cycleTimeMs}ms/cycle\n` +
          `File: ${savedPath}\n` +
          `Size: ${Math.round(videoBuffer.length / 1024)}KB\n\n` +
          `The video file is available for viewing.`
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
    /** URL to the content (PDF file or web page). Supports https://, http://, file://, data URIs, etc. */
    contentUrl?: string;
    /**
     * Absolute path to a local file to load. The extension reads the file and builds a
     * `data:` URI internally, so large file contents never pass through the model context.
     * Takes precedence over contentUrl when both are provided.
     */
    filePath?: string;
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

      // When a local filePath is provided, read it here and build a data: URI internally so the
      // (potentially large) file contents never pass through the model context window.
      const resolvedParams: { contentUrl: string } = { contentUrl: contentParams.contentUrl ?? '' };
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
        const mimeType = mimeTypeForFile(filePath);
        const base64 = fs.readFileSync(filePath).toString('base64');
        resolvedParams.contentUrl = `data:${mimeType};base64,${base64}`;
      }
      
      // Call the IDE method to open the third-party pane
      const actualMnemonic = await vscode.commands.executeCommand(
        'makerchip.callIdeMethodWithResult', 
        'openThirdPartyPane', 
        [mnemonic, contentType, resolvedParams, paneOptions || {}], 
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
  
  // Register the wait-for-compile tool
  const waitCompileTool = vscode.lm.registerTool('makerchip_wait_compile', new WaitCompileTool());
  log('Wait compile tool registered:', !!waitCompileTool);
  context.subscriptions.push(waitCompileTool);
  
  // Register the generic IDE method invocation tool
  const ideTool = vscode.lm.registerTool('makerchip_ide_call', new IdeFunctionCallTool());
  log('IDE call tool registered:', !!ideTool);
  context.subscriptions.push(ideTool);
  
  // Register the VIZ image capture tool
  const vizImageTool = vscode.lm.registerTool('makerchip_get_viz_image', new GetVizImageTool());
  log('VIZ image tool registered:', !!vizImageTool);
  context.subscriptions.push(vizImageTool);
  
  // Register the PDF figure extraction tool (Live Doc inspection)
  const extractPdfTool = vscode.lm.registerTool('makerchip_extract_pdf_figure', new ExtractPdfFigureTool());
  log('Extract PDF figure tool registered:', !!extractPdfTool);
  context.subscriptions.push(extractPdfTool);
  
  // Register the VIZ video capture tool
  const captureVideoTool = vscode.lm.registerTool('makerchip_capture_video', new CaptureVideoTool());
  log('Capture video tool registered:', !!captureVideoTool);
  context.subscriptions.push(captureVideoTool);
  
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
  
  // Register the get cycle tool
  const getCycleTool = vscode.lm.registerTool('makerchip_get_cycle', new GetCycleTool());
  log('Get cycle tool registered:', !!getCycleTool);
  context.subscriptions.push(getCycleTool);
  
  // Register the set cycle tool
  const setCycleTool = vscode.lm.registerTool('makerchip_set_cycle', new SetCycleTool());
  log('Set cycle tool registered:', !!setCycleTool);
  context.subscriptions.push(setCycleTool);
  
  // Register the update play state tool
  const updatePlayStateTool = vscode.lm.registerTool('makerchip_update_play_state', new UpdatePlayStateTool());
  log('Update play state tool registered:', !!updatePlayStateTool);
  context.subscriptions.push(updatePlayStateTool);
  
  // Register the highlight tool
  const highlightTool = vscode.lm.registerTool('makerchip_highlight', new HighlightTool());
  log('Highlight tool registered:', !!highlightTool);
  context.subscriptions.push(highlightTool);
  
  // Register the clear highlights tool
  const clearHighlightsTool = vscode.lm.registerTool('makerchip_clear_highlights', new ClearHighlightsTool());
  log('Clear highlights tool registered:', !!clearHighlightsTool);
  context.subscriptions.push(clearHighlightsTool);
  
  // Register the set dark mode tool
  const setDarkModeTool = vscode.lm.registerTool('makerchip_set_dark_mode', new SetDarkModeTool());
  log('Set dark mode tool registered:', !!setDarkModeTool);
  context.subscriptions.push(setDarkModeTool);
  
  // Register the set live mode tool
  const setLiveModeTool = vscode.lm.registerTool('makerchip_set_live_mode', new SetLiveModeTool());
  log('Set live mode tool registered:', !!setLiveModeTool);
  context.subscriptions.push(setLiveModeTool);
  
  // Register the list panels tool
  const listPanelsTool = vscode.lm.registerTool('makerchip_list_panels', new ListPanelsTool());
  log('List panels tool registered:', !!listPanelsTool);
  context.subscriptions.push(listPanelsTool);
  
  // Verify tools are in the list
  setTimeout(() => {
    log('All registered tools:', vscode.lm.tools.map(t => t.name));
    const ourRunTool = vscode.lm.tools.find(t => t.name === 'makerchip_compile');
    const ourIdeTool = vscode.lm.tools.find(t => t.name === 'makerchip_ide_call');
    const ourVizImageTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_viz_image');
    const ourCaptureVideoTool = vscode.lm.tools.find(t => t.name === 'makerchip_capture_video');
    const ourGetLayoutTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_layout_state');
    const ourSetLayoutTool = vscode.lm.tools.find(t => t.name === 'makerchip_set_layout_state');
    const ourAvailablePanesTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_available_panes');
    const ourOpenPaneTool = vscode.lm.tools.find(t => t.name === 'makerchip_open_pane');
    const ourOpenThirdPartyPaneTool = vscode.lm.tools.find(t => t.name === 'makerchip_open_third_party_pane');
    const ourGetCycleTool = vscode.lm.tools.find(t => t.name === 'makerchip_get_cycle');
    const ourSetCycleTool = vscode.lm.tools.find(t => t.name === 'makerchip_set_cycle');
    const ourUpdatePlayStateTool = vscode.lm.tools.find(t => t.name === 'makerchip_update_play_state');
    const ourHighlightTool = vscode.lm.tools.find(t => t.name === 'makerchip_highlight');
    const ourClearHighlightsTool = vscode.lm.tools.find(t => t.name === 'makerchip_clear_highlights');
    const ourListPanelsTool = vscode.lm.tools.find(t => t.name === 'makerchip_list_panels');
    log('Found our compile tool:', !!ourRunTool);
    log('Found our IDE tool:', !!ourIdeTool);
    log('Found our VIZ image tool:', !!ourVizImageTool);
    log('Found our capture video tool:', !!ourCaptureVideoTool);
    log('Found our get layout state tool:', !!ourGetLayoutTool);
    log('Found our set layout state tool:', !!ourSetLayoutTool);
    log('Found our get available panes tool:', !!ourAvailablePanesTool);
    log('Found our open pane tool:', !!ourOpenPaneTool);
    log('Found our open third-party pane tool:', !!ourOpenThirdPartyPaneTool);
    log('Found our get cycle tool:', !!ourGetCycleTool);
    log('Found our set cycle tool:', !!ourSetCycleTool);
    log('Found our update play state tool:', !!ourUpdatePlayStateTool);
    log('Found our highlight tool:', !!ourHighlightTool);
    log('Found our clear highlights tool:', !!ourClearHighlightsTool);
    log('Found our list panels tool:', !!ourListPanelsTool);
    
    showOutputChannel(); // Show output channel on startup
  }, 1000);
}
