# 017: Tool errors are returned as ordinary results, so batches count them ok

- Status: open
- Area: `packages/makerchip-extension/src/makerchipTool.ts` (tool `invoke` catch blocks)
- Created: 2026-10-27

Most tools catch their own errors and return them as a text result (e.g. `makerchip_compile`'s
"Failed to launch Makerchip: ..."), about 25 sites. `makerchip_invoke_tool`'s batch only sees a
*thrown* error as a failure, so it counts these "ok" and runs dependent entries (fit, set_cycle,
capture) against a stale or blank pane. Observed: `reload_panels` then `compile` in one batch, the
compile timing out.

## Fix

Throw (or rethrow with context) instead of returning, so the harness and the batch both see a
failure. Keep returning text only where the result is a legitimate partial success (e.g. a compile
that ran and failed, which is a result, not a tool error). Audit each site for that distinction.
