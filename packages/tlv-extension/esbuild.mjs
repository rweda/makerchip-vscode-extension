// esbuild bundling for the TL-Verilog web (browser) extension entry.
//
// The desktop build uses tsc (see the "compile" script and `main`), which is
// fine for the Node extension host. The web extension host runs in a Web Worker
// and needs a single bundled file with no bare Node built-ins, so we bundle the
// browser entry with esbuild here (see `browser` in package.json).
//
// Usage:
//   node esbuild.mjs            # one-off build
//   node esbuild.mjs --watch    # rebuild on change
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/browser.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/web/extension.js',
    // `vscode` is provided by the host, not bundled.
    external: ['vscode'],
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching web build...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
