// TL-Verilog extension entry point for the VS Code Web (browser) host.
//
// The web extension host runs in a Web Worker with no Node.js APIs (no fs,
// child_process, path, os). Only the web-safe language features are available
// here. Module instantiation and the experimental SandPiper/Diagram/Nav-TLV/
// Waveform buttons are desktop-only and intentionally excluded — see
// extension.ts for the full Node activation.
import * as vscode from 'vscode';
import { registerLanguageFeatures } from './languageFeatures';

export function activate(context: vscode.ExtensionContext) {
  console.log('[TLV] web activate() called — registering language features');
  registerLanguageFeatures(context);
}

export function deactivate() {}
