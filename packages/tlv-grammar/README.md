# @rweda/tlv-grammar

Platform-agnostic TL-Verilog TextMate grammar and language configuration.
This is the **single source of truth** (next to the spec and SandPiper
parsing) for TL-Verilog syntax — reusable across VS Code,
Monaco, Shiki, GitHub Linguist, and any other tool that accepts TextMate grammars.

## Contents

| File | Purpose |
|------|---------|
| `tlverilog.tmLanguage` | TextMate grammar defining syntax scopes for `.tlv`/`.TLV` files |
| `language-configuration.json` | Bracket matching, auto-closing pairs, comment toggling |

## Usage

### VS Code extension (via build-time copy)

The `tl-verilog` VS Code extension copies these files at build time via
`packages/tlv-extension/scripts/copy-grammar.mjs`. The copies are gitignored — always edit
the source here, never in `tlv-extension/`.

```js
import grammarPath from '@rweda/tlv-grammar/tmLanguage';
import langConfigPath from '@rweda/tlv-grammar/language-configuration';
```

### Shiki / other highlighting libraries

```js
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grammar = JSON.parse(readFileSync(require.resolve('@rweda/tlv-grammar/tmLanguage'), 'utf8'));
```

### GitHub Linguist

Reference the grammar file path directly from the npm package in your Linguist configuration.

## Editing the grammar

Edit `tlverilog.tmLanguage` in this directory. After editing, rebuild `tlv-extension` (or run
`npm run copy-grammar` inside `packages/tlv-extension/`) to propagate the change.
