import * as vscode from 'vscode';

/**
 * Chat participant that allows users to invoke Makerchip via @makerchip.
 * Honestly, this isn't so important. The Makerchip Tool is more valuable.
 */
export function registerMakerchipParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant('makerchip', async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    // Parse the request
    const prompt = request.prompt.toLowerCase();
    
    if (prompt.includes('run') || prompt.includes('compile') || prompt.includes('simulate') || prompt.includes('open') || prompt.includes('launch')) {
      // Execute the Makerchip compile command
      stream.progress('Launching Makerchip IDE...');
      
      try {
        await vscode.commands.executeCommand('makerchip.compile');
        
        stream.markdown('✅ **Makerchip IDE launched successfully!**\n\n');
        stream.markdown('The Makerchip panel should now be visible beside your editor showing:\n');
        stream.markdown('- Compiled circuit diagram\n');
        stream.markdown('- Waveform viewer\n');
        stream.markdown('- Visual Debug output\n');
        
        return { metadata: { command: 'makerchip.compile' } };
      } catch (error: any) {
        stream.markdown(`❌ Failed to launch Makerchip: ${error.message}`);
        return { metadata: { command: 'makerchip.compile', error: error.message } };
      }
    } else if (prompt.includes('help') || prompt === '') {
      stream.markdown('## Makerchip IDE Integration\n\n');
      stream.markdown('I can help you with TL-Verilog development using Makerchip.\n\n');
      stream.markdown('**Available commands:**\n');
      stream.markdown('- `@makerchip compile` - Compile and simulate the current TL-Verilog file\n');
      stream.markdown('- `@makerchip compile` - Same as run\n');
      stream.markdown('- `@makerchip help` - Show this help message\n\n');
      stream.markdown('You can also use the keyboard shortcut **Ctrl+Shift+Enter** to quickly compile the current file.');
      
      return { metadata: { command: 'help' } };
    } else {
      stream.markdown(`I'm not sure how to help with that. Try:\n`);
      stream.markdown('- `@makerchip compile` to compile and simulate your TL-Verilog file\n');
      stream.markdown('- `@makerchip help` for more information');
      
      return { metadata: { command: 'unknown' } };
    }
  });

  participant.iconPath = vscode.Uri.file(context.asAbsolutePath('resources/icon.png'));
  
  context.subscriptions.push(participant);
  console.log('Makerchip chat participant registered successfully');
}
