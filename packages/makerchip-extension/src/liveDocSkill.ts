/**
 * Composes the agent-facing Live Doc skill from two sources:
 *
 *   - `resources/live-doc-agent.md` (bundled): the skill's frontmatter, then guidance that only an
 *     agent needs -- the questions to settle with the user, and how to use the
 *     `makerchip_extract_pdf_figure` tool.
 *   - the connected sandhost's `/doc_src/live_doc.md`: the Live Doc API reference, raw markdown,
 *     straight from mono's `doc-src/public/live_doc.md`.
 *
 * The guidance is spliced INTO the reference at its `insert: agent-guidance` marker, which sits
 * just before `## API Reference` -- so the agent's instructions land inside the document's heading
 * hierarchy, after the concepts and before the API details, where they read in the right order.
 * A marker rather than a match on the heading text: the reference is maintained in another repo,
 * and a reworded heading would silently misplace the guidance. The frontmatter cannot be spliced
 * (it has to lead the file), so the guidance file is split at its frontmatter fence.
 *
 * Fetching the reference rather than bundling it means the agent's copy describes the API of the
 * server it is actually talking to -- which during development is the author's own working tree.
 *
 * If the fetch fails, the skill is still written, carrying the bundled guidance plus a note naming the URL
 * that did not answer. An agent then knows why it has no API reference instead of working without
 * one; a later activation that reaches the server replaces the file.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

/** Where sandhost serves the raw markdown (Documentation#live_doc_src). */
const DOC_PATH = '/doc_src/live_doc.md';

const FETCH_TIMEOUT_MS = 10000;

/** Bundled agent guidance, which also supplies the skill's frontmatter. */
const GUIDANCE_FILE = path.join('resources', 'live-doc-agent.md');

/** Start of the line in the reference that the guidance replaces. */
const INSERT_MARKER = '<!-- insert: agent-guidance';

const SKILL_FILE = 'live-doc.md';

export interface LiveDocSkillResult {
  /** 'composed' when the API reference was fetched; 'degraded' when only the guidance is present. */
  action: 'composed' | 'degraded';
  skillPath: string;
  /** Why the fetch failed, when it did. */
  reason?: string;
}

/**
 * Fetch the API reference as markdown.
 * @param url Absolute URL of the raw markdown.
 * @return The document text.
 * @throws If the server is unreachable, answers an error, or answers with something that is not
 *   the document -- a sandhost predating the route may serve an HTML 404 page with a 200, which
 *   would otherwise be installed as if it were the API reference.
 */
async function fetchApiReference(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) { throw new Error(`HTTP ${res.status} ${res.statusText}`); }
    const text = await res.text();
    if (!text.startsWith('# Live Doc')) {
      throw new Error(`response is not the Live Doc reference (starts with ${JSON.stringify(text.slice(0, 40))})`);
    }
    return text;
  } catch (error: any) {
    if (error?.name === 'AbortError') { throw new Error(`no response within ${FETCH_TIMEOUT_MS / 1000}s`); }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Split the guidance file into the frontmatter that must lead the skill and the body that is
 * spliced into the reference.
 * @param text Contents of `live-doc-agent.md`.
 * @return The `---`-fenced frontmatter (fences included) and everything after it.
 * @throws If the file does not open with a frontmatter fence, which would otherwise install a
 *   skill with no frontmatter -- silently unusable, since that is where its name and triggers are.
 */
function splitGuidance(text: string): { frontmatter: string; body: string } {
  const fence = '---\n';
  if (!text.startsWith(fence)) { throw new Error(`${GUIDANCE_FILE} does not start with a frontmatter fence`); }
  const end = text.indexOf(`\n${fence}`, fence.length);
  if (end < 0) { throw new Error(`${GUIDANCE_FILE} has an unterminated frontmatter block`); }
  return {
    frontmatter: text.slice(0, end + fence.length + 1).trimEnd(),
    body: text.slice(end + fence.length + 1).trim(),
  };
}

/**
 * Splice the agent guidance into the reference at INSERT_MARKER, replacing the marker's whole
 * comment. Falls back to appending, so a reference predating the marker still gets the guidance;
 * only its position degrades.
 * @param reference The fetched API reference.
 * @param guidance The guidance body.
 * @param log Output-channel logger, told when the fallback is taken.
 */
function splice(reference: string, guidance: string, log: (message: string) => void): string {
  const at = reference.indexOf(INSERT_MARKER);
  if (at < 0) {
    log(`Live Doc skill: no '${INSERT_MARKER}' marker in the API reference; appending guidance instead.`);
    return `${reference.trimEnd()}\n\n${guidance}\n`;
  }
  const close = reference.indexOf('-->', at);
  const end = close < 0 ? reference.length : close + '-->'.length;
  return reference.slice(0, at) + guidance + reference.slice(end);
}

/**
 * Write `.vscode-makerchip/.vscode/skills/live-doc.md`, composed as described above. Always
 * overwrites, so a failure never leaves a stale copy claiming to be current and a later success
 * repairs a degraded one.
 *
 * Called once per populate attempt -- on activation once resources have been populated or found
 * current, and again when the user runs the update command -- because installing skills clears
 * the directory this writes into, so anything written earlier would only be deleted. Resources
 * being found current still reaches this, so a change to the reference is picked up on the next
 * activation rather than waiting out the 7-day resource cycle.
 *
 * Takes its directories as arguments and imports no `vscode`, so it runs under plain Node --
 * the same reason claudeSkill.ts is arranged that way.
 *
 * @param opts.extensionPath Extension install root, holding `resources/`.
 * @param opts.skillsDir Where workspace skills are installed.
 * @param opts.serverUrl Sandhost this session is connected to.
 * @param opts.log Output-channel logger.
 */
export async function installLiveDocSkill(opts: {
  extensionPath: string;
  skillsDir: string;
  serverUrl: string;
  log: (message: string) => void;
}): Promise<LiveDocSkillResult> {
  const skillsDir = opts.skillsDir;
  const skillPath = path.join(skillsDir, SKILL_FILE);
  const url = `${opts.serverUrl.replace(/\/+$/, '')}${DOC_PATH}`;

  const { frontmatter, body: guidance } = splitGuidance(
    await fs.readFile(path.join(opts.extensionPath, GUIDANCE_FILE), 'utf-8'));

  let body: string;
  let result: LiveDocSkillResult;
  try {
    body = splice(await fetchApiReference(url), guidance, opts.log);
    result = { action: 'composed', skillPath };
  } catch (error: any) {
    const reason = error?.message || String(error);
    // No reference to splice into, so the guidance stands alone above the notice.
    body = [
      guidance,
      '',
      '# Live Doc API reference: UNAVAILABLE',
      '',
      `The reference could not be fetched from ${url} (${reason}), so the API details are missing`,
      'from this skill. The guidance above still applies.',
      '',
      'Do not guess at the API. If a Live Doc task comes up, tell the user that the Makerchip',
      'server could not supply the Live Doc API reference and that it is served by the sandhost',
      'the extension is connected to, so a server that is down, a dead dev tunnel, or a sandhost',
      'predating the route will all produce this. The reference is also published at',
      '`<server>/live_docs/` as HTML.',
      '',
    ].join('\n');
    result = { action: 'degraded', skillPath, reason };
  }

  const provenance = [
    '<!--',
    `  Composed by the Makerchip VS Code extension from ${GUIDANCE_FILE} (agent guidance) and`,
    `  ${url} (the Live Doc API reference, from mono's doc-src/public/live_doc.md).`,
    '  Edit the agent guidance in the extension and the API reference in mono; this file is',
    '  rewritten on each activation, so changes made here are lost.',
    '-->',
  ].join('\n');

  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(skillPath, `${frontmatter}\n\n${provenance}\n\n${body}`, 'utf-8');
  return result;
}
