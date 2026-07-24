/**
 * Compilation cache management for Makerchip extension
 * 
 * Stores compilation results in ~/.vscode-makerchip/compile-cache/ organized by compile ID.
 * This is dual purpose. It enables restoration of webviews on VS Code reload, and it provides
 * reference data for LLM agents (Copilot). Note that navtlv.html and graph.svg are not very
 * useful to agents. They are just for restoration. Alternatively, we could omit caching them
 * locally and restore them instead from the server's compile cache (via /compile/<id>/...).
 * 
 * Each compilation directory contains:
 *   - top.tlv: Full source code (retained longest)
 *   - src/: Sibling source files for multi-file compiles, by basename (keeps their
 *           caller-chosen names from colliding with result files or metadata.json)
 *   - metadata.json: Compile status, timestamps, flags
 *   - stdall: SandPiper (TL-Verilog compiler) logs
 *   - make.out: Verilator (C++ simulator) logs
 *   - vlt_dump.vcd: Waveform data
 *   - graph.svg: Diagram (SandPiper-generated SVG)
 *   - parse_model.json: VIZ parse model (JSON string)
 *   - navtlv.html: Nav-TLV HTML
 * 
 * Pruning policy (age-based, automatic on activation):
 *   - Results (logs/VCD): Keep Nth entry if N ≤ 15 - days_old
 *   - Passing results: Keep Pth passing if P ≤ (45 - days_old) × 0.15
 *   - Source/metadata: Keep Nth entry if N ≤ 150 - days_old
 * 
 * Examples:
 *   - Fresh (0 days): 15 results, ~7 passing, 150 metadata
 *   - 15 days old: 1 result kept if it's the most recent
 *   - 45 days old: 1 passing result kept if it's the most recent passing
 *   - 150 days old: metadata/source pruned unless it's the most recent
 * 
 * Maintains compile-history.json index for searchable compilation history.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { CACHE_DIR } from './populateResources';

/** All result files a compilation can produce. */
export const RESULT_FILES = [
  'stdall',            // SandPiper (TL-Verilog compiler) log  [streamed]
  'make.out',          // Verilator (C++ simulator) log        [streamed]
  'vlt_dump.vcd',      // Waveform data                        [streamed]
  'graph.svg',         // Diagram SVG                          [single payload]
  'parse_model.json',  // VIZ parse model (JSON string)        [single payload]
  'navtlv.html',       // Nav-TLV HTML                         [single payload]
] as const;

export type ResultFileName = typeof RESULT_FILES[number];

/** Streamed files may hold meaningful partial content even after an error. */
const STREAMED_FILES: ResultFileName[] = ['stdall', 'make.out', 'vlt_dump.vcd'];

/**
 * Maps a server `err` type to the specific result file it terminates.
 * (compile / compile-timeout are handled separately as a SandPiper-stage failure.)
 */
const ERROR_TYPE_TO_FILE: Record<string, ResultFileName> = {
  'stdall': 'stdall',
  'makeout': 'make.out',
  'make.out': 'make.out',
  'vcd-stream': 'vlt_dump.vcd',
  'vcd': 'vlt_dump.vcd',
  'vcd-timeout': 'vlt_dump.vcd',
  'json': 'parse_model.json',
  'navtlv': 'navtlv.html',
  'navtlv-timeout': 'navtlv.html',
  'graph': 'graph.svg',
  'graph-timeout': 'graph.svg',
};

/** A SandPiper-stage error means these downstream files will never be produced. */
const SANDPIPER_ERROR_TYPES = new Set(['compile', 'compile-timeout']);
const MODEL_DEPENDENT_FILES: ResultFileName[] = ['make.out', 'vlt_dump.vcd', 'parse_model.json', 'navtlv.html'];

/** Per-file error record. Streamed files may still have partial content on disk. */
interface FileErrorInfo {
  type: string;       // Server error type (e.g. 'graph', 'vcd-timeout', 'json')
  timeout?: boolean;  // True for '*-timeout' errors
}

interface CompileMetadata {
  id: string;
  timestamp: string;
  sim?: boolean;            // Simulation requested (default true) (from server 'newcompile'). Gates vlt_dump.vcd (waveform).
  dot?: boolean;            // Diagram requested (default true) (from server 'newcompile'). Gates graph.svg (diagram).
  fileComplete: Partial<Record<ResultFileName, boolean>>; // true = file fully received OK
  fileError?: Partial<Record<ResultFileName, FileErrorInfo>>; // Per-file error (streamed files may retain partial content; single-payload files have null content)
  fileSkipped?: Partial<Record<ResultFileName, boolean>>; // File won't be produced (upstream failure, or sim/dot disabled)
  complete: boolean;        // True once ALL expected files are settled (complete | error | skipped). For finer checks, inspect fileComplete.
  passed?: boolean;         // Whether simulation passed (true/false/undefined if not yet determined)
  exitStatus?: {            // Exit codes from compilation stages
    sandpiper?: number;     // SandPiper compiler exit code
    verilator?: number;     // Verilator simulator exit code
  };
  error?: {                 // Compilation-level error (SandPiper-stage failure or denial). File-specific errors live in fileError.
    type: string;           // Error type: 'denied', 'compile-timeout', 'compile'
    timeout?: boolean;      // True for '*-timeout' errors
    message?: string;       // Optional error message (for 'denied' errors)
    reason?: string;        // Denial reason (for 'denied' errors)
    retryAfterSeconds?: number; // Retry delay (for 'denied' errors)
  };
  hasResults: boolean;      // Whether result files still exist (false indicates pruning)
  hasSource: boolean;       // Whether full source file still exists
  sourceSiblings?: string[]; // For multi-file compiles: basenames of sibling source files stored under src/
}

/**
 * A multi-file compile payload: `files` maps relative path -> contents, and `top`
 * names the entry file within `files`. Mirrors the server-side wire protocol.
 */
export interface MultiFileSource {
  files: Record<string, string>;
  top: string;
}

/** Source of a compile: a single string (top only) or a multi-file payload. */
export type CompileSource = string | MultiFileSource;

/**
 * Recompute `metadata.complete`: true once every EXPECTED result file is settled
 * (received, errored, or skipped). Expected set depends on sim/dot: the diagram
 * (graph.svg) is expected unless dot is disabled; the waveform (vlt_dump.vcd) is
 * expected unless sim is disabled. When sim/dot are unknown (undefined) we assume
 * the file is expected so `complete` is never reported prematurely.
 */
function recomputeComplete(m: CompileMetadata): void {
  const expected: ResultFileName[] = ['stdall', 'make.out', 'parse_model.json', 'navtlv.html'];
  if (m.sim !== false) { expected.push('vlt_dump.vcd'); }
  if (m.dot !== false) { expected.push('graph.svg'); }
  const settled = (f: ResultFileName): boolean =>
    !!(m.fileComplete[f] || m.fileError?.[f] || m.fileSkipped?.[f]);
  m.complete = expected.every(settled);
}


interface CompileHistoryEntry {
  id: string;
  timestamp: string;
  passed?: boolean;
}

interface CompileHistory {
  version: string;
  compilations: CompileHistoryEntry[];
}

const HISTORY_FILE = path.join(path.dirname(CACHE_DIR), 'compile-history.json');

// Queue for serializing all file updates to prevent race conditions
const updateQueue: Array<() => Promise<any>> = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || updateQueue.length === 0) {
    return;
  }
  
  isProcessing = true;
  
  while (updateQueue.length > 0) {
    const fn = updateQueue.shift()!;
    try {
      await fn();
    } catch (error) {
      console.error('[compileCache:processQueue] Function failed:', error);
    }
  }
  
  isProcessing = false;
  
  // Process any items that were added while we were working
  if (updateQueue.length > 0) {
    setTimeout(() => processQueue(), 0);
  }
}

/**
 * Serialize file updates to prevent concurrent read-modify-write races
 */
function serializeUpdate<T>(updateFn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    updateQueue.push(async () => {
      try {
        const result = await updateFn();
        resolve(result);
      } catch (error) {
        console.error('[compileCache:serializeUpdate] Update function failed:', error);
        reject(error);
      }
    });
    
    // Use setTimeout to trigger processQueue in next tick (setImmediate doesn't work in VS Code extension host)
    setTimeout(() => processQueue(), 0);
  });
}

// Pruning policy constants
// Results (log/VCD): Prune Nth entry if N > 15 - days_old
// Passing results: Keep Pth passing result unless P > (45 - days_old) * 0.15
// Source/metadata: Prune if N > 150 - days_old
const RESULTS_BASE_KEEP = 15;     // Keep up to 15 most recent results
const PASSING_BASE_KEEP = 45;     // Base days for passing results
const PASSING_RATE = 0.15;        // Passing results: keep more as they age
const METADATA_BASE_KEEP = 150;   // Keep source/metadata up to 150 entries

/**
 * Initialize a new compilation in the cache.
 *
 * @param params - sim/dot flags from the server 'newcompile' event, determining
 *                 which result files are expected. When a flag is explicitly false,
 *                 the corresponding file is pre-marked skipped.
 */
export async function initCompile(id: string, sourceCode?: CompileSource, params?: { sim?: boolean; dot?: boolean }): Promise<void> {
  const compileDir = path.join(CACHE_DIR, id);
  await fs.mkdir(compileDir, { recursive: true });

  // Split the source into the top file contents (always stored as top.tlv at the
  // cache-dir root) and any sibling files (stored under src/ by basename).
  let topContent: string | undefined;
  const siblings: Record<string, string> = {};
  if (typeof sourceCode === 'string') {
    topContent = sourceCode;
  } else if (sourceCode) {
    topContent = sourceCode.files[sourceCode.top];
    for (const [name, content] of Object.entries(sourceCode.files)) {
      if (name !== sourceCode.top) { siblings[path.basename(name)] = content; }
    }
  }
  const siblingNames = Object.keys(siblings);

  const metadata: CompileMetadata = {
    id,
    timestamp: new Date().toISOString(),
    sim: params?.sim,
    dot: params?.dot,
    fileComplete: {},
    fileSkipped: {},
    complete: false,
    hasResults: true,   // Initially true, set to false when pruned
    hasSource: topContent != null,
  };
  if (siblingNames.length > 0) { metadata.sourceSiblings = siblingNames; }
  if (params?.sim === false) { metadata.fileSkipped!['vlt_dump.vcd'] = true; }
  if (params?.dot === false) { metadata.fileSkipped!['graph.svg'] = true; }
  recomputeComplete(metadata);

  // Save full source code: the top file as top.tlv at the cache-dir root (matching
  // the single-file layout), plus any sibling source files under src/ so their
  // caller-chosen basenames can't collide with result files or metadata.json.
  if (topContent != null) {
    await fs.writeFile(path.join(compileDir, 'top.tlv'), topContent, 'utf-8');
  }
  if (siblingNames.length > 0) {
    const srcDir = path.join(compileDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    for (const name of siblingNames) {
      await fs.writeFile(path.join(srcDir, name), siblings[name], 'utf-8');
    }
  }

  await saveMetadata(id, metadata);
  await addToHistory(id, metadata.timestamp);
}

/**
 * Append chunk to a compilation result file (stdall, make.out, or vlt_dump.vcd)
 */
export async function appendFile(id: string, fileName: string, chunk: string): Promise<void> {
  const filePath = path.join(CACHE_DIR, id, fileName);
  await fs.appendFile(filePath, chunk, 'utf-8');
}

/**
 * Record a compilation error from a server `err` event.
 *
 * SandPiper-stage failures (compile / compile-timeout) are recorded at the
 * compilation level and cause downstream model-dependent files to be marked
 * skipped. All other error types are recorded against the specific file they
 * terminate. Streamed files keep whatever partial content was already written;
 * single-payload files simply have null content (no file written).
 */
export async function recordFileError(id: string, errorType: string): Promise<void> {
  return serializeUpdate(async () => {
    const metadata = await loadMetadata(id);
    if (!metadata) { return; }

    const timeout = errorType.endsWith('-timeout');

    if (SANDPIPER_ERROR_TYPES.has(errorType)) {
      // SandPiper (model compilation) failed: downstream files won't be produced.
      metadata.error = { type: errorType, timeout };
      if (!metadata.fileSkipped) { metadata.fileSkipped = {}; }
      for (const f of MODEL_DEPENDENT_FILES) {
        if (!metadata.fileComplete[f] && !metadata.fileError?.[f]) {
          metadata.fileSkipped[f] = true;
        }
      }
    } else {
      const file = ERROR_TYPE_TO_FILE[errorType];
      if (file) {
        if (!metadata.fileError) { metadata.fileError = {}; }
        metadata.fileError[file] = { type: errorType, timeout };
      } else {
        // Unknown error type: record at the compilation level.
        metadata.error = { type: errorType, timeout };
      }
    }

    recomputeComplete(metadata);
    await saveMetadata(id, metadata);
  });
}

/**
 * Record exit status from a compilation stage
 */
export async function recordExitStatus(id: string, stage: 'sandpiper' | 'verilator', exitCode: number): Promise<void> {
  return serializeUpdate(async () => {
    const metadata = await loadMetadata(id);
    if (!metadata) return;
    
    if (!metadata.exitStatus) {
      metadata.exitStatus = {};
    }
    metadata.exitStatus[stage] = exitCode;
    
    await saveMetadata(id, metadata);
  });
}

/**
 * Mark a file as successfully completed and recompute overall completion.
 */
export async function completeFile(id: string, fileName: string): Promise<void> {
  return serializeUpdate(async () => {
    const metadata = await loadMetadata(id);
    if (!metadata) {
      return;
    }

    // Mark this file as complete
    metadata.fileComplete[fileName as ResultFileName] = true;

    // Determine pass/fail from SandPiper logs
    if (fileName === 'stdall') {
      const passed = await detectPassFail(id, fileName);
      metadata.passed = passed;
      await updateHistoryStatus(id, passed);
    }

    recomputeComplete(metadata);

    await saveMetadata(id, metadata);
  });
}

/**
 * Detect pass/fail status from compilation log
 * Checks the last ~500 chars of the specified log file for PASSED/FAILED markers
 */
async function detectPassFail(id: string, fileName: string): Promise<boolean | undefined> {
  try {
    const logFile = path.join(CACHE_DIR, id, fileName);
    const logContent = await fs.readFile(logFile, 'utf-8');
    
    // Check the tail of the log (last 500 chars) for pass/fail indicators
    const tail = logContent.slice(-500);
    
    if (tail.includes('PASSED')) {
      return true;
    } else if (tail.includes('FAILED')) {
      return false;
    }
    
    // If neither marker found, status is undetermined
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Update pass/fail status in history
 */
async function updateHistoryStatus(id: string, passed: boolean | undefined): Promise<void> {
  // Note: No serializeUpdate here - this is always called from within completeFile() which is already serialized
  try {
    const history = await getHistory();
    const entry = history.compilations.find(e => e.id === id);
    if (entry) {
      (entry as any).passed = passed;
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    }
  } catch (error) {
    console.error('Failed to update history status:', error);
  }
}

/**
 * Get the directory for a specific compilation
 */
export function getCompileDir(id: string): string {
  return path.join(CACHE_DIR, id);
}

/**
 * Load metadata for a compilation
 */
export async function loadMetadata(id: string): Promise<CompileMetadata | null> {
  try {
    const metadataFile = path.join(CACHE_DIR, id, 'metadata.json');
    const content = await fs.readFile(metadataFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Minimal cancellation shape (avoids importing `vscode` into this module). */
export interface Cancellable {
  isCancellationRequested: boolean;
}

/**
 * Wait for a compilation to settle by polling its metadata in-process (no shell).
 *
 * Resolves as soon as `metadata.complete` is true, when the timeout elapses, or
 * when cancellation is requested. Because the extension host writes the metadata
 * itself, this lets tools await a compile without agents shelling out to read
 * `metadata.json`.
 *
 * @returns The latest metadata (may be null/incomplete) and whether the wait ended
 *   without the compile completing (`timedOut`, also set on cancellation).
 */
export async function waitForComplete(
  id: string,
  timeoutMs: number,
  pollMs = 400,
  token?: Cancellable
): Promise<{ metadata: CompileMetadata | null; timedOut: boolean }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const metadata = await loadMetadata(id);
    if (metadata?.complete) { return { metadata, timedOut: false }; }
    if (token?.isCancellationRequested) { return { metadata, timedOut: true }; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { return { metadata, timedOut: true }; }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/**
 * Read up to `maxChars` from the START of a cached result file (e.g. `stdall`,
 * `make.out`) so tools can surface compiler/simulator logs without a shell read.
 * The beginning is preferred because the FIRST error is the root cause — later
 * errors often ripple from it. When truncated, a `\n…(truncated)` marker is
 * appended. Returns null if the file is missing.
 */
export async function readResultFileHead(
  id: string,
  fileName: ResultFileName,
  maxChars = 2000
): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(CACHE_DIR, id, fileName), 'utf-8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n…(truncated)' : content;
  } catch {
    return null;
  }
}

/** Result files that can be injected into a fresh IDE to restore a compilation. */
export type RestoreFileName = ResultFileName;

export interface RestoreData {
  id: string;
  /** True when cached result files exist and can be injected (no recompile needed). */
  available: boolean;
  /** Cached result file contents keyed by file name (only present when available). */
  files?: Partial<Record<RestoreFileName, string>>;
  /** Exit codes captured during the original compilation. */
  exitStatus?: { sandpiper?: number; verilator?: number };
  /**
   * Original source for recompile fallback when results were pruned. A plain
   * string for single-file compiles, or a multi-file payload when sibling source
   * files were cached under src/.
   */
  source?: CompileSource;
}

/**
 * Read everything needed to restore a compilation into a freshly reloaded IDE.
 *
 * Returns:
 * - `available: true` with cached result files when the results still exist (inject directly)
 * - `available: false` with source files when results were pruned but the source survives,
 *   so the caller can recompile
 * - `available: false` with `source: undefined` when nothing remains
 */
export async function getRestoreData(id: string): Promise<RestoreData> {
  const metadata = await loadMetadata(id);
  const dir = path.join(CACHE_DIR, id);

  // Source is retained longest (all source files); read it/them for the recompile
  // fallback. For multi-file compiles, reconstruct the {files, top} payload. If
  // any source files are missing, leave source undefined.
  let source: CompileSource | undefined;
  try {
    const topContent = await fs.readFile(path.join(dir, 'top.tlv'), 'utf-8');
    const siblingNames = metadata?.sourceSiblings ?? [];
    if (siblingNames.length > 0) {
      const sourceFiles: Record<string, string> = { 'top.tlv': topContent };
      await Promise.all(
        siblingNames.map(async (name) => {
          sourceFiles[name] = await fs.readFile(path.join(dir, 'src', name), 'utf-8');
        })
      );
      source = { files: sourceFiles, top: 'top.tlv' };
    } else {
      source = topContent;
    }
  } catch {
    source = undefined;
  }

  // Read whatever result files are still on disk.
  const files: Partial<Record<RestoreFileName, string>> = {};
  await Promise.all(
    RESULT_FILES.map(async (name) => {
      try {
        files[name] = await fs.readFile(path.join(dir, name), 'utf-8');
      } catch {
        // Missing file (pruned or never produced) — skip.
      }
    })
  );

  const available = Object.keys(files).length > 0;
  return {
    id,
    available,
    files: available ? files : undefined,
    exitStatus: metadata?.exitStatus,
    source,
  };
}

/**
 * Save metadata for a compilation
 */
async function saveMetadata(id: string, metadata: CompileMetadata): Promise<void> {
  const metadataFile = path.join(CACHE_DIR, id, 'metadata.json');
  await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Add compilation to history index
 */
async function addToHistory(id: string, timestamp: string): Promise<void> {
  const promise = serializeUpdate(async () => {
    let history: CompileHistory;
    
    try {
      const content = await fs.readFile(HISTORY_FILE, 'utf-8');
      history = JSON.parse(content);
    } catch {
      history = { version: '1.0.0', compilations: [] };
    }

    // Add new entry at the front
    history.compilations.unshift({ id, timestamp });

    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  });
  await promise;
}

/**
 * Get compilation history
 */
export async function getHistory(): Promise<CompileHistory> {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { version: '1.0.0', compilations: [] };
  }
}

/**
 * Calculate days old from ISO timestamp
 */
function daysOld(timestamp: string): number {
  const then = new Date(timestamp).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

/**
 * Clean up old cache entries with age-based retention policy:
 * 
 * Results (log/VCD):
 *   - Prune Nth entry if N > 15 - days_old
 *   - Keep Pth passing result unless P > (45 - days_old) * 0.15
 * 
 * Source/metadata:
 *   - Prune if N > 150 - days_old
 * 
 * This means:
 *   - Fresh results (0 days): keep 15 most recent
 *   - 15-day-old results: keep only the most recent
 *   - Fresh passing results (0 days): keep 45 * 0.15 = 6.75 ≈ 6
 *   - 45-day-old passing result: keep if it's the most recent passing
 *   - Source/metadata survives much longer (up to 150 entries when fresh)
 */
export async function cleanupOldEntries(): Promise<void> {
  try {
    const history = await getHistory();
    const now = Date.now();
    
    // Process each compilation entry
    const toRemove: string[] = [];
    const passingCount = { total: 0 };
    
    for (let i = 0; i < history.compilations.length; i++) {
      const entry = history.compilations[i] as any;
      const age = daysOld(entry.timestamp);
      const metadata = await loadMetadata(entry.id);
      
      if (!metadata) continue;
      
      const isPassing = metadata.passed === true;
      const position = i + 1; // 1-indexed position
      
      // Count passing entries before this one
      if (isPassing) {
        passingCount.total++;
      }
      const passingPosition = passingCount.total;
      
      // Check if we should prune results (log/VCD)
      const shouldPruneResults = isPassing
        ? passingPosition > (PASSING_BASE_KEEP - age) * PASSING_RATE
        : position > RESULTS_BASE_KEEP - age;
      
      if (shouldPruneResults && metadata.hasResults) {
        // Remove result files but keep metadata/source
        const stdallFile = path.join(CACHE_DIR, entry.id, 'stdall');
        const makeoutFile = path.join(CACHE_DIR, entry.id, 'make.out');
        const vcdFile = path.join(CACHE_DIR, entry.id, 'vlt_dump.vcd');
        
        try {
          await fs.unlink(stdallFile).catch(() => {});
          await fs.unlink(makeoutFile).catch(() => {});
          await fs.unlink(vcdFile).catch(() => {});
          metadata.hasResults = false;
          metadata.fileComplete = {};
          metadata.complete = false;
          await saveMetadata(entry.id, metadata);
        } catch (error) {
          console.error(`Failed to prune results for ${entry.id}:`, error);
        }
      }
      
      // Check if we should prune entire entry (source/metadata)
      const shouldPruneMetadata = position > METADATA_BASE_KEEP - age;
      
      if (shouldPruneMetadata) {
        toRemove.push(entry.id);
      }
    }
    
    // Remove entire directories for pruned metadata entries
    for (const id of toRemove) {
      const compileDir = path.join(CACHE_DIR, id);
      await fs.rm(compileDir, { recursive: true, force: true });
    }
    
    // Update history to remove pruned entries
    if (toRemove.length > 0) {
      await serializeUpdate(async () => {
        history.compilations = history.compilations.filter(
          (e: any) => !toRemove.includes(e.id)
        );
        await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
      });
    }
    
  } catch (error) {
    console.error('Failed to cleanup old cache entries:', error);
  }
}
