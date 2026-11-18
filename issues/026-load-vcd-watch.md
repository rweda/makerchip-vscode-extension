# 026: Reload a locked VCD when its file changes (`makerchip_load_vcd` `watch`)

- Status: open
- Area: makerchip-extension / `makerchip_load_vcd`, webview reload persistence
- Created: 2026-11-17

`makerchip_load_vcd` loads a VCD once. Iterating on an external simulation (rerun the simulator, look at
VIZ again) means calling the tool again after every run. Users loading a trace themselves have no way to do
this at all.

## Remaining work

- A `watch: true` input: watch the loaded file (`vscode.workspace.createFileSystemWatcher`) and reload it
  (via IDE `loadVcd`) when it changes, debounced so a simulator still writing it isn't read mid-write
  (e.g. reload once the size is stable). Stop watching on `release`, on loading another file, and on
  panel disposal.
- Persist the watch with the lock (`vcdPath` in webview state) so it resumes after a window reload.
- Keep the current cycle across reloads (as the restore path does), since the trace's length may change.
- Consider a user-facing command ("Makerchip: Load Waveform...") with a file picker, sharing this path.
