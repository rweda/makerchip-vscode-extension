# @rweda/tlv-grammar

Platform-agnostic TL-Verilog TextMate grammar and language configuration, reusable across VS Code, Monaco, Shiki, GitHub Linguist,
and any other tool that accepts TextMate grammars.

> **Not on npm yet.** `@rweda/tlv-grammar` has never been published, so the
> consumption examples below describe how it is meant to be used once it is.
> Inside this monorepo the grammar is consumed by file copy, not by npm
> resolution. Release process:
> [monorepo README](../../README.md#releasing).

## Contents

| File | Purpose |
|------|---------|
| `tlverilog.tmLanguage` | TextMate grammar defining syntax scopes for `.tlv`/`.TLV` files |
| `language-configuration.json` | Bracket matching, auto-closing pairs, comment toggling |

Both are data files, not modules. Consumers resolve their *paths* and read them;
there is nothing to `import` directly.

## Usage

### In this monorepo: build-time copy

The `tl-verilog` VS Code extension does **not** resolve this package from
`node_modules`. `packages/tlv-extension/scripts/copy-grammar.mjs` copies both
files in by relative path at build time, and the copies are gitignored. Always
edit the sources here, never the copies under `tlv-extension/`.

### From npm

The package exposes both files through its `exports` map, so resolve them by
path:

```js
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const grammarPath = require.resolve('@rweda/tlv-grammar/tmLanguage');
const langConfigPath = require.resolve('@rweda/tlv-grammar/language-configuration');
```

### Shiki / other highlighting libraries

```js
const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
```

### GitHub Linguist

Reference the grammar file path directly from the installed package in your
Linguist configuration.

## Editing the grammar

Edit `tlverilog.tmLanguage` here. To see the change in the extension, rebuild
`tlv-extension` (or run `npm run copy-grammar` inside
`packages/tlv-extension/`).

Note that the grammar handles *lexical* scopes only. Most of the TL-Verilog
color scheme is applied on top of it by `tl-verilog`'s semantic token provider,
so a highlighting change may belong there rather than here.

### Notes for agents

- **The `@rweda/tlv-grammar` devDependency in `tlv-extension` resolves nothing.**
  The copy script reads `../tlv-grammar` by relative path, which is why the
  extension builds fine against a grammar that has never been published.
- **Publishing this package to npm ships nothing to VS Code users.** The files
  are copied in at build time, so a published extension carries a *snapshot*.
  Getting a grammar fix to editor users takes two releases — grammar first, then
  `tl-verilog`.
- **The first npm publish will likely have to be manual.** A trusted publisher
  is configured on a package that already exists, and this one does not yet. The
  sibling repo `@rweda/makerchip-view-client` published its 0.1.0 by hand for
  the same reason.
- `"publishConfig": {"access": "public"}` is set, so a scoped publish cannot
  silently land as restricted.

## Credits

Developed at Redwood EDA. The grammar originated in Dmytro Bogatov's TL-Verilog
VS Code extension and has since been extended — notably by Adam Ratzman and
Raj Aryan Singh — before being split out here as a standalone, editor-neutral
package.

The grammar and language configuration are derived, in part, from the
[SystemVerilog extension for VS Code](https://github.com/mshr-h/vscode-systemverilog-support)
(MIT, © 2016-2017 Masahiro H). The full third-party notice travels with the
grammar itself, in the header comment of
[`tlverilog.tmLanguage`](tlverilog.tmLanguage).

## License

[MIT](LICENSE) © Redwood EDA, LLC
