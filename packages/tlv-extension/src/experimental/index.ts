// Experimental TL-Verilog features (SandPiper SaaS compile, Diagram, Nav-TLV,
// Waveform). These are Node-only and call external services / local tools.
//
// They are transferred here from the standalone tlv-vscode extension and kept
// isolated from the web-safe language core. Activation is gated by the
// `tlverilog.experimentalFeatures` setting (see extension.ts) so they can be
// enabled for testing and disabled for a shipped build without code changes.
import * as vscode from 'vscode';
import { registerSandpiperCompile } from './sandpiperCompile';
import { registerDiagram } from './diagram';
import { registerNavTlv } from './navTlv';
import { registerWaveform } from './waveform';

export function activateExperimentalFeatures(context: vscode.ExtensionContext): void {
  registerSandpiperCompile(context);
  registerDiagram(context);
  registerNavTlv(context);
  registerWaveform(context);
}
