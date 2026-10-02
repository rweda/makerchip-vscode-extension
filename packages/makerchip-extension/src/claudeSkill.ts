/**
 * Claude skill installer — gets Makerchip tool-usage rules in front of the Claude agent
 * BEFORE it issues its first `makerchip_*` call.
 *
 * ============================================================================================
 * MOTIVATION AND HISTORY (please read before changing or removing this module)
 * ============================================================================================
 *
 * THE PROBLEM
 * Our tools carry usage rules an agent must know BEFORE it calls them due to observed bugs
 * in the Microsoft Claude harness — above all that
 * Makerchip calls must be issued one at a time, because the harness bridge silently drops
 * concurrent ones and the call hangs. An agent that discovers this by trial hangs itself
 * first. So the rules have to reach it through a channel that does not depend on it having
 * already called a tool.
 *
 * CHANNELS EVALUATED, AND WHY THEY FAILED
 *
 *  1. MCP server `instructions` (the `InitializeResult` field intended for exactly this).
 *     Not available to us. We are not an MCP server — we register VS Code Language Model
 *     tools (`vscode.lm.registerTool` + `contributes.languageModelTools`). Anthropic's
 *     claude-code extension bridges all VS Code LM tools into the agent as a single pseudo
 *     server it names `client` (hence `mcp__client__makerchip*`). That server is theirs, not
 *     ours, and the `languageModelTools` contribution point has no server-level field.
 *
 *  2. Tool `modelDescription`. This was the ORIGINAL mechanism: a "read the guidance first"
 *     pointer on `makerchip_invoke_tool`, chosen because that tool is always offered
 *     (`when`-less). It was observed to fail. Tool schemas are deferred in the Claude
 *     harness: the agent sees a list of bare tool NAMES and fetches descriptions only for
 *     the tools it selects. Asked to open a PDF, the agent pattern-matched the name
 *     `mcp__client__makerchipListPanels`, fetched only that schema, and never fetched
 *     `makerchip_invoke_tool` — so it never saw the pointer. (Note the two spellings: the
 *     agent sees `mcp__client__` + `toolReferenceName`, camelCased, not the manifest `name`.
 *     The skill body explains that mapping, because a rule the agent must match against its
 *     own tool list has to be written in the form it actually sees.) Putting the sentence on all 30
 *     tools would cover this, but it is duplicated text that drifts, and it is paid in
 *     context for every tool in an enabled set. Note the structural ceiling too: a
 *     description arrives only once the agent has already decided to reach for a tool.
 *
 *  3. A generated instructions file in the Makerchip data folder. The harness auto-loads
 *     such a file only from the agent's own working directory, and we add the data folder as
 *     the LAST workspace folder, so for a user with their own project open it was normally
 *     never read. Removed.
 *
 *  4. Fail closed in the tool handler (first call per session returns the guidance instead
 *     of running). Useless for the failures that actually matter. Both batched concurrent
 *     calls and a stale tool-provider binding are dropped by the harness bridge and NEVER
 *     REACH THE EXTENSION, so the handler never runs and no result is ever produced.
 *
 *  5. Hooks in `~/.claude/settings.json` (`SessionStart`, `PreToolUse`). The most reliable
 *     option — harness-invoked, so no race, and `PreToolUse` can block a bad call outright.
 *     Rejected on invasiveness: it means merging shell-executing entries into a single
 *     user-owned config file we do not own, surviving concurrent writes from multiple
 *     editors, un-merging exactly on uninstall, and asking for consent to do so.
 *
 * WHAT WE DO INSTEAD
 * Install a user-level Claude skill at `~/.claude/skills/makerchip/`. The key asymmetry:
 * skill DESCRIPTIONS are eagerly loaded into the system prompt for every session, whereas
 * tool descriptions are deferred. So a short imperative "you MUST read this first" sits in
 * front of the agent before it plans any round, with no shell execution and no settings.json
 * edit. The description is deliberately short — a wall of text invites skimming — and the
 * rules themselves live in the skill body, which the harness loads when the agent acts on it.
 * The skill is self-contained: it is the single artifact carrying these rules.
 *
 * WHY THE BODY ENUMERATES THE OTHER GUIDANCE FILES (readSkillIndex)
 * The extension also installs detailed guidance as `~/.vscode-makerchip/.vscode/skills/*.md`.
 * Copilot discovers those by itself — they carry `applyTo` / `triggerWords` frontmatter it acts
 * on, so they are self-describing to it. Claude has no equivalent discovery for that directory:
 * it only scans its own skill locations, so those files are invisible to it however well they
 * describe themselves. That asymmetry is the whole reason readSkillIndex exists — our skill body
 * lists them (with each blurb read from the file's own frontmatter, so the two cannot drift) to
 * tell Claude they are there and what each is for. Likewise the shared workspace-hygiene intro is
 * APPENDED verbatim rather than restated; see readIntro.
 *
 * KNOWN LIMITS (do not try to fix these here; they are harness properties)
 *  - Mid-chat changes reach an already-open chat for DISCOVERY but not for USE. Both halves were
 *    measured on 2026-09-23 against Microsoft's Claude harness, and the split was a surprise:
 *      * A skill installed days into a live conversation arrived in-session, as a system-reminder
 *        listing the newly available skill. (Whether that was an incremental injection or a
 *        preamble rebuild on a session reload is unresolved, so do not rely on the mechanism.)
 *      * A newly registered tool likewise became visible in a live chat — name listed, schema and
 *        modelDescription fetchable — but INVOKING it hung on the dead gateway, the stale
 *        tool-provider binding described in the skill body. Visible, not reachable.
 *    So a new chat is still the only reliable remedy for USING tools after an install, update or
 *    host reload, which is what the notification asks for. Note this differs from Copilot, where
 *    the discovery half was also blocked.
 *  - Skill invocation is a model judgement, not an interlock. The description makes the
 *    common path correct; it cannot make it guaranteed.
 *
 * CLEANUP CONTRACT
 * `~/.claude` belongs to the user, so we must not leave litter. Ownership is tracked in
 * `.owners.json` keyed by `extensionPath`, which uniquely distinguishes code /
 * code-insiders / snap installs AND versions. Every activation reconciles: refresh our own
 * entry, drop entries whose path no longer exists (this is the real uninstall detector),
 * and delete the whole directory when the last owner is gone. `vscode:uninstall` does the
 * same minus the refresh, as a fast path for the common case. One shared skill directory,
 * never one per editor — duplicate descriptions would be charged to every session.
 *
 * IF A BETTER HOOK APPEARS OR BUGS ARE RESOLVED
 * This is clunky and poorly encapsulated: an extension reaching into another tool's user
 * config directory. If the Claude harness ever gains a way for an extension to contribute
 * agent-visible, extension-scoped context (an MCP `instructions` equivalent for VS Code LM
 * tools, or a declarative skill/instructions contribution point), delete this module, drop
 * the `vscode:uninstall` script, and publish one version that still runs the cleanup path so
 * existing installs remove their skill directory. If bugs are resolved, we probably still
 * want the extension guidance in place, so probably just the workaround guidance gets
 * dropped.
 * ============================================================================================
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Root of the user's Claude configuration. Resolved at call time, never hardcoded. */
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** Our single shared skill directory (one for all editors/installs — see CLEANUP CONTRACT). */
export const SKILL_DIR = path.join(CLAUDE_SKILLS_DIR, 'makerchip');

const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');
const OWNERS_FILE = path.join(SKILL_DIR, '.owners.json');
const LOCK_DIR = path.join(SKILL_DIR, '.lock');

/**
 * The detailed guidance files our skill body indexes. Duplicated from populateResources.ts
 * rather than imported: that module pulls in `vscode`, and this one must stay importable from
 * the `vscode:uninstall` script, which runs as plain Node.
 */
const MAKERCHIP_SKILLS_DIR = path.join(os.homedir(), '.vscode-makerchip', '.vscode', 'skills');

/**
 * The shared workspace-hygiene intro, bundled under `<extension>/resources/`. We append it to the
 * skill body rather than restating it, so Claude and Copilot cannot drift apart. Declared here and
 * imported by populateResources.ts (not the reverse) only because that module imports `vscode` and
 * this one must not.
 */
export const INTRO_TEMPLATE = 'copilot-instructions.md';

/** Windows for the advisory lock. Several editors can activate simultaneously at login. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 50;

/** One installation of this extension that wants the skill to exist. */
export interface SkillOwner {
  /** `context.extensionPath` — unique per editor AND per version. */
  extensionPath: string;
  /** Extension version, used to pick which owner renders the content. */
  version: string;
  /** `vscode.env.appName`, for diagnostics only. */
  host: string;
  /**
   * `context.extensionMode === vscode.ExtensionMode.Development` — an Extension Development Host
   * (F5) running this extension from source. The agent cannot detect this itself, so we tell it:
   * see the DEVELOPING section renderSkill adds when any live owner is a dev install.
   */
  devMode: boolean;
}

interface OwnerRecord {
  version: string;
  host: string;
  lastSeen: string;
  /** Absent in records written before dev-mode detection existed; treat as false. */
  devMode?: boolean;
}

interface OwnersFile {
  /** Format version of this file, so a future layout change can migrate. */
  format: number;
  owners: Record<string, OwnerRecord>;
}

export type ReconcileAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'skipped';

export interface ReconcileResult {
  action: ReconcileAction;
  skillPath: string;
}

/** Extract the `description:` value from leading YAML frontmatter (quoted or bare), or ''. */
function extractFrontmatterDescription(content: string): string {
  if (!content.startsWith('---')) {
    return '';
  }
  const end = content.indexOf('\n---', 3);
  const frontmatter = end >= 0 ? content.slice(0, end) : content;
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  if (!match) {
    return '';
  }
  let value = match[1].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/**
 * Index the detailed guidance files as Markdown bullets, taking each blurb from the file's own
 * frontmatter so this list cannot drift from what is actually installed. Returns [] when the
 * directory is missing or empty — which happens on a first install, because the files are laid
 * down by the version/age-gated populate path while we run on every activation. The caller
 * renders a directory pointer instead, and reconciling again after populate fills the list in.
 */
async function readSkillIndex(): Promise<string[]> {
  let files: string[];
  try {
    files = (await fs.readdir(MAKERCHIP_SKILLS_DIR))
      .filter(file => file.endsWith('.md') && file !== 'README.md')
      .sort();
  } catch {
    return [];
  }

  const lines: string[] = [];
  for (const file of files) {
    let description = '';
    try {
      description = extractFrontmatterDescription(
        await fs.readFile(path.join(MAKERCHIP_SKILLS_DIR, file), 'utf-8')
      );
    } catch {
      // Unreadable: list it without a blurb rather than dropping it.
    }
    lines.push(description ? `- \`${file}\` — ${description}` : `- \`${file}\``);
  }
  return lines;
}

/**
 * Render SKILL.md. Content is a pure function of (`version`, `skillIndex`), so an install whose
 * inputs have not changed rewrites nothing. Owner paths are deliberately NOT inlined: that would
 * churn the file whenever a sibling install appears or goes away.
 */
function renderSkill(version: string, skillIndex: string[], intro: string, devPaths: string[]): string {
  const devSection = devPaths.length === 0 ? '' : `## You are working against a development build

An Extension Development Host is running this extension from source, at:

${devPaths.map(p => `- \`${p}\``).join('\n')}

Consequences worth acting on:

- **Treat misbehaviour as a bug in that working tree, not a fact of life.** If a tool errors,
  hangs, returns something confusing, or its description does not match what it does, read the
  source before working around it — and say so, rather than silently routing around it.
- **Source edits need a host reload to take effect, and a reload breaks tool calls in chats that
  are already open.** Measured: after a reload, new tools become *visible* in an existing chat but
  invoking them hangs on the dead gateway. So the dev loop is: edit → reload → **start a new
  chat** → test. If you reloaded and a lone serial call hangs, that is the cause; do not retry.
- **Report gaps, not just failures.** Missing capabilities, tool descriptions that misled you,
  guidance that was absent when you needed it, and rules you nearly broke are all worth raising —
  you are the consumer of this API, so your confusion is evidence.
- Extension logs go to the \`Makerchip\` output channel; compilation artifacts to
  \`~/.vscode-makerchip/compile-cache/\`.

`;
  return `---
name: makerchip
description: Makerchip is a circuit design IDE with support for TL-Verilog, Visual Debug (VIZ), pluggable third-party views/components, etc., integrated into VS Code by an extension. You MUST read this skill before invoking ANY Makerchip tool (they reach you as \`mcp__client__makerchip*\`) — it documents call rules that will otherwise hang your calls.
---

# Makerchip

A circuit design IDE for TL-Verilog: compile/simulate \`.tlv\`, inspect waveforms, drive Visual
Debug (VIZ) panes, overlay simulation data on PDF figures (Live Doc), plug in third-party
views/components. Its tools are provided by the Makerchip VS Code extension and enable agent-driven
circuit design and teaching workflows.

## How these tools are named

This document names tools as the extension declares them, in snake_case — \`makerchip_compile\`,
\`makerchip_enable_tools\`. You will see them namespaced and camelCased instead:
\`mcp__client__makerchipCompile\`, \`mcp__client__makerchipEnableTools\`. Same tools; map between
the two forms as needed. Where a rule below has to be matched against what you actually see, it
is written as the \`mcp__client__makerchip*\` glob.

## Call rules — read before any \`mcp__client__makerchip*\` call

Based on testing of a pre-release version of Microsoft's Claude harness. Work around these
carefully; some result in HANGS.

- **Never issue \`mcp__client__makerchip*\` calls concurrently — issue them ONE AT A TIME**, awaiting each
  before starting the next. Batching two or more in a single execution round HANGS: the first
  returns, the rest never reach the extension (the harness bridge dispatches one tool call at a
  time and drops the concurrent ones). Fix: re-issue the calls serially. Note this overrides any
  general guidance you have about batching independent tool calls into one round.
- **To avoid this constraint, use \`makerchip_invoke_tool\` with its \`calls\` array.** That is one tool call
  from the harness's point of view, so it cannot trip the issue above, and the entries run serially
  inside the extension. It is the supported way to do several Makerchip operations at once. (It
  also avoids the need to enable tools in a separate turn with \`makerchip_enable_tools\`.
- The Makerchip tools are gated to conserve tool slots, so not all are offered at once. Two
  fallbacks are always available: \`makerchip_enable_tools\` (activate or release a capability
  set) and \`makerchip_invoke_tool\` (call any tool by name, even a gated one).
- \`makerchip_enable_tools\` makes a set's tools *offered*, but a newly enabled tool only becomes
  directly callable on the NEXT turn — the offered tool list for the current turn is fixed before
  the enable takes effect. Calling it the same turn fails with "No such tool available". This is
  expected and does NOT require a new chat: either wait for your next turn, or call it now via
  \`makerchip_invoke_tool\`.
- For a one-off call to a gated tool, prefer \`makerchip_invoke_tool\` (no lasting tool-set change).
- A set change (\`makerchip_enable_tools\` enable OR release) plus a same-turn call to an affected
  tool is unsafe: *enabling* lags (fast "No such tool available", above), and *releasing* a set
  then calling one of its still-offered tools that same turn HANGS (the bridge dispatches to a
  now-unregistered tool). Let set changes settle to the next turn, or use \`makerchip_invoke_tool\`.

### Stale tool-provider binding

The tool-provider clientId is bound at the start of the chat session and stays pinned for the
whole chat. If the extension host reloads, it comes back with a new gateway and clientId, but the
chat stays bound to the old one, so every \`mcp__client__makerchip*\` call routes to the dead connection and
**hangs indefinitely** — it never reaches the extension. If the user skips the command, a "skipped
from another client" / "Unknown error" is surfaced. The harness may even say *"another active
client now provides ... you may try calling the tool again"* — but retrying re-routes to the same
dead connection and hangs again.

### Diagnosing a hang

Try to avoid hangs, but if you slip and hit one, rule out the turn-local causes first:

- **Gating lag** — fails FAST with "No such tool available"; only right after
  \`makerchip_enable_tools\`; clears next turn. Do NOT start a new chat.
- **Concurrent calls** — HANGS; you issued >= 2 Makerchip calls in one execution round (the first
  returned, a later one hung). Fix: re-issue serially, one at a time. No fresh chat.
- **Same-turn set change** — HANGS; you released a set and called one of its tools in the same
  turn. Fix: let it settle to the next turn, or use \`makerchip_invoke_tool\`. No fresh chat.
- **Stale provider** — a LONE, serial call still HANGS (until skipped), with no gating change this
  turn, after a reload, an extension update/enable/disable, or an extension host crash; retrying
  keeps hanging. Fix: direct the user to start a fresh chat.

## Further guidance

${skillIndex.length > 0
    ? `Read the relevant file in \`${MAKERCHIP_SKILLS_DIR}/\` when its topic comes up:\n\n${skillIndex.join('\n')}`
    : `Detailed guidance is installed in \`${MAKERCHIP_SKILLS_DIR}/\`. List that directory and read the file whose topic matches your task. (It is populated by the Makerchip extension; if it is missing or empty, the extension has not finished setting up its reference data yet.)`}

${devSection}${intro === '' ? '' : `## The Makerchip data folder

What follows is the extension's own note about \`~/.vscode-makerchip/\`, shared verbatim with
Copilot so the two cannot drift. It is phrased for that folder opened as a workspace; the part
that matters to you is that the folder is extension-managed — do not create files there, and read
its paths as relative to \`~/.vscode-makerchip/\`.

**If a write under \`~/.vscode-makerchip/resources/\` fails with EACCES / "permission denied",
that is deliberate.** The extension write-protects its reference data so a stray file cannot be
created there. Do NOT \`chmod\` it, \`sudo\`, or otherwise work around the denial — the write was
the mistake, not the permission. Put the file in the user's own workspace instead, or in
\`~/.vscode-makerchip/tmp/\` for scratch work, and mention the denial so the user knows what
happened.

${intro}

`}## If the Makerchip extension is gone

This skill is installed and removed by the Makerchip VS Code extension. If none of the
\`extensionPath\` keys in \`${path.basename(OWNERS_FILE)}\` (beside this file) still exist on disk,
the extension was uninstalled without cleanup. Tell the user this skill directory is stale and
offer to delete it.

<!-- installed by the Makerchip VS Code extension, v${version} -->
`;
}

/**
 * Read the shared workspace-hygiene intro from the install that is rendering, demoting its
 * headings by two levels so they nest under our body instead of competing with its title. The
 * template has no fenced code blocks, so a line-prefix rewrite is safe; add fence handling if
 * that ever changes. Returns '' if unreadable — the section is then simply omitted.
 */
async function readIntro(extensionPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(extensionPath, 'resources', INTRO_TEMPLATE), 'utf-8');
    return raw.trim().replace(/^(#{1,4}) /gm, '##$1 ');
  } catch {
    return '';
  }
}

/** Numeric-segment version compare. Returns > 0 when `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (parseInt(as[i] ?? '0', 10) || 0) - (parseInt(bs[i] ?? '0', 10) || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Acquire the advisory lock via atomic `mkdir`, breaking a lock left behind by a crashed
 * process. Returns false if the lock could not be taken, in which case the caller should do
 * nothing: another editor is reconciling the same state right now and will reach the same result.
 */
async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(LOCK_DIR);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        const stat = await fs.stat(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between the mkdir and the stat; just retry.
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  return false;
}

async function releaseLock(): Promise<void> {
  await fs.rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
}

async function readOwners(): Promise<OwnersFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(OWNERS_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.owners && typeof parsed.owners === 'object') {
      return { format: 1, owners: parsed.owners };
    }
  } catch {
    // Missing or corrupt: rebuild from scratch rather than failing activation.
  }
  return { format: 1, owners: {} };
}

/** Write via temp file + rename, so a concurrent reader never sees a torn file. */
async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, target);
}

/** Drop owners whose install directory no longer exists — our primary uninstall detector. */
async function pruneDeadOwners(owners: Record<string, OwnerRecord>): Promise<void> {
  for (const extensionPath of Object.keys(owners)) {
    try {
      await fs.access(extensionPath);
    } catch {
      delete owners[extensionPath];
    }
  }
}

/**
 * Bring `~/.claude/skills/makerchip/` in line with the set of live installs. Safe to call on
 * every activation; cheap and idempotent when nothing has changed.
 *
 * @param owner This install. Pass `undefined` to deregister rather than register (uninstall).
 */
async function reconcile(
  owner: SkillOwner | undefined,
  claudeInstalled: boolean,
  removePath?: string,
): Promise<ReconcileResult> {
  // Write only for a user who actually has Claude. `~/.claude` is created by the Claude harness
  // on first run, so on a fresh machine the extension can activate before it exists — hence the
  // second signal, the Claude extension being installed, which lets us create the tree ahead of
  // that first chat. With neither signal we leave no footprint at all and never conjure another
  // tool's directory; if the user adopts Claude later, the next activation of any window picks
  // it up.
  const claudeDirExists = await fs.access(path.dirname(CLAUDE_SKILLS_DIR)).then(() => true, () => false);
  if (!claudeDirExists && !claudeInstalled) {
    return { action: 'skipped', skillPath: SKILL_FILE };
  }

  await fs.mkdir(SKILL_DIR, { recursive: true });

  if (!(await acquireLock())) {
    return { action: 'skipped', skillPath: SKILL_FILE };
  }

  try {
    const state = await readOwners();

    if (owner) {
      state.owners[owner.extensionPath] = {
        version: owner.version,
        host: owner.host,
        lastSeen: new Date().toISOString(),
        devMode: owner.devMode,
      };
    }
    if (removePath) {
      delete state.owners[removePath];
    }

    await pruneDeadOwners(state.owners);

    // Last owner gone: remove the whole directory so we leave nothing in the user's ~/.claude.
    if (Object.keys(state.owners).length === 0) {
      await releaseLock();
      await fs.rm(SKILL_DIR, { recursive: true, force: true });
      return { action: 'removed', skillPath: SKILL_FILE };
    }

    // Newest live owner renders the content, so a stale install cannot downgrade it. We take the
    // bundled intro from that same install's extensionPath (the owners key) so body and version
    // always come from one place.
    const [winnerPath, winner] = Object.entries(state.owners)
      .reduce((best, candidate) => (compareVersions(candidate[1].version, best[1].version) > 0 ? candidate : best));

    // Dev guidance keys off ANY live owner being a dev install, not just the rendering one: a
    // developer with both a released install and a checkout still wants it.
    const devPaths = Object.entries(state.owners)
      .filter(([, record]) => record.devMode)
      .map(([ownerPath]) => ownerPath)
      .sort();

    const desired = renderSkill(
      winner.version,
      await readSkillIndex(),
      await readIntro(winnerPath),
      devPaths,
    );
    const existing = await fs.readFile(SKILL_FILE, 'utf-8').catch(() => undefined);

    await writeAtomic(OWNERS_FILE, JSON.stringify(state, null, 2) + '\n');

    if (existing === desired) {
      return { action: 'unchanged', skillPath: SKILL_FILE };
    }
    await writeAtomic(SKILL_FILE, desired);
    return { action: existing === undefined ? 'created' : 'updated', skillPath: SKILL_FILE };
  } finally {
    await releaseLock();
  }
}

/**
 * Register this install and refresh the skill. Call unconditionally from `activate()` — not
 * from the resource-populate path, which is version/age gated and so would not prune the
 * entries of sibling installs that have been uninstalled since.
 *
 * Never throws: failing to write an optional guidance file must not break activation.
 *
 * @param claudeInstalled Whether the Claude extension is present, so we may create `~/.claude`
 *   before the harness has ever run. The caller supplies this because checking it needs the
 *   `vscode` API, which this module must not import.
 */
export async function reconcileClaudeSkill(owner: SkillOwner, claudeInstalled: boolean): Promise<ReconcileResult> {
  try {
    return await reconcile(owner, claudeInstalled);
  } catch {
    return { action: 'skipped', skillPath: SKILL_FILE };
  }
}

/**
 * Deregister this install; deletes the skill directory if we were the last owner. Used by the
 * `vscode:uninstall` script, which runs as plain Node with no `vscode` API available — which is
 * why this module imports only Node built-ins.
 */
export async function removeClaudeSkillOwner(extensionPath: string): Promise<ReconcileResult> {
  try {
    await fs.access(SKILL_DIR);
  } catch {
    return { action: 'removed', skillPath: SKILL_FILE };
  }
  try {
    // `true`: the directory demonstrably exists (checked above), so the signal is moot here.
    return await reconcile(undefined, true, extensionPath);
  } catch {
    return { action: 'skipped', skillPath: SKILL_FILE };
  }
}
