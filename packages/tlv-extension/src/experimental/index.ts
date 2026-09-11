// Experimental TL-Verilog features (Waveform only). These are Node-only and
// call external services / local tools.
//
// They are transferred here from the standalone tlv-vscode extension and kept
// isolated from the web-safe language core. Activation is gated by the
// `tlverilog.experimentalFeatures` setting (see extension.ts) so they can be
// enabled for testing and disabled for a shipped build without code changes.
//
// Nav-TLV and the SandPiper-SaaS Diagram (SVG) buttons were removed: Makerchip
// handles Nav-TLV and diagram viewing. The SandPiper SaaS compile button is
// retained in source but disabled for the initial deployment (compiling outside
// Makerchip may return later); re-enable by restoring the import and call below.
import * as vscode from 'vscode';
// import { registerSandpiperCompile } from './sandpiperCompile';
import { registerWaveform } from './waveform';

export function activateExperimentalFeatures(context: vscode.ExtensionContext): void {
  // registerSandpiperCompile(context); // disabled: not part of initial deployment
  registerWaveform(context);
}
