/**
 * Terms acceptance gate. Nothing contacts a Makerchip service or downloads reference data until
 * the user accepts the Makerchip Terms of Service and Privacy Policy.
 *
 * Every network path funnels through {@link requireTermsAccepted} (or, at activation,
 * {@link ensureTermsAccepted}): opening a panel, updating reference data, and Compiler Explorer
 * compiles. The exchange with the server is the product working, not telemetry, so it does not
 * consult VS Code's telemetry setting; the dialog says so.
 */

import * as vscode from 'vscode';

// Bump when the terms or privacy policy change materially, to ask everyone again.
const TERMS_VERSION = 1;
const ACCEPTED_KEY = 'makerchip.termsAccepted';
const DECLINED_KEY = 'makerchip.termsDeclined';
const TERMS_URL = 'https://makerchip.com/terms/';
const PRIVACY_URL = 'https://makerchip.com/privacy/';

let state: vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
let pending: Promise<boolean> | undefined;

export function initTerms(context: vscode.ExtensionContext): void {
  state = context.globalState;
  state.setKeysForSync([ACCEPTED_KEY]);
}

/**
 * Resolve whether the user has accepted the current terms, asking (modally) if not.
 * Concurrent callers share one dialog.
 * @param atActivation Don't ask if the user already declined this version; the next explicit
 *   Makerchip action asks again.
 */
export function ensureTermsAccepted(atActivation = false): Promise<boolean> {
  if (state.get(ACCEPTED_KEY) === TERMS_VERSION) { return Promise.resolve(true); }
  if (atActivation && state.get(DECLINED_KEY) === TERMS_VERSION) { return Promise.resolve(false); }
  pending ??= ask().finally(() => { pending = undefined; });
  return pending;
}

/** As {@link ensureTermsAccepted}, but throws if the user declines. */
export async function requireTermsAccepted(): Promise<void> {
  if (!await ensureTermsAccepted()) {
    throw new Error('The Makerchip Terms of Service have not been accepted, so Makerchip cannot contact its ' +
      'server. The user is asked to accept them on their next Makerchip action.');
  }
}

async function ask(): Promise<boolean> {
  const accept = 'Accept', terms = 'View Terms of Service', privacy = 'View Privacy Policy';
  for (;;) {
    const choice = await vscode.window.showInformationMessage('Makerchip Terms of Service', {
      modal: true,
      detail:
        'Makerchip compiles and simulates your designs on the Makerchip server. Code you compile is sent to ' +
        'and stored on the server without protection; it is not private. Makerchip is for open-source ' +
        'development only.\n\n' +
        'The extension also downloads reference data (documentation, examples and libraries) from GitHub and ' +
        'Makerchip. This communication is how Makerchip works, so VS Code\'s telemetry setting does not apply ' +
        'to it. The extension collects no telemetry.\n\n' +
        'By accepting, you agree to the Makerchip Terms of Service and Privacy Policy, and accept this ' +
        'pre-release software as is, without warranty or liability.',
    }, accept, terms, privacy);
    if (choice === terms || choice === privacy) {
      await vscode.env.openExternal(vscode.Uri.parse(choice === terms ? TERMS_URL : PRIVACY_URL));
      continue;
    }
    await state.update(choice === accept ? ACCEPTED_KEY : DECLINED_KEY, TERMS_VERSION);
    return choice === accept;
  }
}
