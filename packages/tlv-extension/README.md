# TL-Verilog for VS Code

Language support for [TL-Verilog](https://www.redwoodeda.com/tl-verilog) —
syntax highlighting and semantic highlighting for `.tlv` / `.TLV`
files.

Works in desktop VS Code and in the browser (vscode.dev, github.dev). It is
fully offline and standalone: no Makerchip server and no network required.

> **Want the full Makerchip IDE?** Install the
> [**Makerchip**](https://marketplace.visualstudio.com/items?itemName=RedwoodEDA.makerchip)
> extension instead — it adds compile and simulate, circuit diagrams, waveforms
> and GitHub Copilot integration, and it **installs this extension
> automatically**. You don't need both; installing Makerchip gets you everything
> here as well.

Install this extension on its own if you only want TL-Verilog language support:
editing `.tlv` files with no Makerchip server and no network.

## Features

- **Syntax highlighting** for `.tlv` / `.TLV`, from the shared
  [`@rweda/tlv-grammar`](https://github.com/rweda/makerchip-vscode-extension/tree/main/packages/tlv-grammar) TextMate grammar.
- **Semantic highlighting** — TL-Verilog-aware token classification layered over
  the grammar. Toggle with `tlverilog.semanticHighlighting.enabled`.
- **The standard TL-Verilog color scheme, in any theme.** Pipe signals,
  hierarchy, pipelines, stages, `when` conditions, alignment operators, M4/M5
  macros and so on get their canonical colors. This is implemented with custom
  semantic token types plus default color rules, not with a contributed color
  theme, so it layers onto whichever theme you already use — with a dark-theme
  variant applied automatically. No theme switching required.
- **Web support** — the browser entry point is bundled separately with esbuild,
  so the language features work in web hosts.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `tlverilog.semanticHighlighting.enabled` | `true` | Enable semantic highlighting |
| `tlverilog.experimentalFeatures` | `false` | Show the experimental Waveform toolbar button |

## Credits

Thanks to the Redwood developers:

- Dmytro Bogatov: published the initial TL-Verilog gramar and themes (extending the
[SystemVerilog extension](https://github.com/mshr-h/vscode-systemverilog-support))
- Adam Ratzman: grammar
- Raj Aryan Singh: semantic highlighting and the token provider

Now maintained by Redwood EDA in the
[makerchip-vscode-extension](https://github.com/rweda/makerchip-vscode-extension)
monorepo.

## Contributing

Development setup, architecture notes and the release process are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Redwood EDA, LLC
