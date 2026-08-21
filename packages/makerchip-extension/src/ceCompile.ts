import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Headless Compiler Explorer (CE) compile client — see issues/005-headless-ce-api-compile.md.
 *
 * Compiles a program through the CE HTTP API (`POST /api/compiler/<id>/compile`) with **no
 * dependency on the CE GUI pane**. The CE `/api/*` surface is fully CORS-open and this runs in the
 * Node extension host, so there is no CORS/proxy concern. Used for testing and AI-driven compiles;
 * the returned assembly is what WARP-V's `~assemble` consumes.
 *
 * The `toAsmRows` / `detectEntry` transforms mirror those in the CE fork's
 * `static/parent-bridge.ts` (the pane path); they are re-implemented here (~20 lines) rather than
 * shared cross-repo.
 */

/** Deployed CE origin (dev override: http://localhost:10240). */
export const DEFAULT_CE_ORIGIN = 'https://ce.makerchip.com';

/** One line of produced assembly, tagged with the source line it came from. */
export interface AsmRow {
  /** The assembly text of this line (instruction, label or directive). */
  text: string;
  /** 1-based source line this row originated from, or null (label/directive/blank). */
  line: number | null;
}

/** Options for {@link compileOnCe}. */
export interface CompileOnCeOptions {
  /** CE compiler id to use (e.g. 'rv32-cgcc1430'). */
  compilerId: string;
  /** Source to compile. */
  source: string;
  /** CE language id (e.g. 'c', 'fortran'). Drives entry-symbol detection. */
  lang?: string;
  /** Compiler flags string (e.g. '-O2 -march=rv32i -mabi=ilp32'). */
  userArguments?: string;
  /** Comma-separated CE filter names, or a filters object. Default: directives,labels,commentOnly. */
  filters?: string | Record<string, boolean>;
  /** CE origin. Default {@link DEFAULT_CE_ORIGIN}. */
  ceOrigin?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

/** Result of a headless CE compile. */
export interface CeCompileResult {
  /** Compiler exit code (0 == success). */
  code: number;
  /** Detected entry-point label (e.g. 'main', Fortran's 'MAIN__'), or null if none recognised. */
  entry: string | null;
  /** CE compiler id used. */
  compilerId: string;
  /** Human-readable compiler name (best-effort; falls back to compilerId). */
  compilerName: string;
  /** Language id used. */
  lang: string;
  /** Per-row asm text + originating source line. */
  asm: AsmRow[];
  /** All asm rows joined by '\n' — direct input to WARP-V's ~assemble. */
  asmText: string;
  /** Compiler diagnostics (stderr), joined to a string. */
  stderr: string;
}

/** Join CE's array-of-{text} (stdout/stderr) — or a plain string — into one string. */
function joinText(lines: unknown): string {
  if (typeof lines === 'string') return lines;
  if (Array.isArray(lines)) {
    return lines.map(line => (typeof (line as any)?.text === 'string' ? (line as any).text : String(line ?? ''))).join('\n');
  }
  return '';
}

/** Map CE's asm array to {text, line} rows. */
function toAsmRows(asm: unknown): AsmRow[] {
  if (!Array.isArray(asm)) return [];
  return asm.map((row: any) => ({
    text: typeof row?.text === 'string' ? row.text : '',
    line: typeof row?.source?.line === 'number' ? row.source.line : null,
  }));
}

// The entry label a program "starts" at is language-specific: C/C++/Rust use `main`, while gfortran
// emits `MAIN__` (classic flang `MAIN_`, LLVM flang-new `_QQmain`). Detection rides on CE's parsed
// `labelDefinitions`, so it is immune to directive/comment/formatting differences between compilers.
const ENTRY_CANDIDATES: Record<string, string[]> = {
  fortran: ['MAIN__', 'MAIN_', '_QQmain', 'main'],
};
const DEFAULT_ENTRY_CANDIDATES = ['main'];

/** Pick the first candidate entry symbol the compiler actually defined, or null. */
export function detectEntry(langId: string | undefined, labelDefinitions: Record<string, number> | undefined): string | null {
  if (!labelDefinitions) return null;
  const candidates: string[] = (langId ? ENTRY_CANDIDATES[langId] : undefined) ?? DEFAULT_ENTRY_CANDIDATES;
  return candidates.find(name => name in labelDefinitions) ?? null;
}

/** Normalise a filters spec (comma string or object) into CE's `{name: true}` filters object. */
function toFiltersObject(filters: string | Record<string, boolean> | undefined): Record<string, boolean> {
  if (!filters) return { directives: true, labels: true, commentOnly: true };
  if (typeof filters !== 'string') return filters;
  return Object.fromEntries(
    filters
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .map(name => [name, true]),
  );
}

/**
 * Best-effort lookup of a compiler's human-readable name via `GET /api/compilers/<lang>`.
 * Returns the compilerId on any failure (name is cosmetic for our use).
 */
export async function resolveCompilerName(
  ceOrigin: string,
  lang: string,
  compilerId: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await fetch(`${ceOrigin}/api/compilers/${encodeURIComponent(lang)}?fields=id,name`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return compilerId;
    const list = (await res.json()) as Array<{ id: string; name: string }>;
    return list.find(c => c.id === compilerId)?.name ?? compilerId;
  } catch {
    return compilerId;
  }
}

/**
 * Compile `source` through the CE API and return the outcome (code, detected entry, asm, stderr).
 * Host-agnostic: no VS Code, GoldenLayout, pane, or CORS dependency.
 */
export async function compileOnCe(options: CompileOnCeOptions): Promise<CeCompileResult> {
  const {
    compilerId,
    source,
    lang = 'c',
    userArguments = '',
    filters,
    ceOrigin = DEFAULT_CE_ORIGIN,
    signal,
  } = options;

  const body = {
    source,
    lang,
    options: {
      userArguments,
      filters: toFiltersObject(filters),
      compilerOptions: {},
      libraries: [],
      tools: [],
    },
  };

  const url = `${ceOrigin}/api/compiler/${encodeURIComponent(compilerId)}/compile`;
  log(`compileOnCe: POST ${url} (lang=${lang}, args="${userArguments}")`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`CE compile request failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    code?: number;
    asm?: unknown;
    stderr?: unknown;
    labelDefinitions?: Record<string, number>;
  };

  const asm = toAsmRows(data.asm);
  const compilerName = await resolveCompilerName(ceOrigin, lang, compilerId, signal);
  return {
    code: typeof data.code === 'number' ? data.code : -1,
    entry: detectEntry(lang, data.labelDefinitions),
    compilerId,
    compilerName,
    lang,
    asm,
    asmText: asm.map(r => r.text).join('\n'),
    stderr: joinText(data.stderr),
  };
}

// --- WARP-V delivery -------------------------------------------------------
// Forward flow (CE → WARP-V), the headless equivalent of CE's "Run on WARP-V" button. The button
// posts the CE pane's latest compile as a `sourceAsm` event; here we emit the same payload shape for
// a fresh headless compile. WARP-V's `sourceAsm` handler (warp-v configurator App.js) reads
// `asmText`, `asm`, `sourceText`, `entry` (may be null → it uses `reset:`) and, on `build:true`,
// loads and runs the program. `detectEntry` GENERATES the entry label for WARP-V's crt0 preamble;
// a null entry is valid (hand-written asm), so delivery is not gated on it.

/** Deployed WARP-V configurator origin (dev override: http://localhost:3009). */
export const DEFAULT_WARPV_URL = 'https://warp-v.org';

/** The `sourceAsm` payload WARP-V consumes (mirrors CE's pane emit). */
interface WarpVSourceAsm {
  lang: string;
  compilerId: string;
  compilerName: string;
  code: number;
  asmText: string;
  asm: AsmRow[];
  entry: string | null;
  sourceText: string;
  stderr: string;
  build: boolean;
}

function toWarpVSourceAsm(result: CeCompileResult, source: string, build = true): WarpVSourceAsm {
  return {
    lang: result.lang,
    compilerId: result.compilerId,
    compilerName: result.compilerName,
    code: result.code,
    asmText: result.asmText,
    asm: result.asm,
    entry: result.entry,
    sourceText: source,
    stderr: result.stderr,
    build,
  };
}

/**
 * Ensure a WARP-V pane exists, then drive a build in it via the host's `callPane` RPC and return
 * the resulting host compile id. Reuses an already-open third-party pane with mnemonic `warpvPane`;
 * otherwise opens a new one (with `channel.rpc: true` so the host can call the pane's `build`
 * method, and subscribing to `sourceAsm`/`theme` so the legacy bus path and theme sync still work).
 *
 * WARP-V's `build(payload, waitForCompileId)` pane method loads the delivered program, generates the
 * TL-Verilog, and compiles it in the HOST panel via the `loadCode` IDE method — which reports
 * the server-assigned compile id. That id is relayed back through the RPC return chain, so we
 * get it directly (no "observe the next compile" guesswork). When `waitForCompileId` is false, WARP-V
 * returns immediately without awaiting the host compile (fast, fire-and-forget), so `compileId` is
 * null. Returns the target mnemonic and the compile id (or null).
 */
async function deliverToWarpV(
  result: CeCompileResult,
  source: string,
  opts: { warpvPane?: string; warpvUrl?: string; panelName?: string; waitForCompileId?: boolean; timeoutMs?: number } = {},
): Promise<{ target: string; compileId: string | null }> {
  const { warpvPane = 'WARP-V', warpvUrl = DEFAULT_WARPV_URL, panelName, waitForCompileId = true, timeoutMs = 60000 } = opts;
  const panes = (await vscode.commands.executeCommand(
    'makerchip.callIdeMethodWithResult',
    'getAvailablePanes',
    [],
    panelName,
  )) as Array<{ mnemonic: string; isThirdParty: boolean }> | undefined;
  let target = panes?.find(p => p.isThirdParty && p.mnemonic === warpvPane)?.mnemonic;
  if (!target) {
    target = (await vscode.commands.executeCommand(
      'makerchip.callIdeMethodWithResult',
      'openThirdPartyPane',
      [
        warpvPane,
        'iframe',
        { contentUrl: warpvUrl },
        {
          channel: {
            subscribes: [
              { type: 'sourceAsm', sources: ['platform.ai'] },
              { type: 'theme', sources: ['ide'] },
            ],
            rpc: true,
          },
        },
      ],
      panelName,
    )) as string;
  }
  // Drive the build via host→pane RPC. WARP-V loads+compiles in the host and (when waitForCompileId)
  // relays the compile id back. The pane may still be loading right after openThirdPartyPane; the
  // host queues the call until the pane signals `ready`, so a generous timeout covers first load.
  const payload = toWarpVSourceAsm(result, source);
  const compileId = (await vscode.commands.executeCommand(
    'makerchip.callIdeMethodWithResult',
    'callPane',
    [target, 'build', [payload, waitForCompileId], timeoutMs],
    panelName,
    false,
    timeoutMs + 5000,
  )) as string | null;
  return { target, compileId };
}

// --- Language Model tool ---------------------------------------------------

interface CeCompileToolInput {
  /** Source to compile. */
  source: string;
  /** CE compiler id. Default 'rv32-cgcc1430' (RISC-V rv32 gcc, for WARP-V). */
  compilerId?: string;
  /** CE language id. Default 'c'. */
  lang?: string;
  /** Compiler flags. Default '-O2 -march=rv32i -mabi=ilp32'. */
  options?: string;
  /** Comma-separated CE filter names. Default 'directives,labels,commentOnly'. */
  filters?: string;
  /** CE origin override (e.g. 'http://localhost:10240' for local dev). */
  ceOrigin?: string;
  /** When true, deliver a successful compile to a WARP-V pane (like CE's "Run on WARP-V" button). */
  deliverToWarpV?: boolean;
  /**
   * When delivering to WARP-V, whether to wait for and return the host compile id (so it can be
   * polled with makerchip_wait_compile). Default true. Set false for fire-and-forget delivery
   * (faster; skips the host compile round-trip).
   */
  waitForCompileId?: boolean;
  /** Target WARP-V pane mnemonic. Reused if open; a new pane is opened if it does not exist. Default 'WARP-V'. */
  warpvPane?: string;
  /** WARP-V pane URL override (e.g. 'http://localhost:3009' for local dev). Default 'https://warp-v.org'. */
  warpvUrl?: string;
  /** Optional panel name to target. */
  panelName?: string;
}

/**
 * Headless CE compile tool: compiles source via the CE API (no CE pane) and returns the assembly
 * plus a compile summary. See issues/005-headless-ce-api-compile.md.
 */
export class CeCompileTool implements vscode.LanguageModelTool<CeCompileToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CeCompileToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const compilerId = options.input.compilerId ?? 'rv32-cgcc1430';
    return { invocationMessage: `Compiling via Compiler Explorer (${compilerId})...` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CeCompileToolInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (!input?.source || typeof input.source !== 'string') {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No `source` provided. Pass the program source to compile.'),
      ]);
    }
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      const result = await compileOnCe({
        compilerId: input.compilerId ?? 'rv32-cgcc1430',
        source: input.source,
        lang: input.lang ?? 'c',
        userArguments: input.options ?? '-O2 -march=rv32i -mabi=ilp32',
        filters: input.filters ?? 'directives,labels,commentOnly',
        ceOrigin: input.ceOrigin,
        signal: ac.signal,
      });
      const ok = result.code === 0;
      let summary =
        `CE compile ${ok ? 'succeeded' : `failed (exit ${result.code})`}\n` +
        `compiler: ${result.compilerName} (${result.compilerId}), lang: ${result.lang}\n` +
        `entry: ${result.entry ?? '(none detected — WARP-V would use reset:)'}\n` +
        `asm lines: ${result.asm.length}` +
        (result.stderr ? `\nstderr:\n${result.stderr}` : '') +
        (ok ? `\n\nassembly:\n${result.asmText}` : '');
      if (input.deliverToWarpV) {
        if (!ok) {
          summary += `\n\nNot delivered to WARP-V (compile failed).`;
        } else {
          try {
            const waitForCompileId = input.waitForCompileId !== false;
            const { target, compileId } = await deliverToWarpV(result, input.source, {
              warpvPane: input.warpvPane,
              warpvUrl: input.warpvUrl,
              panelName: input.panelName,
              waitForCompileId,
            });
            summary += `\n\nDelivered to WARP-V pane '${target}' (build requested).`;
            if (compileId) {
              summary +=
                `\nHost build compile id: ${compileId} \u2014 poll it with makerchip_wait_compile ` +
                `to get compilation/simulation results.`;
            } else if (waitForCompileId) {
              summary +=
                `\nThe WARP-V build ran but reported no compile id (host compilation may have been ` +
                `denied or failed). Check the WARP-V pane.`;
            } else {
              summary += `\nNot awaiting a compile id (waitForCompileId=false); the build runs in the WARP-V pane.`;
            }
          } catch (err: any) {
            summary += `\n\nCompile succeeded but WARP-V delivery failed: ${err?.message ?? err}`;
          }
        }
      }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary)]);
    } catch (error: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`CE compile failed: ${error?.message ?? error}`),
      ]);
    } finally {
      sub.dispose();
    }
  }
}
