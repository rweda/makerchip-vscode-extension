import * as vscode from 'vscode';

// Define the token types according to TL-Verilog spec
export const tokenTypes = [
    'pipeSignal',           // $.*
    'svSignal',             // *.*
    'behavioralHierarchy',  // >.* or /.*
    'physicalHierarchy',    // -.*
    'pipeline',             // |.*
    'when',                 // ?.*
    'stage',                // @.*
    'alignment',            // <<, >>, <>, etc.
    'constant',             // #\w+
    'attribute',            // ^.*
    'keyword',              // \.*
    'm4Macro',              // m4+.* or M4_.*
    'lineTypeChar',         // First character of line (!, ?, etc.)
    'tab',                  // Tabs (should be highlighted as errors)
    'comment'               // HDL-style comments
];

export const tokenModifiers = [
    'physical',     // For physical/italic elements
    'error'         // For tabs and error conditions
];

export const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

interface Region {
    startLine: number;
    endLine?: number;  // Computed later
    type: 'tlx' | 'hdl_sv' | 'hdl_vhdl' | 'hdl_c' | 'hdl_plus_sv' | 'hdl_plus_vhdl' | 'hdl_plus_c' | 'codegen_m5' | 'm4';
}

export class TLVerilogSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private isM4: boolean = false;

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.SemanticTokens> {
        const tokensBuilder = new vscode.SemanticTokensBuilder(legend);
        
        let inTLVRegion = false;
        let inHDLPlusRegion = false;
        
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;

            // Handle file format line (first line)
            if (i === 0) {
                const versionMatch = text.match(/^\\(m4_)?TLV_version/);
                if (versionMatch) {
                    this.highlightKeyword(tokensBuilder, i, text, /^\\(m4_)?TLV_version/);
                    this.isM4 = !!versionMatch[1];
                    continue;
                }
            }
            
            // Check for region markers (assuming no leading indentation for region starts)
            if (text.match(/^\\(TLV|TLVHDL|TLC)/)) {
                this.highlightKeyword(tokensBuilder, i, text, /^\\(TLV|TLVHDL|TLC)/);
                inTLVRegion = true;
                inHDLPlusRegion = false;
                // this.highlightKeyword(tokensBuilder, i, text, /^\\(TLV|TLVHDL|TLC)/);
                continue;
            } else if (text.match(/^\\(SV|VHDL|C)_plus/)) {
                this.highlightKeyword(tokensBuilder, i, text, /^\\(SV|VHDL|C)_plus/);
                inHDLPlusRegion = true;
                inTLVRegion = false;
                // this.highlightKeyword(tokensBuilder, i, text, /^\\(SV|VHDL|C)_plus/);
                continue;
            } else if (text.match(/^\\(SV|VHDL|C|M5)/)) {
                this.highlightKeyword(tokensBuilder, i, text, /^\\(SV|VHDL|C|M5)/);
                inTLVRegion = false;
                inHDLPlusRegion = false;
                continue;
            }
            
            // Only process TLV and HDL_plus regions
            if (!inTLVRegion && !inHDLPlusRegion) {
                continue;
            }
            
            // Check for tabs (error highlighting)
            if (text.includes('\t')) {
                const tabIndex = text.indexOf('\t');
                tokensBuilder.push(
                    new vscode.Range(i, tabIndex, i, tabIndex + 1),
                    'tab',
                    ['error']
                );
            }
            
            // Line type character (first non-space character in TLV region)
            if (inTLVRegion && text.length > 0) {
                const firstChar = text[0];
                if (firstChar !== ' ' && firstChar !== '\\') {
                    tokensBuilder.push(
                        new vscode.Range(i, 0, i, 1),
                        'lineTypeChar',
                        firstChar.match(/[!?\|@#]/) ? [] : ['error']
                    );
                }
            }
            
            // Parse comments first
            this.parseComments(tokensBuilder, i, text);
            
            // Parse identifiers and other tokens (note: to avoid overlap with comments, more logic could be added, but for simplicity assuming no identifiers in comments for now)
            this.parseIdentifiers(tokensBuilder, i, text);
        }
        
        return tokensBuilder.build();
    }
    
    private highlightKeyword(
        builder: vscode.SemanticTokensBuilder,
        line: number,
        text: string,
        pattern: RegExp
    ) {
        const match = text.match(pattern);
        if (match) {
            builder.push(
                new vscode.Range(line, 0, line, match[0].length),
                'keyword',
                []
            );
        }
    }
    
    private parseComments(
        builder: vscode.SemanticTokensBuilder,
        line: number,
        text: string
    ) {
        // Handle line comments (//)
        const lineCommentPattern = /\/\/.*$/g;
        let match;
        while ((match = lineCommentPattern.exec(text)) !== null) {
            const startChar = match.index;
            const length = match[0].length;
            builder.push(
                new vscode.Range(line, startChar, line, startChar + length),
                'comment',
                []
            );
        }

        // Handle block comments on single line (/* */)
        const blockCommentPattern = /\/\*.*?\*\//g;
        while ((match = blockCommentPattern.exec(text)) !== null) {
            const startChar = match.index;
            const length = match[0].length;
            builder.push(
                new vscode.Range(line, startChar, line, startChar + length),
                'comment',
                []
            );
        }
        // Note: Multi-line block comments require state tracking across lines, which is not implemented here.
    }
    
    private parseIdentifiers(
        builder: vscode.SemanticTokensBuilder,
        line: number,
        text: string
    ) {

        // When: ? or ?*
        this.matchPattern(builder, line, text, /\?[\$\*][a-zA-Z0-9_]+/g, 'when');
    
        // Pipe signal: $.*
        this.matchPattern(builder, line, text, /\$\$?[a-zA-Z0-9_]+/g, 'pipeSignal');
    
        // SV signal: *.*
        this.matchPattern(builder, line, text, /\*\*?[a-zA-Z0-9_]+/g, 'svSignal');
        
        // Behavioral hierarchy: >.* or /.*
        this.matchPattern(builder, line, text, /[>\/][a-zA-Z0-9_]+/g, 'behavioralHierarchy');
        
        // Physical hierarchy: -.* or ->.*
        this.matchPattern(builder, line, text, /->?[a-zA-Z0-9_]+/g, 'physicalHierarchy', ['physical']);
        
        // Pipeline: |.*
        this.matchPattern(builder, line, text, /\|[a-zA-Z0-9_]+/g, 'pipeline');
        
        // Stage: @\d+ or @-\d+
        this.matchPattern(builder, line, text, /@-?\d+/g, 'stage', ['physical']);
        
        // Alignment: <<, >>, <>, >>-
        this.matchPattern(builder, line, text, /(<<|>>-?|<>)(\d+|\w+)/g, 'alignment');
        
        // Constant: #\w+
        this.matchPattern(builder, line, text, /#[a-zA-Z0-9_]+/g, 'constant');
        
        // Attributes: ^.* or ^^.*
        this.matchPattern(builder, line, text, /\^\^?[a-zA-Z0-9_]+/g, 'attribute', ['physical']);
        
        // Keywords: \.*
        this.matchPattern(builder, line, text, /\\[a-zA-Z0-9_]+/g, 'keyword');
        
        // M4 macros: m4+.* or M4_.* (only if isM4)
        if (this.isM4) {
            this.matchPattern(builder, line, text, /\b[mM]4[+_][a-zA-Z0-9_]+/g, 'm4Macro');
        }
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
            const startChar = match.index;
            const length = match[0].length;
            builder.push(
                new vscode.Range(line, startChar, line, startChar + length),
                tokenType,
                modifiers
            );
        }
    }
}