// Copies the shared TL-Verilog grammar assets from the @rweda/tlv-grammar package
// into this extension's expected paths at build time. The copied files are generated
// (gitignored); the single source of truth lives in packages/tlv-grammar.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const grammarRoot = resolve(extRoot, '..', 'tlv-grammar');

const copies = [
  ['tlverilog.tmLanguage', 'syntaxes/tlverilog.tmLanguage'],
  ['language-configuration.json', 'language-configuration.json'],
];

for (const [src, dst] of copies) {
  const from = resolve(grammarRoot, src);
  const to = resolve(extRoot, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[copy-grammar] ${src} -> ${dst}`);
}
