// Shared helper for the experimental status-bar buttons.
import * as vscode from 'vscode';

export interface TlvStatusButtonOptions {
  text: string;
  tooltip: string;
  command: string;
  priority: number;
  /** If true, the button is always shown; otherwise only for tlverilog editors. */
  alwaysVisible?: boolean;
}

/**
 * Create a left-aligned status-bar button. Unless `alwaysVisible` is set, the
 * button is shown only while the active editor is a TL-Verilog document. The
 * button and its visibility listener are registered on `context.subscriptions`.
 */
export function createTlvStatusButton(
  context: vscode.ExtensionContext,
  opts: TlvStatusButtonOptions
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, opts.priority);
  item.text = opts.text;
  item.tooltip = opts.tooltip;
  item.command = opts.command;
  context.subscriptions.push(item);

  if (opts.alwaysVisible) {
    item.show();
    return item;
  }

  const update = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'tlverilog') {
      item.show();
    } else {
      item.hide();
    }
  };
  update();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update));
  return item;
}
