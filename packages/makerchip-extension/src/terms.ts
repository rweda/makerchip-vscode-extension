/**
 * Terms acceptance gate. Nothing contacts a Makerchip service or downloads reference data until
 * the user accepts the Makerchip Terms of Service and Privacy Policy.
 *
 * Every network path funnels through {@link requireTermsAccepted} (or, at activation,
 * {@link ensureTermsAccepted}): opening a panel, updating reference data, and Compiler Explorer
 * compiles. The exchange with the server is the product working, not telemetry, so it does not
 * consult VS Code's telemetry setting (as mono's Privacy Policy explains).
 *
 * Revisions: the server publishes the documents' "Last updated" dates at `/terms/updated` (mono's
 * `sandhost/legal/Legal.coffee`). At activation, a user who has accepted is asked again if either
 * date is later than their acceptance. First acceptance needs no fetch, so nothing contacts the
 * server before the user accepts.
 */

import * as vscode from 'vscode';
import { log } from './logger';

const ACCEPTED_KEY = 'makerchip.termsAcceptedAt';  // ISO time of acceptance
const DECLINED_KEY = 'makerchip.termsDeclined';
const FALLBACK_SERVER_URL = 'https://makerchip.com';
const UPDATED_TIMEOUT_MS = 5_000;

let state: vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
let serverUrl: () => Promise<string>;
let readmeUri: vscode.Uri;
let pending: Promise<boolean> | undefined;

/** @param getServerUrl Resolves the Makerchip server, whose terms apply and whose dates we check. */
export function initTerms(context: vscode.ExtensionContext, getServerUrl: () => Promise<string>): void {
  state = context.globalState;
  state.setKeysForSync([ACCEPTED_KEY]);
  serverUrl = getServerUrl;
  readmeUri = vscode.Uri.joinPath(context.extensionUri, 'README.md');  // vsce always packages it
}

/**
 * Resolve whether the user has accepted the current terms, asking (modally) if not.
 * Concurrent callers share one dialog.
 * @param atActivation Check the server for revisions since acceptance. And don't ask a user who
 *   declined; their next explicit Makerchip action asks again.
 */
export async function ensureTermsAccepted(atActivation = false): Promise<boolean> {
  const acceptedAt = state.get<string>(ACCEPTED_KEY);
  if (acceptedAt) {
    return !atActivation || !await revisedSince(acceptedAt) || askOnce(true);
  }
  return !(atActivation && state.get(DECLINED_KEY)) && askOnce(false);
}

/** ISO time of the user's acceptance, if any, for the IDE (which asks again if it predates a revision). */
export function termsAcceptedAt(): string | undefined {
  return state.get<string>(ACCEPTED_KEY);
}

/** Record an acceptance given in the IDE (reported via its `onTermsAccepted` hook). */
export async function recordTermsAccepted(acceptedAt: string): Promise<void> {
  await state.update(ACCEPTED_KEY, acceptedAt);
  await state.update(DECLINED_KEY, undefined);
}

/** As {@link ensureTermsAccepted}, but throws if the user declines. */
export async function requireTermsAccepted(): Promise<void> {
  if (!await ensureTermsAccepted()) {
    throw new Error('The Makerchip Terms of Service have not been accepted, so Makerchip cannot contact its ' +
      'server. The user is asked to accept them on their next Makerchip action.');
  }
}

async function base(): Promise<string> {
  return (await serverUrl().catch(() => FALLBACK_SERVER_URL)).replace(/\/+$/, '');
}

/** Whether either document changed after `acceptedAt`. A failed check keeps the acceptance. */
async function revisedSince(acceptedAt: string): Promise<boolean> {
  try {
    const res = await fetch(`${await base()}/terms/updated`, { signal: AbortSignal.timeout(UPDATED_TIMEOUT_MS) });
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const dates: Record<string, string> = await res.json();
    // A same-day revision ("2026-10-21" < "2026-10-21T...") counts as accepted.
    return Object.values(dates).some(date => date > acceptedAt);
  } catch (error: any) {
    log(`⚠ Could not check for revised Makerchip terms: ${error?.message ?? error}`);
    return false;
  }
}

function askOnce(revised: boolean): Promise<boolean> {
  pending ??= ask(revised).finally(() => { pending = undefined; });
  return pending;
}

async function ask(revised: boolean): Promise<boolean> {
  // The essentials match the IDE's own notice (`termsGate` in mono's ide-env/coffee/ide_init.coffee),
  // which the IDE skips in this extension's panels; the documents say the rest.
  const accept = 'Accept', readme = 'View README', terms = 'View Terms of Service', privacy = 'View Privacy Policy';
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      revised ? 'Our terms have been revised' : 'Welcome to Makerchip', {
      modal: true,
      detail:
        (revised ? 'The Terms of Service or Privacy Policy changed since you accepted them.\n\n' : '') +
        'Makerchip is for open-source development. Code you submit is stored on our servers without ' +
        'protection. Designs, libraries, and plugins written by others run in your IDE. Load trusted code ' +
        'only. See "Before You Begin" in the README.\n\n' +
        'By accepting, you agree to the Makerchip Terms of Service and Privacy Policy.',
    }, accept, readme, terms, privacy);
    if (choice === readme) {
      // Not "continue": the modal would block reading it. Neither accepted nor declined, so the next
      // Makerchip action (or startup) asks again.
      await vscode.commands.executeCommand('markdown.showPreview', readmeUri);
      return false;
    }
    if (choice === terms || choice === privacy) {
      await vscode.env.openExternal(vscode.Uri.parse(`${await base()}/${choice === terms ? 'terms' : 'privacy'}/`));
      continue;
    }
    if (choice === accept) {
      await recordTermsAccepted(new Date().toISOString());
    } else {
      // A decline also withdraws an earlier acceptance: it does not cover the revision.
      await state.update(ACCEPTED_KEY, undefined);
      await state.update(DECLINED_KEY, true);
    }
    return choice === accept;
  }
}
