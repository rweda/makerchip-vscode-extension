import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from './logger';
import { requireTermsAccepted } from './terms';

/**
 * Tiny Tapeout (TT) support. A TL-Verilog file in a repo made from a ttXX-makerchip-template is
 * bound to that GitHub repo (by an agent, via `makerchip_tt_enable`), which shows a "Run TT Flow"
 * button in its editor title bar. The button compiles the file for TT, commits and pushes it, and
 * the push runs the TT flow on GitHub Actions — no agent needed. Roadmap: mono's
 * issues/036-tiny-tapeout-in-makerchip.md.
 */

/** SandPiper arguments for TT's Verilog; keep in sync with the template's `make verilog` (test/Makefile). */
const TT_SANDPIPER_ARGS = '--inlineGen --noline --clkAlways --bestsv --iArgs';
const SANDPIPER_SAAS_URL = 'https://faas.makerchip.com/function/sandpiper-faas';

const BINDINGS_KEY = 'makerchip.tt.bindings';
/** Context key listing bound file paths; the button's `when` is `resourcePath in makerchip.ttFiles`. */
const FILES_CONTEXT_KEY = 'makerchip.ttFiles';

/** A bound file's GitHub repo, as `owner/name`. */
interface TtBinding {
  repo: string;
}

/** The subset of the built-in Git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string };
    readonly remotes: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[];
    readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
  };
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(): Promise<void>;
}

let state: vscode.Memento;

function bindings(): Record<string, TtBinding> {
  return state.get<Record<string, TtBinding>>(BINDINGS_KEY, {});
}

async function setBinding(file: string, binding: TtBinding | undefined): Promise<void> {
  const all = { ...bindings(), [file]: binding };
  if (!binding) {
    delete all[file];
  }
  await state.update(BINDINGS_KEY, all);
  await vscode.commands.executeCommand('setContext', FILES_CONTEXT_KEY, Object.keys(all));
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

/** Bind `file` to the GitHub repo of the clone it is in, showing the TT button for it. */
async function bindFile(file: string): Promise<TtBinding> {
  const repo = await gitRepository(file);
  await fs.access(path.join(repo.rootUri.fsPath, 'info.yaml')).catch(() => {
    throw new Error(`${repo.rootUri.fsPath} has no info.yaml, so it is not a Tiny Tapeout project.`);
  });
  const remote = repo.state.remotes.find(r => r.name === 'origin') ?? repo.state.remotes[0];
  const match = (remote?.pushUrl ?? remote?.fetchUrl)?.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error(`${repo.rootUri.fsPath} is not a clone of a GitHub repository (no GitHub remote).`);
  }
  const binding = { repo: `${match[1]}/${match[2]}` };
  await setBinding(file, binding);
  return binding;
}

/**
 * Compile `tlvFile` for TT with SandPiper-SaaS (so nothing need be installed locally), writing the
 * `.sv` beside it. Unlike a Makerchip compile, `MAKERCHIP` is not defined, so the template's
 * Makerchip-only parts (lab, stimulus) drop out. Returns the `.sv` path and any warnings.
 */
async function compileForTt(tlvFile: string): Promise<{ svFile: string; warnings?: string }> {
  await requireTermsAccepted();  // SandPiper-SaaS is a Makerchip service.
  const name = path.basename(tlvFile);
  const svName = name.replace(/\.tlv$/, '.sv');
  // The JSON API (see faas-mono functions/sandpiper-faas/README.md) answers with
  // {compile_id, status, stdout, stderr, sla, "out/<output>": content, ...}.
  const resp = await fetch(SANDPIPER_SAAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: `-i ${name} -o ${svName} ${TT_SANDPIPER_ARGS}`,
      IAgreeToSLA: true,
      sv_url_inc: true,
      responseType: 'json',
      files: { [name]: await fs.readFile(tlvFile, 'utf-8') },
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
  await fs.writeFile(svFile, sv);
  return { svFile, warnings: status === 1 ? output : undefined };
}

/** A YAML scalar from a `key: value  # comment` line ('' if empty), or undefined if `key` is absent. */
function yamlValue(yaml: string, key: string): string | undefined {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = yaml.match(new RegExp(`^\\s*${k}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^#\\n]*?))[ \\t]*(?:#.*)?$`, 'm'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

/**
 * Check the project info that TT's templates leave blank for the user and TT's checks require, mirroring
 * tt-support-tools' project_info.py and project_checks.py (TT's own check needs Python and tt-support-tools,
 * and its CI log needs GitHub sign-in to read). If any looks missing, say what, rather than pushing a run
 * that fails a minute in on a cryptic step. Advisory: the user may push anyway, so a mirror that drifts from
 * TT's checks costs at most a warning. Returns whether to proceed.
 */
async function checkProjectInfo(root: string): Promise<boolean> {
  const yaml = await fs.readFile(path.join(root, 'info.yaml'), 'utf-8');
  const infoMissing = ['title', 'author', 'description'].filter(key => !yamlValue(yaml, key));
  const pins = ['ui', 'uo', 'uio'].flatMap(bus => [0, 1, 2, 3, 4, 5, 6, 7].map(i => `${bus}[${i}]`));
  if (!pins.some(pin => yamlValue(yaml, pin))) {
    infoMissing.push('pinout (at least one pin)');
  }
  const docs = await fs.readFile(path.join(root, 'docs', 'info.md'), 'utf-8').catch(() => '');
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

/** The TT views, hosted from github.com/stevehoover/makerchip-tt-views (see its README). */
const TT_VIEWS_URL = 'https://stevehoover.github.io/makerchip-tt-views/';
const TT_VIEWS = [
  { mnemonic: 'TT Progress', page: 'progress.html',
    channel: { produces: ['tt/run-status'], subscribes: [{ type: 'tt/run-start' }], rpc: true } },
  { mnemonic: 'TT Layout', page: 'layout.html',
    channel: { subscribes: [{ type: 'tt/run-start' }, { type: 'tt/run-status' }], rpc: true } },
];

/** Open (in the background) any TT views not already open, and point them all at `sha`. */
async function showTtViews(repo: string, sha: string): Promise<void> {
  const ide = (method: string, ...args: unknown[]) =>
    vscode.commands.executeCommand<any>('makerchip.callIdeMethodWithResult', method, args);
  const open = new Set((await ide('getAvailableViews') as { mnemonic: string }[]).map(v => v.mnemonic));
  for (const view of TT_VIEWS.filter(v => !open.has(v.mnemonic))) {
    await ide('openThirdPartyView', view.mnemonic, 'iframe', { contentUrl: TT_VIEWS_URL + view.page },
      { channel: view.channel, params: { repo, sha }, background: true });
  }
  await vscode.commands.executeCommand('makerchip.busEmit', 'tt/run-start', { repo, sha });
}

/** The TT button: compile for Makerchip and TT, commit, and push (which runs the TT flow). */
async function runTtFlow(uri?: vscode.Uri): Promise<void> {
  const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
  const binding = file ? bindings()[file] : undefined;
  if (!file || !binding) {
    vscode.window.showErrorMessage('This file is not set up for the Tiny Tapeout flow.');
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(file);
    if (doc.isDirty) {
      await doc.save();
    }
    const repo = await gitRepository(file);
    if (!await checkProjectInfo(repo.rootUri.fsPath)) {
      return;
    }
    // Keep the Makerchip views in step with what is pushed. Not a gate: the TT compile fails on errors.
    await vscode.window.showTextDocument(doc);
    vscode.commands.executeCommand('makerchip.compile').then(undefined, e => log(`TT flow: Makerchip compile failed: ${e}`));

    const { svFile, warnings } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Tiny Tapeout: compiling with SandPiper-SaaS...' },
      () => compileForTt(file));

    const ours = [file, svFile];
    const others = repo.state.indexChanges.filter(c => !ours.includes(c.uri.fsPath));
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
      title: 'Commit and push to run the Tiny Tapeout flow',
      prompt: (warnings ? 'SandPiper reported warnings (see the Makerchip output channel). ' : '') + 'Commit message:',
      value: `Update ${path.basename(file)}`,
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    await repo.add(ours);
    if (repo.state.indexChanges.length === 0) {
      vscode.window.showInformationMessage('Nothing has changed since the last commit, so the Tiny Tapeout flow has already run on it.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Tiny Tapeout: committing and pushing...' },
      async () => { await repo.commit(message); await repo.push(); });
    const sha = repo.state.HEAD?.commit ?? '';
    await showTtViews(binding.repo, sha);
    vscode.window.showInformationMessage(
      `Pushed ${sha.slice(0, 7)}; the Tiny Tapeout flow is running on GitHub Actions (see the TT Progress view).`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Tiny Tapeout flow: ${error?.message ?? error}`);
  }
}

export function registerTinyTapeout(context: vscode.ExtensionContext): void {
  state = context.workspaceState;
  vscode.commands.executeCommand('setContext', FILES_CONTEXT_KEY, Object.keys(bindings()));
  context.subscriptions.push(vscode.commands.registerCommand('makerchip.ttRun', runTtFlow));
  // The human counterpart of makerchip_tt_enable.
  context.subscriptions.push(vscode.commands.registerCommand('makerchip.ttEnable', async (uri?: vscode.Uri) => {
    const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
    if (!file?.endsWith('.tlv')) {
      vscode.window.showErrorMessage('Open your Tiny Tapeout project\'s src/project.tlv first.');
      return;
    }
    try {
      const { repo } = await bindFile(file);
      vscode.window.showInformationMessage(`Added the "Run TT Flow" button to ${path.basename(file)} (github.com/${repo}).`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Tiny Tapeout: ${error?.message ?? error}`);
    }
  }));
}

interface TtEnableToolInput {
  filePath: string;
  enabled?: boolean;
}

/** `makerchip_tt_enable`: bind (or unbind) a file's TT button. */
export class TtEnableTool implements vscode.LanguageModelTool<TtEnableToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<TtEnableToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const verb = options.input.enabled === false ? 'Removing' : 'Adding';
    return { invocationMessage: `${verb} the Tiny Tapeout button for ${path.basename(options.input.filePath)}...` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TtEnableToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const file = path.resolve(options.input.filePath);
    let text: string;
    try {
      if (options.input.enabled === false) {
        await setBinding(file, undefined);
        text = `Removed the Tiny Tapeout button from ${file}.`;
      } else {
        const { repo } = await bindFile(file);
        text = `Bound ${file} to github.com/${repo}. Its editor title bar now has a "Run TT Flow" button, ` +
          'which compiles it for Tiny Tapeout (writing the .sv beside it), commits, and pushes, running the flow ' +
          'on GitHub Actions.';
      }
    } catch (error: any) {
      text = `Error: ${error?.message ?? error}`;
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}
