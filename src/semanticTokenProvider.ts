import * as vscode from 'vscode';

export const tokenTypes = [
  'pipeSignal', 'svSignal', 'behavioralHierarchy', 'physicalHierarchy',
  'pipeline', 'when', 'stage', 'alignment', 'constant', 'attribute',
  'keyword', 'm4Macro', 'lineTypeChar', 'tab', 'comment',
  'm5MacroCall', 'm5Var', 'm5ArgSpecial', 'm5Comment', 'm5Directive', 'm5Special',
  'm5BlockDelimiter',    // [, {, [' , ], }, ']
  'm5Label'              // *something before block opener
];

export const tokenModifiers = ['physical', 'error'];

export const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

export class TLVerilogSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private isM4: boolean = false;

  // Track M5 sub-context (top-level \m5 vs inside code/text block)
  private m5SubContext: 'none' | 'topLevel' | 'codeBlock' | 'textBlock' = 'none';

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.SemanticTokens> {
    const builder = new vscode.SemanticTokensBuilder(legend);

    let context: 'tlv' | 'sv' | 'm5' | 'hdl-plus' | 'unknown' = 'unknown';

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;
      const trimmedStart = text.trimStart();
      const trimmedEnd = text.trimEnd();

      // ── Region / context switches ───
      if (i === 0 && text.match(/^\\(m4_)?TLV_version/)) {
        this.highlightKeyword(builder, i, text, /^\\(m4_)?TLV_version/, 'keyword');
        this.isM4 = !!text.match(/^\\m4_TLV_version/);
        context = 'tlv';
        this.m5SubContext = 'none';
        continue;
      }

      if (trimmedStart.startsWith('\\m5')) {
        this.highlightKeyword(builder, i, text, /^\\m5\b/, 'm5Directive');
        context = 'm5';
        this.m5SubContext = 'topLevel';
        continue;
      }

      if (trimmedStart.startsWith('\\TLV') || trimmedStart.startsWith('\\TLVHDL') || trimmedStart.startsWith('\\TLC')) {
        this.highlightKeyword(builder, i, text, /^\\[A-Z]+/, 'keyword');
        context = 'tlv';
        this.m5SubContext = 'none';
        continue;
      }

      if (trimmedStart.startsWith('\\SV') || trimmedStart.startsWith('\\VHDL') || trimmedStart.startsWith('\\C')) {
        this.highlightKeyword(builder, i, text, /^\\[A-Z]+(_plus)?\b/, 'keyword');
        context = trimmedStart.includes('_plus') ? 'hdl-plus' : 'sv';
        this.m5SubContext = 'none';
        continue;
      }

      // ── Common checks ─────────────────────────────────────────────────────
      if (text.includes('\t')) {
        const tabPos = text.indexOf('\t');
        builder.push(new vscode.Range(i, tabPos, i, tabPos + 1), 'tab', ['error']);
      }

      // ── Context-specific parsing ──────────────────────────────────────────
      if (context === 'tlv') {
        // TL-Verilog line type chars
        if (text.length > 0 && !text.startsWith(' ')) {
          const firstChar = text[0];
          if ('!?|@#'.includes(firstChar)) {
            builder.push(new vscode.Range(i, 0, i, 1), 'lineTypeChar', []);
          } else if (firstChar !== '\\') {
            builder.push(new vscode.Range(i, 0, i, 1), 'lineTypeChar', ['error']);
          }
        }
        this.parseTLVerilogTokens(builder, i, text);
      }

      if (context === 'm5') {
        // ── Detect M5 block openers ───────────────────────────────────────
        const openerMatch = trimmedEnd.match(/(\*<(?:[a-zA-Z_][a-zA-Z0-9_]*)?>)?(['[{])$/);
        if (openerMatch) {
          const prefix = openerMatch[1] || '';
          // const prefix = openerMatch[1] || '';  // e.g. "*<my_label>" or ""
          if (prefix) {
            const prefixStart = text.lastIndexOf(prefix);  // find where "*<...>" starts
            if (prefixStart >= 0) {
              builder.push(
                new vscode.Range(i, prefixStart, i, prefixStart + prefix.length),
                'm5Label',
                []
              );
            }
          }
          const opener = openerMatch[2];

          const openerCol = text.lastIndexOf(opener);
          if (openerCol >= 0) {
            // Highlight the opening character(s)
            builder.push(
              new vscode.Range(i, openerCol, i, openerCol + opener.length),
              'm5BlockDelimiter',
              []
            );

            // Highlight optional *label
            if (prefix.trim().startsWith('*')) {
              const labelStart = text.indexOf('*');
              if (labelStart >= 0 && labelStart < openerCol) {
                builder.push(
                  new vscode.Range(i, labelStart, i, openerCol),
                  'm5Label',
                  []
                );
              }
            }
          }

          // Update sub-context
          this.m5SubContext = opener === "['" ? 'textBlock' : 'codeBlock';
          // Could record indent here later if needed
        }

        // Highlight closing delimiters anywhere on the line (simple)
        this.matchPattern(builder, i, text, /['\]}]/g, 'm5BlockDelimiter');

        // ── Parse M5 line content only when allowed ───────────────────────
        if (this.m5SubContext !== 'textBlock') {
          this.parseM5Line(builder, i, text, trimmedStart);
        }
        // In textBlock → skip sugar / comments / implicit calls
      }

      // ── Global parsing (appears anywhere) ─────────────────────────────────
      this.parseComments(builder, i, text);
      this.parseGlobalM5Patterns(builder, i, text);
      if (this.isM4) {
        this.matchPattern(builder, i, text, /\b[mM]4[+_][a-zA-Z0-9_]+\b/g, 'm4Macro');
      }
    }

    return builder.build();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private highlightKeyword(
    builder: vscode.SemanticTokensBuilder,
    line: number,
    text: string,
    pattern: RegExp,
    tokenType: string = 'keyword'
  ) {
    const match = text.match(pattern);
    if (match) {
      builder.push(new vscode.Range(line, 0, line, match[0].length), tokenType, []);
    }
  }

  private parseComments(builder: vscode.SemanticTokensBuilder, line: number, text: string) {
    const lineCommentRe = /\/\/.*$/g;
    let m;
    while ((m = lineCommentRe.exec(text))) {
      builder.push(new vscode.Range(line, m.index, line, m.index + m[0].length), 'comment', []);
    }

    const blockRe = /\/\*.*?\*\//g;
    while ((m = blockRe.exec(text))) {
      builder.push(new vscode.Range(line, m.index, line, m.index + m[0].length), 'comment', []);
    }
  }

  private parseM5Line(
    builder: vscode.SemanticTokensBuilder,
    lineIdx: number,
    text: string,
    trimmed: string
  ) {
    // Single-slash line comment
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      const slashPos = text.indexOf('/');
      builder.push(new vscode.Range(lineIdx, slashPos, lineIdx, text.length), 'm5Comment', []);
      return;
    }

    // ~ special marker
    if (trimmed.startsWith('~')) {
      const tildePos = text.indexOf('~');
      builder.push(new vscode.Range(lineIdx, tildePos, lineIdx, tildePos + 1), 'm5Special', []);
    }

    // Implicit macro: word at line start
    const implicitMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\b/);
    if (implicitMatch && !trimmed.startsWith('use(')) {
      const word = implicitMatch[1];
      const start = text.indexOf(word);
      builder.push(new vscode.Range(lineIdx, start, lineIdx, start + word.length), 'm5MacroCall', []);
    }

    // Bare parentheses at line start
    if (trimmed.startsWith('(')) {
      const parenPos = text.indexOf('(');
      builder.push(new vscode.Range(lineIdx, parenPos, lineIdx, parenPos + 1), 'm5MacroCall', []);
    }

    // Special M5 parameters
    this.matchPattern(builder, lineIdx, text, /\$[@#*]|\$\d+|\$<\w+>[a-zA-Z0-9_]?/g, 'm5ArgSpecial');
  }

  private parseGlobalM5Patterns(builder: vscode.SemanticTokensBuilder, line: number, text: string) {
    this.matchPattern(builder, line, text, /\bm5([_+][a-zA-Z_][a-zA-Z0-9_]*|\b_makerchip_module)\b(?!\s*\()/g, 'm5Var');
    this.matchPattern(builder, line, text, /\bm5([_+][a-zA-Z_][a-zA-Z0-9_]*|\b_makerchip_module)\b\s*\(/g, 'm5MacroCall');
    this.matchPattern(builder, line, text, /\$[@#*]|\$\d+|\$<\w+>/g, 'm5Special');
  }

  private parseTLVerilogTokens(builder: vscode.SemanticTokensBuilder, line: number, text: string) {
    this.matchPattern(builder, line, text, /\$\$?[a-zA-Z0-9_]+/g, 'pipeSignal');
    this.matchPattern(builder, line, text, /\*\*?[a-zA-Z0-9_]+/g, 'svSignal');
    this.matchPattern(builder, line, text, /[>\/][a-zA-Z0-9_]+/g, 'behavioralHierarchy');
    this.matchPattern(builder, line, text, /->?[a-zA-Z0-9_]+/g, 'physicalHierarchy', ['physical']);
    this.matchPattern(builder, line, text, /\|[a-zA-Z0-9_]+/g, 'pipeline');
    this.matchPattern(builder, line, text, /@-?\d+/g, 'stage', ['physical']);
    this.matchPattern(builder, line, text, /(<<|>>-?|<>)(\d+|\w+)/g, 'alignment');
    this.matchPattern(builder, line, text, /#[a-zA-Z0-9_]+/g, 'constant');
    this.matchPattern(builder, line, text, /\^\^?[a-zA-Z0-9_]+/g, 'attribute', ['physical']);
    this.matchPattern(builder, line, text, /\?[$\*][a-zA-Z0-9_]+/g, 'when');
  }

  private matchPattern(
    builder: vscode.SemanticTokensBuilder,
    line: number,
    text: string,
    pattern: RegExp,
    tokenType: string,
    modifiers: string[] = []
  ) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      builder.push(new vscode.Range(line, start, line, start + match[0].length), tokenType, modifiers);
    }
  }
}