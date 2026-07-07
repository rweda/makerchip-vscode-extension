# Makerchip Compilation Cache

This directory (`~/.vscode-makerchip/compile-cache/`) stores results from TL-Verilog compilations for debugging and analysis.

## Directory Structure

Each subdirectory represents one compilation, identified by a short compile ID (e.g., `2kfOr`, `31f0E`):

```
compile-cache/
├── 2kfOr/
│   ├── metadata.json     # Compilation status, timestamps, error info
│   ├── top.tlv           # Full source code
│   ├── stdall            # SandPiper (TL-Verilog compiler) logs
│   ├── make.out          # Verilator (C++ simulator) logs
│   └── vlt_dump.vcd      # Waveform data (VCD format)
├── 31f0E/
│   └── ...
└── compile-history.json   # Index of all compilations
```

## Compilation Flow

`makerchip_compile` tool is non-blocking. Compilation runs asynchronously. Tool output tells you how to poll metadata.json to check the status of the compilation.

## File Descriptions

### `metadata.json`
Compilation status and metadata. Example:
```json
{
  "id": "68fqW",
  "timestamp": "2026-05-30T00:11:59.854Z",
  "fileComplete": {
    "stdall": true,
    "make.out": true,
    "vlt_dump.vcd": true
  },
  "complete": true,
  "hasResults": true,
  "hasSource": true,
  "exitStatus": {
    "sandpiper": 5,
    "verilator": 0
  }
}
```

Key fields:
- **fileComplete**: Object tracking which files finished streaming (`stdall`, `make.out`, `vlt_dump.vcd`).
- **complete**: `true` when all files marked complete in `fileComplete`.
- **passed**: `true`/`false` - simulation result (extracted from logs when `stdall` completes)
- **error**: If present, contains `{type, message}` - error types: 'compile', 'denied', 'compile-timeout', 'vcd-timeout', etc. E.g.:
```json
{
  "error": {
    "type": "compile"
  }
}
```
- **exitStatus**: Exit codes from `sandpiper` and/or `verilator` (non-zero indicates errors; warnings do not affect exit status and simply display in `make.out` logs)
- **hasResults**: Use this to ensure that result files have not been pruned
- **hasSource**: Use this to ensure that source code has not been pruned

### `top.tlv`
The complete source code that was compiled. This is the authoritative version that was actually processed.

### `stdall`
**SandPiper compiler logs in HTML format** (not plain text). Parse HTML to extract errors:
- Errors: `<div class="sandpiper-message" mc-sp-sev="10">` (severity 10 = fatal)
- Warnings: `mc-sp-sev="5"`
- Line numbers: "Line N" in text or `data-nav-line` attributes

### `make.out`
Verilator simulator logs (text). Verilator/C++ compilation and simulation output.

### `vlt_dump.vcd`
Waveform data in VCD format.

## Pruning Policy

Old compilations auto-pruned to save space: ~15 recent results, up to 150 metadata entries.

### Parsing stdall for Error Details

Whenever SandPiper exit status > 0, parse `stdall` (HTML format):
- **Errors:** `<div class="sandpiper-message" mc-sp-sev="10">` 
- **Warnings:** `mc-sp-sev="5"`
- **Line numbers:** Look for "Line N" in error text or `data-nav-line` attributes
- Strip HTML tags to get readable error message

Example: Error usually starts with `ERROR_TYPE(severity) (CODE): File 'top.tlv' Line N`

### Common Error Types in metadata.json

- `'compile'`: SandPiper fatal error → parse stdall for details
- `'denied'`: Rate limited (check `retryAfterSeconds`)
- `'compile-timeout'`, `'vcd-timeout'`, `'graph-timeout'`: Took too long
- `'vcd-stream'`: Waveform streaming failed
