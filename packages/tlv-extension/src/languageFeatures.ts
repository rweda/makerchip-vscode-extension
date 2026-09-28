// Web-safe TL-Verilog language features.
//
// This module intentionally has NO Node-only imports (no fs / child_process /
// path / axios). It is the shared core used by the desktop entry point today
// and is the intended entry point for a future web (browser) build. Keep it
// free of anything that cannot run in a VS Code web extension host.
import * as vscode from 'vscode';
import { TLVerilogSemanticTokensProvider, legend } from './semanticTokenProvider';

/**
 * Register the language features that work in every VS Code host (desktop and
 * web): semantic tokens and the semantic-token debug command.
 */
export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  // Semantic tokens
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'tlverilog' },
      new TLVerilogSemanticTokensProvider(),
      legend
    )
  );

  // Debug helper
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.tlverilog.showSemanticTokens', () => {
      vscode.window.showInformationMessage(
        'Check the "TL-Verilog Semantic Tokens" output channel for debug info'
      );
    })
  );
}
