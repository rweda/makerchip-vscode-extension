/**
 * The user's authorization for Makerchip's language-model tools to change a remote repository on their behalf (e.g. to
 * push to it). Each such tool asks with {@link confirmRepoChange}, and the user allows the change once, or always for
 * that repository.
 *
 * "Always" is kept in the extension's global state, not in a setting, which an agent could edit to authorize itself.
 * The "Makerchip: Manage Repository Authorizations" command revokes it.
 */

import * as vscode from 'vscode';

const STATE_KEY = 'makerchip.authorizedRepos';  // The repositories the user always allows changes to.

let state: vscode.Memento;

export function initRepoAuth(context: vscode.ExtensionContext): void {
  state = context.globalState;
  context.subscriptions.push(vscode.commands.registerCommand('makerchip.manageRepoAuthorizations', manage));
}

function authorized(): string[] {
  return state.get<string[]>(STATE_KEY) ?? [];
}

/**
 * Ask the user to allow an agent's change to `repo`, unless they always allow changes to it.
 * @param repo The remote repository, as `<host>/<path>`, e.g. `github.com/<owner>/<name>`.
 * @param action The change, completing "Allow the AI agent to ...?".
 * @param detail What the user needs to judge it, e.g. the commit message.
 * @param ask Ask even if `repo` is authorized, e.g. because the change goes ahead despite a warning (in `detail`).
 * @returns Whether the user allows it.
 */
export async function confirmRepoChange(repo: string, action: string, detail: string, ask = false): Promise<boolean> {
  if (!ask && authorized().includes(repo)) {
    return true;
  }
  const allow = 'Allow';
  const always = `Always Allow for ${repo}`;
  const choice = await vscode.window.showWarningMessage(`Allow the AI agent to ${action}?`, {
    modal: true,
    detail: `${detail}\n\n"${always}" lets Makerchip's agent tools change ${repo} without asking (unless something ` +
      'looks wrong). Revoke it with "Makerchip: Manage Repository Authorizations".',
  }, allow, always);
  if (choice === always && !authorized().includes(repo)) {
    await state.update(STATE_KEY, [...authorized(), repo]);
  }
  return choice !== undefined;
}

/** Show the authorized repositories, to revoke any. */
async function manage(): Promise<void> {
  const repos = authorized();
  if (repos.length === 0) {
    vscode.window.showInformationMessage('No repositories are authorized for Makerchip\'s agent tools.');
    return;
  }
  const keep = await vscode.window.showQuickPick(repos.map(label => ({ label, picked: true })), {
    canPickMany: true,
    title: 'Repositories Makerchip\'s agent tools may change without asking (uncheck to revoke)',
  });
  if (keep) {
    await state.update(STATE_KEY, keep.map(item => item.label));
  }
}
