import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from './logger';
import { requireTermsAccepted } from './terms';
import { unzip, zip } from './zip';

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

async function gitRepository(file: string): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): { getRepository(uri: vscode.Uri): GitRepository | null } }>('vscode.git');
  if (!ext) {
    throw new Error('The built-in Git extension is not available.');
  }
  const repo = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1).getRepository(vscode.Uri.file(file));
  if (!repo) {
    throw new Error(`${file} is not in a Git repository that VS Code has open. Open the repository's folder in VS Code.`);
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
  const form = new FormData();
  form.append('args', `-i ${name} -o ${svName} ${TT_SANDPIPER_ARGS}`);
  form.append('IAgreeToSLA', 'true');
  form.append('sv_url_inc', 'true');
  form.append('default_includes', 'false');
  form.append('context', new Blob([new Uint8Array(zip({ [name]: await fs.readFile(tlvFile) }))]), 'context.zip');
  const resp = await fetch(SANDPIPER_SAAS_URL, { method: 'POST', body: form });
  if (!resp.ok) {
    throw new Error(`SandPiper-SaaS returned HTTP ${resp.status} ${resp.statusText}.`);
  }
  // The response is a zip of stdout, stderr, status, and <compile_id>/out/<outputs>.
  const files = unzip(Buffer.from(await resp.arrayBuffer()));
  const output = `${files.stdout ?? ''}${files.stderr ?? ''}`;
  log(`SandPiper-SaaS (Tiny Tapeout) for ${tlvFile}:\n${output}`);
  const status = Number(files.status?.toString());
  const sv = Object.entries(files).find(([entry]) => entry.endsWith(`/out/${svName}`))?.[1];
  // Status is the worst message severity; 1 is a warning.
  if (!sv || !(status <= 1)) {
    throw new Error(`SandPiper failed to compile ${name} for Tiny Tapeout (status ${status}). See the Makerchip output channel.`);
  }
  const svFile = path.join(path.dirname(tlvFile), svName);
  await fs.writeFile(svFile, sv);
  return { svFile, warnings: status === 1 ? output : undefined };
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
    // Keep the Makerchip views in step with what is pushed. Not a gate: the TT compile fails on errors.
    await vscode.window.showTextDocument(doc);
    vscode.commands.executeCommand('makerchip.compile').then(undefined, e => log(`TT flow: Makerchip compile failed: ${e}`));

    const { svFile, warnings } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Tiny Tapeout: compiling with SandPiper-SaaS...' },
      () => compileForTt(file));

    const repo = await gitRepository(file);
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
    const sha = repo.state.HEAD?.commit?.slice(0, 7) ?? '';
    const show = 'Show Runs';
    if (await vscode.window.showInformationMessage(`Pushed ${sha}; the Tiny Tapeout flow is running on GitHub Actions.`, show) === show) {
      vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${binding.repo}/actions`));
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Tiny Tapeout flow: ${error?.message ?? error}`);
  }
}

export function registerTinyTapeout(context: vscode.ExtensionContext): void {
  state = context.workspaceState;
  vscode.commands.executeCommand('setContext', FILES_CONTEXT_KEY, Object.keys(bindings()));
  context.subscriptions.push(vscode.commands.registerCommand('makerchip.ttRun', runTtFlow));
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
