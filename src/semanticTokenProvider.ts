import * as vscode from 'vscode';

export const tokenTypes = [
  'pipeSignal', 'svSignal', 'behavioralHierarchy', 'physicalHierarchy',
  'pipeline', 'when', 'stage', 'alignment', 'constant', 'attribute',
  'keyword', 'm4Macro', 'lineTypeChar', 'tab', 'comment',
  'm5MacroCall', 'm5Var', 'm5ArgSpecial', 'm5Comment', 'm5Directive', 'm5Special','string',
  'm5BlockDelimiter',    // [, {, [' , ], }, ']
  'm5Label'
];

export const tokenModifiers = ['physical', 'error'];

export const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

export class TLVerilogSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private isM4: boolean = false;
  private inQuote: boolean = false;
  private m5SubContext: 'none' | 'topLevel' | 'codeBlock' | 'textBlock' = 'none';
  
  // Track M5 string ranges to exclude from other parsing
  private m5StringRanges: Array<{ line: number; start: number; end: number }> = [];

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.SemanticTokens> {
    const builder = new vscode.SemanticTokensBuilder(legend);
    this.m5StringRanges = []; // Reset for each parse

    let context: 'tlv' | 'sv' | 'm5' | 'hdl-plus' | 'unknown' = 'unknown';
    this.inM5String = false;

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

      const m5Match = text.match(/^\s*(\\m5\b)/);
      if (m5Match) {
        const directive = m5Match[1];
        const startCol = m5Match[0].indexOf(directive);

        builder.push(
          new vscode.Range(i, startCol, i, startCol + directive.length),
          'm5Directive',
          []
        );

        context = 'm5';
        this.m5SubContext = 'topLevel';
        continue;
      }


      const tlvMatch = text.match(/^\s*(\\(TLV|TLVHDL|TLC)\b)/);
      if (tlvMatch) {
        const directive = tlvMatch[1];
        const startCol = tlvMatch[0].indexOf(directive);

        builder.push(
          new vscode.Range(i, startCol, i, startCol + directive.length),
          'keyword',
          []
        );

        context = 'tlv';
        this.m5SubContext = 'none';
        continue;
      }

      const svMatch = text.match(/^\s*(\\[A-Z]+(_plus)?\b)/);
      if (svMatch) {
        const directive = svMatch[1];
        const startCol = svMatch[0].indexOf(directive);

        builder.push(
          new vscode.Range(i, startCol, i, startCol + directive.length),
          'keyword',
          []
        );

        context = directive.includes('_plus') ? 'hdl-plus' : 'sv';
        this.m5SubContext = 'none';
        continue;
      }

      // ── Common checks ─────────────────────────────────────────────────────
      if (text.includes('\t')) {
        const tabPos = text.indexOf('\t');
        builder.push(new vscode.Range(i, tabPos, i, tabPos + 1), 'tab', ['error']);
      }

// Parse M5 quoted strings FIRST ──
      this.highlightM5QuotedStrings(builder, i, text);


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
        if (this.m5SubContext === 'textBlock' && trimmedStart.startsWith("']")) {
          const closerStart = text.indexOf("']");
          if (closerStart >= 0) {
            builder.push(
              new vscode.Range(i, closerStart, i, closerStart + 2),
              'm5BlockDelimiter',
              []
            );
          }
          this.m5SubContext = 'topLevel';
        }
        else if (this.m5SubContext === 'codeBlock') {
          if (trimmedStart.startsWith(']') && !trimmedStart.startsWith("']")) {
            const pos = text.indexOf(']');
            if (pos >= 0) {
              builder.push(new vscode.Range(i, pos, i, pos + 1), 'm5BlockDelimiter', []);
            }
            this.m5SubContext = 'topLevel';
            continue;
          }
          if (trimmedStart.startsWith('}')) {
            const pos = text.indexOf('}');
            if (pos >= 0) {
              builder.push(new vscode.Range(i, pos, i, pos + 1), 'm5BlockDelimiter', []);
            }
            this.m5SubContext = 'topLevel';
            continue;
          }
        }

        const openerMatch = trimmedEnd.match(/(\*)?(<[a-zA-Z_][a-zA-Z0-9_]*>)?((?:\[')|[{[])\s*$/);
        if (openerMatch) {
          const evalMarker = openerMatch[1];
          const label      = openerMatch[2];
          const opener     = openerMatch[3];

          const openerCol = text.lastIndexOf(opener);
          if (openerCol >= 0) {
            // Highlight the opening character(s)
            builder.push(
              new vscode.Range(i, openerCol, i, openerCol + opener.length),
              'm5BlockDelimiter',
              []
            );

            if (label) {
              const labelStart = text.lastIndexOf(label, openerCol);
              if (labelStart >= 0) {
                builder.push(
                  new vscode.Range(i, labelStart, i, labelStart + label.length),
                  'm5Label',
                  []
                );
              }
            }

            if (evalMarker) {
              const evalStart = label
                ? text.lastIndexOf('*', text.lastIndexOf(label))
                : text.lastIndexOf('*', openerCol);
              if (evalStart >= 0) {
                builder.push(
                  new vscode.Range(i, evalStart, i, evalStart + 1),
                  'm5Special',
                  []
                );
              }
            }
          }

          this.m5SubContext = opener === "['" ? 'textBlock' : 'codeBlock';
        }

        if (this.m5SubContext !== 'textBlock') {
          this.parseM5Line(builder, i, text, trimmedStart);
        }
      }

      // Global parsing
      this.parseComments(builder, i, text);
      this.parseGlobalM5Patterns(builder, i, text);
      if (this.isM4) {
        this.matchPattern(builder, i, text, /\b[mM]4[+_][a-zA-Z0-9_]+\b/g, 'm4Macro');
      }
    }

    return builder.build();
  }

  // ── Helper to check if position is inside M5 string ──
  private isInsideM5String(line: number, pos: number): boolean {
    return this.m5StringRanges.some(
      range => range.line === line && pos >= range.start && pos < range.end
    );
  }
  private inM5String: boolean = false;

  private highlightM5QuotedStrings(
  builder: vscode.SemanticTokensBuilder,
  lineIdx: number,
  text: string
): void {
  // If we're continuing a multi-line string, look for the closing ']
  if (this.inM5String) {
    const closeIdx = text.indexOf("']");
    if (closeIdx >= 0) {
      // Highlight everything up to and including '] as string/delimiter
      if (closeIdx > 0) {
        builder.push(new vscode.Range(lineIdx, 0, lineIdx, closeIdx), 'string', []);
        this.m5StringRanges.push({ line: lineIdx, start: 0, end: closeIdx + 2 });
      }
      builder.push(new vscode.Range(lineIdx, closeIdx, lineIdx, closeIdx + 2), 'm5BlockDelimiter', []);
      this.m5StringRanges.push({ line: lineIdx, start: 0, end: closeIdx + 2 });
      this.inM5String = false;
      return;
    } else {
      // Entire line is string content
      builder.push(new vscode.Range(lineIdx, 0, lineIdx, text.length), 'string', []);
      this.m5StringRanges.push({ line: lineIdx, start: 0, end: text.length });
      return;
    }
  }
  let pos = 0;
  while (pos < text.length - 1) {
    if (text[pos] === '[' && text[pos + 1] === "'") {
      const openPos = pos;
      pos += 2;
      const contentStart = pos;
      let depth = 1;

      while (pos < text.length - 1 && depth > 0) {
        if (text[pos] === '[' && text[pos + 1] === "'") { depth++; pos += 2; }
        else if (text[pos] === "'" && text[pos + 1] === ']') {
          depth--;
          if (depth === 0) {
            const closePos = pos; pos += 2;
            this.m5StringRanges.push({ line: lineIdx, start: openPos, end: pos });
            builder.push(new vscode.Range(lineIdx, openPos, lineIdx, openPos + 2), 'm5BlockDelimiter', []);
            builder.push(new vscode.Range(lineIdx, closePos, lineIdx, closePos + 2), 'm5BlockDelimiter', []);
            if (contentStart < closePos)
              builder.push(new vscode.Range(lineIdx, contentStart, lineIdx, closePos), 'string', []);
            break;
          } else { pos += 2; }
        } else { pos++; }
      }

      if (depth > 0) {
  builder.push(new vscode.Range(lineIdx, openPos, lineIdx, openPos + 2), 'm5BlockDelimiter', []);
  builder.push(new vscode.Range(lineIdx, contentStart, lineIdx, text.length), 'string', []);
  this.m5StringRanges.push({ line: lineIdx, start: openPos, end: text.length });
  this.inM5String = true;

  // Still highlight any macro name that precedes the ['
  const beforeOpener = text.slice(0, openPos).trimStart();
  const macroMatch = beforeOpener.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
  if (macroMatch) {
    const macroName = macroMatch[1];
    const macroStart = text.indexOf(macroName);
    builder.push(
      new vscode.Range(lineIdx, macroStart, lineIdx, macroStart + macroName.length),
      'm5MacroCall',
      []
    );
  }

  return;
}} else { pos++; }
    }
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
    if (this.inM5String) return;
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
    if (implicitMatch) {
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
    this.matchPattern(builder, lineIdx, text, /\$(?:[@#*\d]|<\w+>[@#*\d])/g, 'm5ArgSpecial');  
    // Highlight M5 quoted strings ['...'] - but NOT Verilog literals
    this.highlightM5QuotedStrings(builder, lineIdx, text);
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
      const end = start + match[0].length;
      // Skip if this match is inside an M5 quoted string
      if (!this.isInsideM5String(line, start)) {
        builder.push(new vscode.Range(line, start, line, end), tokenType, modifiers);
      }
    }
  }}