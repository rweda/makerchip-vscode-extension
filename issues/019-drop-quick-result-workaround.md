# 019: Drop the lost-quick-result workaround once the Claude harness fixes the race

- Status: open
- Area: `packages/makerchip-extension/src/claudeSkill.ts` (call rules, HARNESS NOTES)
- Created: 2026-11-07

The Claude harness drops a tool result that arrives before its permission approval completes, and
the call hangs (see HARNESS NOTES in `claudeSkill.ts`). The skill's workaround is
`makerchip_invoke_tool` with `minDurationMs`. It doesn't help a normally slow call that fails fast:
for example, `makerchip_compile` returns "server is not reachable" within milliseconds if the
server is down.

Remaining work: once the harness no longer loses quick results, remove the `minDurationMs` guidance
and the "Lost quick result" diagnosis from the skill.
