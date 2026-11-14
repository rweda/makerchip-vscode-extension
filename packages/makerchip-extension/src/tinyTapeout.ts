import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { loadMetadata } from './compileCache';
import { log } from './logger';
import { requireTermsAccepted } from './terms';

/**
 * Tiny Tapeout (TT) support. A TL-Verilog file in a TT project (see ttProjectRoot), such as one made
 * from tt-makerchip-template, gets a "Run TT Flow" button in its editor title bar. The button
 * compiles the file for TT, commits and pushes it, and the push runs the TT flow on GitHub Actions.
 * Roadmap: mono's issues/036-tiny-tapeout-in-makerchip.md.
 */

/**
 * SandPiper arguments for TT's Verilog: the project's own, from `SANDPIPER_ARGS = ...` in its test/Makefile (as
 * `make verilog` uses them), or these, as in projects made before the template defined it.
 */
const TT_SANDPIPER_ARGS = '--inlineGen --noline --clkAlways --bestsv --iArgs';
const SANDPIPER_SAAS_URL = 'https://faas.makerchip.com/function/sandpiper-faas';

/** Context key listing visible TT design files; the button's `when` is `resourcePath in makerchip.ttFiles`. */
const FILES_CONTEXT_KEY = 'makerchip.ttFiles';

/** The subset of the built-in Git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string; readonly ahead?: number };
    readonly remotes: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[];
    readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
    readonly workingTreeChanges: readonly { readonly uri: vscode.Uri }[];
    readonly untrackedChanges?: readonly { readonly uri: vscode.Uri }[];
  };
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(): Promise<void>;
}

/** The TT project of `file`, if it is a TT design: a `.tlv` in `<root>/src/`, where `<root>` has `info.yaml`. */
async function ttProjectRoot(file: string): Promise<string | undefined> {
  const root = path.dirname(path.dirname(file));
  const isDesign = path.extname(file) === '.tlv' && path.basename(path.dirname(file)) === 'src';
  return isDesign && await fs.access(path.join(root, 'info.yaml')).then(() => true, () => false) ? root : undefined;
}

/** Show the button for the visible editors' TT design files. */
async function updateTtFiles(): Promise<void> {
  const files = await Promise.all(vscode.window.visibleTextEditors.map(async ({ document: { uri } }) =>
    uri.scheme === 'file' && await ttProjectRoot(uri.fsPath) ? uri.fsPath : undefined));
  await vscode.commands.executeCommand('setContext', FILES_CONTEXT_KEY, files.filter(f => f !== undefined));
}

interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

/**
 * The repo containing `file`, opening it in VS Code's Git support if needed: by default
 * (`git.openRepositoryInParentFolders`), it does not open repos outside the workspace folders itself.
 */
async function gitRepository(file: string): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!ext) {
    throw new Error('The built-in Git extension is not available.');
  }
  const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  let repo = api.getRepository(vscode.Uri.file(file));
  for (let dir = path.dirname(file); !repo && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (await fs.access(path.join(dir, '.git')).then(() => true, () => false)) {
      repo = await api.openRepository(vscode.Uri.file(dir));
      break;
    }
  }
  if (!repo) {
    throw new Error(`${file} is not in a Git repository.`);
  }
  return repo;
}

/** The GitHub repo (`owner/name`) that `repo` is a clone of, from its `origin` (or first) remote. */
function gitHubRepo(repo: GitRepository): string {
  const remote = repo.state.remotes.find(r => r.name === 'origin') ?? repo.state.remotes[0];
  const match = (remote?.pushUrl ?? remote?.fetchUrl)?.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error(`${repo.rootUri.fsPath} is not a clone of a GitHub repository (no GitHub remote).`);
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * Compile `tlvFile` for TT with SandPiper-SaaS (so nothing need be installed locally), writing the
 * `.sv` beside it. Unlike a Makerchip compile, `MAKERCHIP` is not defined, so the template's
 * Makerchip-only parts (lab, stimulus) drop out. Returns the `.sv` path and any warnings.
 */
async function compileForTt(tlvFile: string, root: string): Promise<{ svFile: string; warnings?: string }> {
  await requireTermsAccepted();  // SandPiper-SaaS is a Makerchip service.
  const makefile = await fs.readFile(path.join(root, 'test', 'Makefile'), 'utf-8').catch(() => '');
  const args = makefile.match(/^SANDPIPER_ARGS\s*:?=[ \t]*(.*?)[ \t]*(?:#.*)?$/m)?.[1] ?? TT_SANDPIPER_ARGS;
  const name = path.basename(tlvFile);
  const svName = name.replace(/\.tlv$/, '.sv');
  const tlv = await fs.readFile(tlvFile, 'utf-8');
  // The JSON API (see faas-mono functions/sandpiper-faas/README.md) answers with
  // {compile_id, status, stdout, stderr, sla, "out/<output>": content, ...}.
  const resp = await fetch(SANDPIPER_SAAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: `-i ${name} -o ${svName} ${args}`,
      IAgreeToSLA: true,
      sv_url_inc: true,
      responseType: 'json',
      // Only the top file: local includes (e.g. a sibling file's m4_include_lib) would need adding here.
      files: { [name]: tlv },
    }),
  });
  if (!resp.ok) {
    throw new Error(`SandPiper-SaaS returned HTTP ${resp.status} ${resp.statusText}.`);
  }
  const result = await resp.json() as Record<string, string>;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  log(`SandPiper-SaaS (Tiny Tapeout) for ${tlvFile}:\n${output}`);
  const status = Number(result.status);
  const sv = result[`out/${svName}`];
  // Status is the worst message severity; 1 is a warning.
  if (sv === undefined || !(status <= 1)) {
    throw new Error(`SandPiper failed to compile ${name} for Tiny Tapeout (status ${status}). See the Makerchip output channel.`);
  }
  const svFile = path.join(path.dirname(tlvFile), svName);
  // Stamp the .tlv's hash (line endings normalized), so CI can tell whether the committed .sv is still generated
  // from the committed .tlv (convention: makerchip-tt-views README, "Where a TT run's results land").
  const hash = createHash('sha256').update(tlv.replace(/\r\n/g, '\n')).digest('hex');
  await fs.writeFile(svFile, `// makerchip-tt: tlv-sha256 ${hash}  (Generated from ${name}.)\n${sv}`);
  return { svFile, warnings: status === 1 ? output : undefined };
}

/** A YAML scalar from a `key: value  # comment` line ('' if empty), or undefined if `key` is absent. */
function yamlValue(yaml: string, key: string): string | undefined {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = yaml.match(new RegExp(`^\\s*${k}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^#\\n]*?))[ \\t]*(?:#.*)?$`, 'm'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

/** `yaml` with `key`'s scalar (on a `key: value  # comment` line) replaced by `value` (as written, e.g. quoted). */
function setYamlValue(yaml: string, key: string, value: string): string {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return yaml.replace(new RegExp(`^(\\s*${k}:[ \\t]*)(?:"[^"]*"|'[^']*'|[^#\\n]*?)([ \\t]*(?:#.*)?)$`, 'm'),
    (_m, head: string, tail: string) => head + value + tail);
}

/**
 * Check the project info that TT's templates leave blank for the user and TT's checks require, mirroring
 * tt-support-tools' project_info.py and project_checks.py (TT's own check needs Python and tt-support-tools,
 * and its CI log needs GitHub sign-in to read). If any looks missing, say what, rather than pushing a run
 * that fails a minute in on a cryptic step. Advisory: the user may push anyway, so a mirror that drifts from
 * TT's checks costs at most a warning. Deliberately minimal (CI is the real check). Returns whether to proceed.
 */
async function checkProjectInfo(root: string): Promise<boolean> {
  const yaml = await fs.readFile(path.join(root, 'info.yaml'), 'utf-8');
  const infoMissing = ['title', 'author', 'description'].filter(key => !yamlValue(yaml, key));
  const pins = ['ui', 'uo', 'uio'].flatMap(bus => [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${bus}[${i}]`));
  if (!pins.some(pin => yamlValue(yaml, pin))) {
    infoMissing.push('pinout (at least one pin)');
  }
  const docs = (await fs.readFile(path.join(root, 'docs', 'info.md'), 'utf-8').catch(() => '')).replace(/\r\n/g, '\n');
  const docsMissing = [['How it works', 'Explain how your project works'], ['How to test', 'Explain how to use your project']]
    .filter(([heading, text]) => docs.includes(`# ${heading}\n\n${text}`)).map(([heading]) => `"${heading}"`);
  const missing = [['info.yaml', infoMissing], [path.join('docs', 'info.md'), docsMissing]] as const;
  if (missing.every(([, items]) => items.length === 0)) {
    return true;
  }
  const open = 'Open Files';
  const pushAnyway = 'Push Anyway';
  const choice = await vscode.window.showWarningMessage('Your project\'s information looks incomplete.', {
    modal: true,
    detail: 'Tiny Tapeout requires it (its template leaves it blank for you), so the flow would fail without:\n' +
      missing.filter(([, items]) => items.length > 0).map(([f, items]) => `${f}: ${items.join(', ')}`).join('\n'),
  }, open, pushAnyway);
  if (choice === pushAnyway) {
    return true;
  }
  if (choice === open) {
    for (const [f, items] of missing) {
      if (items.length > 0) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, f)), { preview: false });
      }
    }
  }
  return false;
}

/** The comment that marks a VGA design's Verilog (convention: makerchip-tt-views README, "Designs for TT VGA"). */
const VGA_MARKER = /\/\/ makerchip-tt: vga\b/;
/** info.yaml for the Tiny VGA Pmod, as VGA Playground's project export writes it. */
const VGA_INFO: [string, string][] = [['clock_hz', '25175000'],
  ...['R1', 'G1', 'B1', 'VSync', 'R0', 'G0', 'B0', 'HSync'].map((label, i): [string, string] => [`uo[${i}]`, `"${label}"`])];

/**
 * For a VGA design, check that info.yaml declares the VGA clock and sync pins, which TT's datasheet and Tiny Tapeout
 * Explorer (its VGA panel) read, offering to fill in VGA_INFO. Advisory, like checkProjectInfo. Returns whether to
 * proceed, and whether it changed info.yaml.
 */
async function checkVgaInfo(root: string): Promise<{ proceed: boolean; changed?: boolean }> {
  const file = path.join(root, 'info.yaml');
  const yaml = await fs.readFile(file, 'utf-8');
  if (yamlValue(yaml, 'clock_hz') === '25175000' && /hsync/i.test(yamlValue(yaml, 'uo[7]') ?? '') &&
      /vsync/i.test(yamlValue(yaml, 'uo[3]') ?? '')) {
    return { proceed: true };
  }
  const fill = 'Fill In';
  const pushAnyway = 'Push Anyway';
  const choice = await vscode.window.showWarningMessage('This is a VGA design, but info.yaml doesn\'t say so.', {
    modal: true,
    detail: 'Tiny Tapeout\'s datasheet and Tiny Tapeout Explorer read its clock and pins. Fill In sets ' +
      VGA_INFO.map(([key, value]) => `${key}: ${value}`).join(', ') + '.',
  }, fill, pushAnyway);
  if (choice === fill) {
    await fs.writeFile(file, VGA_INFO.reduce((y, [key, value]) => setYamlValue(y, key, value), yaml));
    return { proceed: true, changed: true };
  }
  return { proceed: choice === pushAnyway };
}

/**
 * If the `makerchip.tinyTapeout.runTestsBeforePush` setting is on, run the project's testbench as TT's `test`
 * workflow does, and if it fails (or can't run), say so. Advisory, like checkProjectInfo. Returns whether to proceed.
 */
async function runTests(root: string): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('makerchip', vscode.Uri.file(root)).get<boolean>('tinyTapeout.runTestsBeforePush')) {
    return true;
  }
  const testDir = path.join(root, 'test');
  // Judge by results.xml, as TT's workflow does: depending on the cocotb version, `make` may succeed even if tests
  // fail. (`make clean` deletes it, so it is this run's.)
  const output = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Tiny Tapeout: running the tests...' },
    () => promisify(exec)('make clean && make', { cwd: testDir, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout, stderr }) => stdout + stderr, (e: any) => `${e?.stdout ?? ''}${e?.stderr ?? ''}${e?.message ?? e}`));
  log(`TT tests in ${testDir}:\n${output}`);
  const results = await fs.readFile(path.join(testDir, 'results.xml'), 'utf-8').catch(() => undefined);
  const problem = results === undefined
    ? 'The tests could not run. They need cocotb (pip install -r test/requirements.txt) and Icarus Verilog.'
    : /<(failure|error)\b/.test(results) ? 'The tests failed.'
    : !/<testcase\b/.test(results) ? 'No tests ran. (Is cocotb the version in test/requirements.txt?)'
    : undefined;
  if (!problem) {
    return true;
  }
  const pushAnyway = 'Push Anyway';
  const choice = await vscode.window.showWarningMessage(problem, {
    modal: true,
    detail: 'See the Makerchip output channel. (Tests run because makerchip.tinyTapeout.runTestsBeforePush is on.)',
  }, pushAnyway);
  return choice === pushAnyway;
}

/** Whether GitHub marks `gitHub` (`owner/name`) as a template repo. False if GitHub can't say (offline, rate limit). */
async function isTemplateRepo(gitHub: string): Promise<boolean> {
  const resp = await fetch(`https://api.github.com/repos/${gitHub}`).catch(() => undefined);
  return resp?.ok ? ((await resp.json()) as { is_template?: boolean }).is_template === true : false;
}

/** The TT views, hosted from github.com/stevehoover/makerchip-tt-views (see its README). */
const TT_VIEWS_URL = 'https://stevehoover.github.io/makerchip-tt-views/';
const TT_VIEWS = [
  { mnemonic: 'TT Progress', page: 'progress.html',
    channel: { produces: ['tt/run-status'], subscribes: [{ type: 'tt/run-start' }], rpc: true } },
  { mnemonic: 'TT Layout', page: 'layout.html',
    channel: { subscribes: [{ type: 'tt/run-start' }, { type: 'tt/run-status' }], rpc: true } },
  { mnemonic: 'TT VGA', page: 'vga.html', vga: true,  // Only for a VGA design.
    channel: { subscribes: [{ type: 'compile-result', sources: ['ide'] }, { type: 'theme', sources: ['ide'] }], rpc: true } },
];

/** Calls an IDE method in `panel`. */
function ideIn(panel: string) {
  return (method: string, ...args: unknown[]) =>
    vscode.commands.executeCommand<any>('makerchip.callIdeMethodWithResult', method, args, panel);
}

/** In `panel`, open those of `views` not already open. */
async function openTtViews(panel: string, views: typeof TT_VIEWS, params: object, background: boolean): Promise<void> {
  const ide = ideIn(panel);
  const open = new Set((await ide('getAvailableViews') as { mnemonic: string }[]).map(v => v.mnemonic));
  for (const view of views.filter(v => !open.has(v.mnemonic))) {
    await ide('openThirdPartyView', view.mnemonic, 'iframe', { contentUrl: TT_VIEWS_URL + view.page },
      { channel: view.channel, params, background });
  }
}

/**
 * In `panel`, open any TT views not already open (TT VGA only if `vga`), point them all at `sha`, and show TT
 * Progress (the one to watch).
 */
async function showTtViews(panel: string, repo: string, sha: string, vga: boolean): Promise<void> {
  await openTtViews(panel, TT_VIEWS.filter(v => vga || !v.vga), { repo, sha }, true);
  await vscode.commands.executeCommand('makerchip.busEmit', 'tt/run-start', { repo, sha }, undefined, undefined, panel);
  await ideIn(panel)('activateView', TT_VIEWS[0].mnemonic);
}

/**
 * After a successful Makerchip compile (`id`, on `serverUrl`) of `file` into `panel`: if `file` is a TT design whose
 * Verilog is marked VGA, open TT VGA there (unless open), to show the design running without a push.
 */
export async function showTtVgaIfMarked(file: string, panel: string, id: string, serverUrl: string): Promise<void> {
  if (!await ttProjectRoot(file)) {
    return;
  }
  // The generated Verilog, as announced for the compile (named for the top file; see compileCache.initCompile).
  const sv = Object.entries((await loadMetadata(id))?.intermediateFiles ?? {})
    .find(([name]) => name.endsWith('.sv') && !name.endsWith('_gen.sv'))?.[1];
  const resp = sv && await fetch(serverUrl.replace(/\/$/, '') + sv.url);
  if (resp && resp.ok && VGA_MARKER.test(await resp.text())) {
    await openTtViews(panel, TT_VIEWS.filter(v => v.vga), {}, false);
  }
}

/** The TT button: compile for Makerchip and TT, commit, and push (which runs the TT flow). */
async function runTtFlow(uri?: vscode.Uri): Promise<void> {
  const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
  const root = file ? await ttProjectRoot(file) : undefined;
  if (!file || !root) {
    vscode.window.showErrorMessage('The Tiny Tapeout flow runs on a .tlv file in the src/ folder of a project with info.yaml.');
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(file);
    if (doc.isDirty) {
      await doc.save();
    }
    const repo = await gitRepository(file);
    const gitHub = gitHubRepo(repo);
    // E.g. a clone of tt-makerchip-template rather than a project made from it.
    if (await isTemplateRepo(gitHub)) {
      vscode.window.showErrorMessage(`${gitHub} is a template repository. Make your own project from it, as its README ` +
        'describes, and run the flow there.');
      return;
    }
    if (!await checkProjectInfo(root)) {
      return;
    }
    // Keep the Makerchip views in step with what is pushed. Not a gate: the TT compile fails on errors.
    await vscode.window.showTextDocument(doc);
    vscode.commands.executeCommand('makerchip.compile').then(undefined, e => log(`TT flow: Makerchip compile failed: ${e}`));

    const { svFile, warnings } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Tiny Tapeout: compiling with SandPiper-SaaS...' },
      () => compileForTt(file, root));

    const ours = [file, svFile];
    const vga = VGA_MARKER.test(await fs.readFile(svFile, 'utf-8'));
    if (vga) {
      const { proceed, changed } = await checkVgaInfo(root);
      if (!proceed) {
        return;
      }
      if (changed) {
        ours.push(path.join(root, 'info.yaml'));
      }
    }
    await repo.status();
    const { indexChanges, workingTreeChanges, untrackedChanges = [] } = repo.state;
    if (indexChanges.length === 0 && ![...workingTreeChanges, ...untrackedChanges].some(c => ours.includes(c.uri.fsPath))) {
      // Nothing to commit. A commit whose push failed is still to push.
      if (!repo.state.HEAD?.ahead) {
        vscode.window.showInformationMessage('Nothing has changed since your last push, so the Tiny Tapeout flow has already run on it.');
        return;
      }
      const push = 'Push';
      if (await vscode.window.showInformationMessage(`Nothing has changed, but your last commit isn't pushed to ${gitHub} yet.`,
        { modal: true }, push) !== push) {
        return;
      }
    } else {
      if (!await runTests(root)) {
        return;
      }
      const others = indexChanges.filter(c => !ours.includes(c.uri.fsPath));
      if (others.length > 0) {
        const include = 'Include Them';
        const choice = await vscode.window.showWarningMessage(
          `${others.length} other staged change(s) would be committed along with ${path.basename(file)}:`,
          { modal: true, detail: others.map(c => vscode.workspace.asRelativePath(c.uri)).join('\n') }, include);
        if (choice !== include) {
          return;
        }
      }
      const message = await vscode.window.showInputBox({
        title: `Commit and push to ${gitHub} to run the Tiny Tapeout flow`,
        prompt: (warnings ? 'SandPiper reported warnings (see the Makerchip output channel). ' : '') + 'Commit message:',
        value: `Update ${path.basename(file)}`,
        ignoreFocusOut: true,
      });
      if (message === undefined) {
        return;
      }
      await repo.add(ours);
      await repo.commit(message);
    }
    const sha = repo.state.HEAD?.commit ?? '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Tiny Tapeout: pushing to ${gitHub}...` },
      () => repo.push().catch((e: any) => {
        throw new Error(`Committed ${sha.slice(0, 7)}, but pushing it failed: ${e?.message ?? e} ` +
          'Once that is fixed, click the button again to push it.');
      }));
    // In the design file's panel, where its compile just went.
    await showTtViews(await vscode.commands.executeCommand<string>('makerchip.panelForFile', file), gitHub, sha, vga);
    vscode.window.showInformationMessage(
      `Pushed ${sha.slice(0, 7)}; the Tiny Tapeout flow is running on GitHub Actions (see the TT Progress view).`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Tiny Tapeout flow: ${error?.message ?? error}`);
  }
}

export function registerTinyTapeout(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('makerchip.ttRun', runTtFlow),
    vscode.window.onDidChangeVisibleTextEditors(updateTtFiles),
  );
  updateTtFiles();
}
