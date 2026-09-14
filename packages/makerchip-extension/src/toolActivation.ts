/**
 * Activation graph — the generic mechanism behind Makerchip tool gating. (Primary doc for gating.)
 *
 * Why: the extension contributes many `languageModelTools`, which would otherwise all count against
 * VS Code's hard 128-tool-per-request cap and bloat unrelated chats. Gating keeps only the relevant
 * subset advertised, so the suite stays small in *every* chat — not just once a window is over cap.
 *
 * How: activities and their building blocks are nodes in a fixed internal DAG whose children are
 * other nodes and/or tool leaves. Anything
 * asserting a node is a *holder*: an agent enable (with a TTL) or a live environmental condition. A
 * tool is "active" iff it is reachable from any node that currently has ≥1 holder. On every change we
 * recompute the closure of held nodes down to their tool leaves and push one context key per gated
 * tool (`makerchip.enabled.<toolName>`), diffing so we only flip keys that actually changed (keeping
 * the model's tool set — and its prompt cache — stable). Each gated tool's `when` clause is just its
 * own key, so all membership/OR logic lives here rather than in package.json. The two always-on meta
 * tools (`makerchip_enable_tools`, `makerchip_invoke_tool`) are ungated and keep everything reachable.
 *
 * Relation to VS Code virtual tools: once the *window's* total registered tool count crosses
 * `github.copilot.chat.virtualTools.threshold` (default 128), VS Code additionally folds tools into
 * auto-generated `activate_*` grouping tools. That is a second, automatic tier layered on top of us:
 * a tool this graph reports active (its `when` key is true) may still be presented behind a collapser
 * rather than as a top-level callable — expected, not a bug. Our gating is the *unconditional* lever
 * (it also trims the set below the threshold, where virtual tools does nothing); the two are
 * complementary, not redundant.
 *
 * Note on harnesses: the 128-tool cap and `when`-clause gating govern the shared VS Code
 * `languageModelTools` layer, so they apply the same whether the consumer is GitHub Copilot or the
 * Claude/agent harness (which surfaces these tools via the `mcp__client__*` bridge). The
 * `github.copilot.*` setting id is Copilot-namespaced but the underlying limit is shared. The two
 * always-on meta tools (`makerchip_enable_tools`, `makerchip_invoke_tool`) are ungated and keep
 * everything reachable.
 */
import * as vscode from 'vscode';
import { log } from './logger';

/** How long an agent enable holds a node before the sweep drops it (self-heals leaked enables). */
const ENABLE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days: hard cap — an enable can't outlive this.
const IDLE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day: release enables after this long with no Makerchip tool use.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (backstop; sweeps also run on window blur).
const STATE_KEY = 'makerchip.toolActivation.enables';
const KEY_PREFIX = 'makerchip.enabled.';

/**
 * The whole activation graph as one map: each node name → its children, where a child is either
 * another node or a gated tool leaf (`makerchip_*`). `base` and `communicate` are shared building
 * blocks pulled in by several activities; the remaining nodes are the public activities, each of
 * which includes `base`. (`makerchip_invoke_tool`/`makerchip_enable_tools` are ungated — not here.)
 */
const NODES: Record<string, string[]> = {
  // Shared building blocks (referenced by activities; also addressable on their own).
  base: [
    'makerchip_list_panels', 'makerchip_compile', 'makerchip_wait_compile',
    'makerchip_get_available_panes', 'makerchip_fit_pane', 'makerchip_get_viz_image',
    'makerchip_get_cycle', 'makerchip_set_cycle', 'makerchip_ide_call', 'makerchip_get_late_reply',
  ],
  communicate: ['makerchip_pane_call', 'makerchip_emit'],

  // Activities (the preferred public surface) — each pulls in `base`.
  customize: ['base', 'communicate', 'makerchip_open_third_party_pane'],
  demo: [
    'base',
    'makerchip_get_layout_state', 'makerchip_set_layout_state', 'makerchip_open_pane',
    'makerchip_update_play_state', 'makerchip_set_live_mode', 'makerchip_highlight',
    'makerchip_clear_highlights', 'makerchip_set_dark_mode',
  ],
  video: ['base', 'makerchip_capture_video'],
  livedoc: ['base', 'makerchip_extract_pdf_figure'],
  cewarpv: [
    'base',
    'makerchip_ce_compile', 'makerchip_get_warpv_config',
    'makerchip_set_warpv_config', 'makerchip_get_warpv_tlv',
  ],
  dev: ['base', 'communicate', 'makerchip_reload_panels'],
};

/** A child that isn't itself a node is a tool leaf; those leaves are the gated keys we manage. */
const NODE_NAMES = new Set<string>(Object.keys(NODES));
const TOOLS = new Set<string>(
  Object.values(NODES).flat().filter(child => !NODE_NAMES.has(child))
);

interface EnableToken { node: string; expiresAt: number; }
interface EnvHold { node: string; key: string; }

export class ToolActivation {
  private enables: EnableToken[] = [];
  private envHolds: EnvHold[] = [];
  private lastKeys = new Map<string, boolean>();
  // Single global activity clock, bumped on any Makerchip tool use (touch()). The sweep releases
  // enables once this goes stale (idle), so an active conversation never loses tools mid-stream.
  private lastUseAt = Date.now();

  constructor(private context: vscode.ExtensionContext) {
    const now = Date.now();
    // Per-workspace (not machine-global): each window/workspace keeps its own activation state.
    const saved = context.workspaceState.get<EnableToken[]>(STATE_KEY) ?? [];
    this.enables = saved.filter(e => e.expiresAt > now);
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
    // Sweep at a safe moment: when the window loses focus nothing is mid-invocation.
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(s => { if (!s.focused) { this.sweep(); } })
    );
    this.recompute();
  }

  /**
   * Resolve any accepted `target` to a node id (or undefined). Every activity, building block, and
   * tool is just a node here, so resolution is a single lookup: a `makerchip_*` tool leaf by exact
   * name, otherwise a node by case-insensitive name.
   */
  resolveNode(name: string): string | undefined {
    const n = name.trim();
    if (TOOLS.has(n)) { return n; }
    const low = n.toLowerCase();
    if (NODES[low]) { return low; }
    return undefined;
  }

  /** Add an agent-enable holder (with TTL) to a node, or remove one when `enabled` is false. */
  setEnabled(node: string, enabled: boolean): void {
    if (enabled) {
      this.lastUseAt = Date.now(); // enabling is activity — don't let the fresh hold idle-sweep immediately
      this.enables.push({ node, expiresAt: Date.now() + ENABLE_TTL_MS });
    } else {
      // Remove one enable holder for this node (soonest-expiring first).
      let idx = -1;
      for (let i = 0; i < this.enables.length; i++) {
        if (this.enables[i].node === node && (idx < 0 || this.enables[i].expiresAt < this.enables[idx].expiresAt)) {
          idx = i;
        }
      }
      if (idx >= 0) { this.enables.splice(idx, 1); }
    }
    this.persist();
    this.recompute();
  }

  /** Set (or clear) an environmental holder on a node, keyed by signal name (idempotent). */
  setEnv(node: string, key: string, on: boolean): void {
    const has = this.envHolds.some(h => h.node === node && h.key === key);
    if (on && !has) { this.envHolds.push({ node, key }); }
    else if (!on && has) { this.envHolds = this.envHolds.filter(h => !(h.node === node && h.key === key)); }
    else { return; }
    this.recompute();
  }

  /** Bump the global activity clock. Called on every Makerchip tool invocation (O(1), no recompute). */
  touch(): void {
    this.lastUseAt = Date.now();
  }

  /** Release every agent enable (the "Release All Tools" command). Env holders are unaffected. */
  releaseAll(): void {
    if (this.enables.length === 0) { return; }
    this.enables = [];
    this.persist();
    this.recompute();
  }

  private sweep(): void {
    const now = Date.now();
    // Coarse global idle: after IDLE_TTL_MS with no Makerchip tool use, release all agent enables.
    const idle = now - this.lastUseAt > IDLE_TTL_MS;
    const before = this.enables.length;
    this.enables = this.enables.filter(e => e.expiresAt > now && !idle);
    if (this.enables.length !== before) { this.persist(); this.recompute(); }
  }

  private persist(): void {
    this.context.workspaceState.update(STATE_KEY, this.enables);
  }

  /** The tools currently active = closure of all held nodes down to their tool leaves. */
  activeTools(): Set<string> {
    const held = new Set<string>([...this.enables.map(e => e.node), ...this.envHolds.map(h => h.node)]);
    const active = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
      if (visited.has(id)) { return; }
      visited.add(id);
      if (TOOLS.has(id)) { active.add(id); return; }
      for (const child of NODES[id] ?? []) { walk(child); }
    };
    for (const id of held) { walk(id); }
    return active;
  }

  /** Recompute activity and push only the context keys that changed. */
  private recompute(): void {
    const active = this.activeTools();
    const changed: string[] = [];
    for (const tool of TOOLS) {
      const desired = active.has(tool);
      if (this.lastKeys.get(tool) !== desired) {
        this.lastKeys.set(tool, desired);
        vscode.commands.executeCommand('setContext', `${KEY_PREFIX}${tool}`, desired);
        changed.push(`${desired ? '+' : '-'}${tool}`);
      }
    }
    if (changed.length > 0) { log('[toolActivation] keys changed:', changed.join(' ')); }
  }

  /** Complete, programmatically-derived reference of every accepted `target` (the enable tool's help). */
  catalog(): string {
    const isActivity = (name: string) => name === 'base' || NODES[name].includes('base');
    const acts = Object.keys(NODES).filter(isActivity).join(', ');
    const nodes = Object.entries(NODES)
      .map(([name, kids]) => `  ${name}: ${kids.join(', ')}`)
      .join('\n');
    return `Activities (preferred): ${acts}\n\n` +
      `Every node above is a valid target; building-block nodes and individual tool names are also accepted:\n${nodes}`;
  }
}

let singleton: ToolActivation | undefined;

export function initToolActivation(context: vscode.ExtensionContext): ToolActivation {
  singleton = new ToolActivation(context);
  return singleton;
}

export function getToolActivation(): ToolActivation | undefined {
  return singleton;
}

interface EnableToolsInput {
  /**
   * What to (de)activate — an activity (preferred); any building-block node or individual tool name
   * also works. All are just nodes in the activation graph, resolved uniformly.
   */
  target?: string;
  /** Enable (default) or disable/release one holder for the target. */
  enabled?: boolean;
}

/**
 * `makerchip_enable_tools` — activate (or release) Makerchip capabilities so the right tools are
 * offered without keeping all of them enabled (which pressures the request tool cap). Takes a single
 * `target` resolved uniformly to a node in the activation graph — publicly an activity, though any
 * building-block node or individual tool name is accepted too (any unrecognized `target` returns the
 * full accepted list, generated from the graph). The ungated always-on meta tools (`makerchip_enable_tools`,
 * `makerchip_invoke_tool`) keep every capability reachable regardless.
 */
export class EnableToolsTool implements vscode.LanguageModelTool<EnableToolsInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<EnableToolsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const text = (s: string) =>
      new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

    const activation = getToolActivation();
    if (!activation) { return text('Tool activation is not initialized.'); }

    const { target, enabled = true } = options.input;
    if (!target) {
      return text(`Specify a target to enable — an activity (see below).\n\n${activation.catalog()}`);
    }

    const node = activation.resolveNode(target);
    if (!node) {
      return text(`Unknown target '${target}'.\n\n${activation.catalog()}`);
    }

    activation.setEnabled(node, enabled);
    const active = [...activation.activeTools()].sort();
    return text(
      `${enabled ? 'Enabled' : 'Released'} '${target}'. ` +
      `Active Makerchip tools (${active.length}): ${active.join(', ') || '(none)'}.`
    );
  }
}
