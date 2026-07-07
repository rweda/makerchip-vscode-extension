// TL-Verilog extension entry point (desktop / Node host).
//
// The activation is intentionally thin and layered:
//   - registerLanguageFeatures: web-safe language support (hover, semantic
//     tokens). This is the shared core and the intended web (browser) entry.
//   - registerModuleInstantiation: desktop-only module instantiation command.
//   - activateExperimentalFeatures: the SandPiper SaaS compile, Diagram,
//     Nav-TLV, and Waveform buttons, transferred from the standalone tlv-vscode
//     extension. Gated behind the `tlverilog.experimentalFeatures` setting so
//     they can be enabled for testing and disabled for a shipped build.
import * as vscode from 'vscode';
import { registerLanguageFeatures } from './languageFeatures';
import { registerModuleInstantiation } from './moduleInstantiation';
import { activateExperimentalFeatures } from './experimental';

export function activate(context: vscode.ExtensionContext) {
  console.log('[TLV] activate() called — registering providers');

  registerLanguageFeatures(context);
  registerModuleInstantiation(context);

  const experimentalEnabled = vscode.workspace
    .getConfiguration('tlverilog')
    .get<boolean>('experimentalFeatures', true);
  if (experimentalEnabled) {
    activateExperimentalFeatures(context);
  }
}

export function deactivate() {}
