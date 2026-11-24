# 019: Drop the lost-quick-result workaround once the Claude harness fixes the race

- Status: open
- Area: `packages/makerchip-extension/src/makerchipTool.ts` (`DEFAULT_MIN_DURATION_MS`), `src/claudeSkill.ts` (call rules, HARNESS NOTES)
- Created: 2026-11-07

The Claude harness drops a tool result that arrives before its permission approval completes, and
the call hangs (see HARNESS NOTES in `claudeSkill.ts`). The workaround: the extension holds every
outermost tool call's result (and error) for `DEFAULT_MIN_DURATION_MS` (3 s, in `makerchipTool.ts`),
which `makerchip_invoke_tool`'s `minDurationMs` overrides (e.g. 0, to test whether a harness has the
race). Every quick call, in every harness, pays the default delay.

3 s is not always enough. On 2026-11-24 a quick `makerchip_invoke_tool` batch (two
`makerchip_open_third_party_view`, one `makerchip_open_view`) hung although its work was done, while
the same batch on another panel minutes earlier returned. Both returned after 3.0 s, and the agent
host logged `Forwarding client tool completion: source=client-dispatch` for each (its `agenthost.log`),
but only the one that returned was followed by `source=server-envelope`, so the Claude SDK never took
the result. In auto mode, approval by the permission classifier presumably takes variable time. If
the race persists, consider a longer default rather than per-call `minDurationMs`.

Remaining work: once the harness no longer loses quick results, remove the hold (in
`registerMakerchipTool`) or default it to 0, decide whether `minDurationMs` is still worth keeping,
and remove the guidance and the "Lost quick result" diagnosis from the skill.
