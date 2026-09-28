// TL-Verilog extension entry point (desktop / Node host).
//
// The activation is intentionally thin and layered:
//   - registerLanguageFeatures: web-safe language support (semantic tokens).
//     This is the shared core and the intended web (browser) entry.
//   - activateExperimentalFeatures: the Waveform button, transferred from the
//     standalone tlv-vscode extension. Gated behind the
//     `tlverilog.experimentalFeatures` setting so it can be enabled for testing
//     and disabled for a shipped build. (Nav-TLV and the SandPiper-SaaS Diagram
//     were removed — Makerchip handles those; the SandPiper SaaS compile button
//     is retained in source but disabled, see experimental/index.ts.)
import * as vscode from 'vscode';
import { registerLanguageFeatures } from './languageFeatures';
import { activateExperimentalFeatures } from './experimental';

export function activate(context: vscode.ExtensionContext) {
  console.log('[TLV] activate() called — registering providers');

  registerLanguageFeatures(context);

  const experimentalEnabled = vscode.workspace
    .getConfiguration('tlverilog')
    .get<boolean>('experimentalFeatures', true);
  if (experimentalEnabled) {
    activateExperimentalFeatures(context);
  }
}

export function deactivate() {}
