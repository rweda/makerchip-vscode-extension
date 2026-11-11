# 019: Drop the lost-quick-result workaround once the Claude harness fixes the race

- Status: open
- Area: `packages/makerchip-extension/src/makerchipTool.ts` (`MIN_RESULT_MS`), `src/claudeSkill.ts` (call rules, HARNESS NOTES)
- Created: 2026-11-07

The Claude harness drops a tool result that arrives before its permission approval completes, and
the call hangs (see HARNESS NOTES in `claudeSkill.ts`). The workaround: the extension holds every
outermost tool call's result (and error) for `MIN_RESULT_MS` (3 s, in `makerchipTool.ts`), and
`makerchip_invoke_tool`'s `minDurationMs` can raise that. Every quick call, in every harness, pays
the delay.

Remaining work: once the harness no longer loses quick results, remove the hold (`MIN_RESULT_MS`
and its wrapper in `registerMakerchipTool`), decide whether `minDurationMs` is still worth keeping,
and remove the guidance and the "Lost quick result" diagnosis from the skill.
