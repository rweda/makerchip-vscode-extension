/**
 * Compilation cache management for Makerchip extension
 * 
 * Stores compilation results in ~/.vscode-makerchip/compile-cache/ organized by compile ID.
 * 
 * Each compilation directory contains:
 *   - top.tlv: Full source code (retained longest)
 *   - metadata.json: Compile status, timestamps, flags
 *   - stdall: SandPiper (TL-Verilog compiler) logs
 *   - make.out: Verilator (C++ simulator) logs
 *   - vlt_dump.vcd: Waveform data
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

interface CompileMetadata {
  id: string;
  timestamp: string;
  fileComplete: {           // Track completion status for each result file
    'stdall'?: boolean;     // SandPiper log streaming complete
    'make.out'?: boolean;   // Verilator log streaming complete
    'vlt_dump.vcd'?: boolean; // VCD streaming complete
  };
  complete: boolean;        // Whether compilation+simulation is complete (all files complete)
  passed?: boolean;         // Whether simulation passed (true/false/undefined if not yet determined)
  exitStatus?: {            // Exit codes from compilation stages
    sandpiper?: number;     // SandPiper compiler exit code
    verilator?: number;     // Verilator simulator exit code
  };
  error?: {                 // Error information if compilation/simulation failed
    type: string;           // Error type: 'denied', 'compile-timeout', 'compile', 'graph-timeout', 'graph', 'vcd-timeout', 'vcd', 'navtlv', 'json', 'stdall', 'makeout', 'vcd-stream'
    message?: string;       // Optional error message (for 'denied' errors)
    reason?: string;        // Denial reason (for 'denied' errors)
    retryAfterSeconds?: number; // Retry delay (for 'denied' errors)
  };
  hasResults: boolean;      // Whether result files still exist (false indicates pruning)
  hasSource: boolean;       // Whether full source file still exists
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

// Promise chain for serializing all file updates to prevent race conditions
let updateChain: Promise<void> = Promise.resolve();

/**
 * Serialize file updates to prevent concurrent read-modify-write races
 */
function serializeUpdate<T>(updateFn: () => Promise<T>): Promise<T> {
  const result = updateChain.then(updateFn);
  // Continue chain even if this update fails
  updateChain = result.then(() => {}, () => {});
  return result;
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
 * Initialize a new compilation in the cache
 */
export async function initCompile(id: string, sourceCode?: string): Promise<void> {
  const compileDir = path.join(CACHE_DIR, id);
  await fs.mkdir(compileDir, { recursive: true });

  const metadata: CompileMetadata = {
    id,
    timestamp: new Date().toISOString(),
    fileComplete: {},
    complete: false,
    hasResults: true,   // Initially true, set to false when pruned
    hasSource: true,    // Will be saved below
  };

  // Save full source code separately
  if (sourceCode) {
    const sourceFile = path.join(compileDir, 'top.tlv');
    await fs.writeFile(sourceFile, sourceCode, 'utf-8');
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
 * Record an error in compilation metadata
 */
export async function recordError(id: string, errorType: string, message?: string, details?: any): Promise<void> {
  return serializeUpdate(async () => {
    const metadata = await loadMetadata(id);
    if (!metadata) return;
    
    metadata.error = {
      type: errorType,
      message,
      ...details
    };
    
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
 * Mark a file as complete (updates metadata and checks overall completion)
 */
export async function completeFile(id: string, fileName: string): Promise<void> {
  return serializeUpdate(async () => {
    const metadata = await loadMetadata(id);
    if (!metadata) return;
    
    // Mark this file as complete
    metadata.fileComplete[fileName as 'stdall' | 'make.out' | 'vlt_dump.vcd'] = true;
    
    // Determine pass/fail from SandPiper logs
    if (fileName === 'stdall') {
      const passed = await detectPassFail(id, fileName);
      metadata.passed = passed;
      await updateHistoryStatus(id, passed);
    }
    
    // Check if all files are complete
    if (metadata.fileComplete['stdall'] && 
        metadata.fileComplete['make.out'] && 
        metadata.fileComplete['vlt_dump.vcd']) {
      metadata.complete = true;
    }
    
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
  return serializeUpdate(async () => {
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
  });
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
async function loadMetadata(id: string): Promise<CompileMetadata | null> {
  try {
    const metadataFile = path.join(CACHE_DIR, id, 'metadata.json');
    const content = await fs.readFile(metadataFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
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
  return serializeUpdate(async () => {
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
