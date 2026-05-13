/**
 * Centralized logging for the Makerchip extension
 * 
 * Provides a shared output channel that can be used across all extension modules
 * for debugging and diagnostic information.
 */

import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Log a message to the Makerchip extension output channel.
 * Creates the output channel on first use.
 * 
 * @param message The main log message
 * @param args Additional arguments to log (will be stringified)
 */
export function log(message: string, ...args: any[]) {
  const channel = getOutputChannel();
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const formattedArgs = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  const fullMessage = `[${timestamp}] ${message} ${formattedArgs}`.trim();
  channel.appendLine(fullMessage);
  console.log(fullMessage);
}

/**
 * Show the output channel to the user
 */
export function showOutputChannel() {
  getOutputChannel().show(true);
}

/**
 * Get the output channel instance (creates if needed)
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Makerchip');
  }
  return outputChannel;
}
