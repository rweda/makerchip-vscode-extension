# 002: Restore/waveform VCD parser rejects valid batch (non-monotonic) VCDs

- Status: open
- Area: makerchip-extension / webview restore, waveform VCD parsing
- Created: 2026-08-03

## Problem

On a VS Code reload, restoring a Makerchip panel whose cached compile was a **batch-mode** run
raises an alert like:

```
Error parsing VCD file: Time steps backward from 1066 to 533
```

(observed for 2-team / 3-team / 4-team Eleven Towers tournament runs — `showdown_results_{2,3,4}team.tlv`).

The cached `vlt_dump.vcd` is genuinely **non-monotonic in `$time`**: timestamps climb, then jump
backward to a (rising) floor and climb again, many times over. This is **not** cache corruption —
it is inherent to Makerchip's batch mode, which uses a free-running-clock (`!clk`) backdoor and
effectively replays/interleaves time per batch. A non-batch single-game run (no backdoor) produces a
clean monotonic VCD and restores without complaint.

Key point: **the live Makerchip viewer tolerates this VCD** (VIZ and the waveform render fine during
the original compile), but the parser used on the **reload/restore path is stricter** and aborts on
the first backward step. The failure is essentially cosmetic for VIZ — after the alert, VIZ still
renders correctly per-cycle (verified: stepping to mid-run shows in-progress games and the scoreboard
banking as rounds complete) — but the alert is alarming and the WAVEFORM pane data is rejected.

## Evidence

Backward steps in the cached VCDs (identifier codes legitimately contain `#`, e.g. `Km#`, `0#7`,
`8f#`; the affected lines are real `#<time>` timestamps):

| run | first backward step | backward events |
|---|---|---|
| 2-team | `#1162 -> #813` | 2 |
| 3-team | `#1066 -> #533` | 11 |
| 4-team | `#1508 -> #959` | 11 |

## Options

1. **Make the restore/waveform VCD reader tolerant of non-monotonic time** (recommended): treat a
   backward `#t` the way the live viewer does rather than aborting. Ideally share the exact reader the
   live viewer uses so live and restore behavior can't diverge.
2. **Downgrade to a warning** (don't `alert`): if a fully-tolerant parse is out of scope, at least
   avoid the modal/console error on restore since VIZ is unaffected, and note it's a batch VCD.
3. **Cache a viewer-normalized VCD** for restore: if the live pipeline normalizes time before display,
   persist that normalized form (or enough metadata) so restore feeds the parser the same thing the
   live viewer got.

## Recommendation

Reconcile the restore/waveform parser with the live viewer's tolerance (Option 1). Batch runs are a
first-class use of the framework (the whole tournament grid depends on them), so restoring them after
a reload should be silent. Until then, Option 2 (warning, not error) would remove the alarming alert.

## Notes

- Related to issue 001 (an explicit "open from cache" tool would exercise this same restore/parse path,
  so it should be fixed alongside).
- Repro: compile any `showdown_results_{2,3,4}team.tlv` (batch mode) in a panel, reload the VS Code
  window, observe the restore alert. VIZ still works after dismissing it.
