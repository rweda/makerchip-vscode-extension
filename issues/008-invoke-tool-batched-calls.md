# 008: Let `makerchip_invoke_tool` carry several calls in one invocation

- Status: open
- Area: makerchip-extension / LM tools (`makerchip_invoke_tool`), Claude-harness workaround
- Created: 2026-09-23

## Problem

Microsoft's Claude harness bridge dispatches one tool call per execution round. If the agent issues
two or more `mcp__client__makerchip*` calls in a single round, the first returns and the rest never
reach the extension — the call **hangs** until the user skips it. The agent cannot batch Makerchip
work, so a sequence like "set cycle, fit pane, grab the VIZ image" costs three round trips.

Worse, the agent's own general instructions tell it to batch independent tool calls into one round.
The rule we need it to follow is therefore *against* its default, and the penalty for slipping is a
hang rather than an error. We currently handle this with documentation only (the never-batch rule in
the Claude skill body, `src/claudeSkill.ts`), which is a model judgement, not an interlock.

## Goal

Give the agent a *sanctioned* way to batch, so following the rule costs it nothing:
`makerchip_invoke_tool` accepts a list of calls, the harness sees exactly **one** tool call, and the
extension runs the list serially internally. The concurrency limit is in the bridge, not in us, so a
single call carrying N invocations never trips it.

This also sidesteps the gating lag for free: `makerchip_enable_tools` only takes effect on the
agent's next turn because the harness fixes the offered tool list per round, but a batch executes
entirely inside the extension with no harness round trip in between. So
`[enable_tools(video), capture_video(...)]` can work in one call, which is impossible today.

## Desired behaviour

Extend the existing input rather than adding a tool (it is already the universal fallback, and it is
one of the two always-offered `when`-less tools):

- Keep `{ name, input }` working unchanged for a single call.
- Add `calls: [{ name, input }, ...]`, executed in order.
- Return one result per call, clearly delimited and index-tagged, so the agent can attribute
  outcomes to inputs without guessing.

## Decisions to make when picked up

- **Failure semantics.** Fail fast on the first error, or continue and report per-call status?
  Probably continue by default with an explicit `stopOnError` flag — a batch is a convenience, and
  aborting silently mid-way is the confusing case.
- **Long-running calls.** `makerchip_compile` / `makerchip_wait_compile` can block for tens of
  seconds. A batch containing several is a long single call; decide whether to cap total batch
  duration and how to report a partial batch that timed out.
- **Cancellation.** Propagate the `CancellationToken` to each call and stop cleanly between calls.
- **Nesting.** Refuse `makerchip_invoke_tool` inside a batch (it already refuses to invoke itself).
- **`describe` mode.** Either support `describe` per entry or reject it in batches; fetching several
  schemas at once is genuinely useful, so per-entry is probably worth it.
- **Result size.** N results in one payload can get large (VIZ images, logs). Consider truncating
  per-call output with a pointer to the usual on-disk artifacts.

## Notes

- Gating is already bypassed by this tool, so a batch inherits that: any tool is reachable whether
  or not its set is enabled.
- When this ships, update the never-batch rule in the skill body (`renderSkill` in
  `src/claudeSkill.ts`) to point at batching *through this tool* as the supported way to do it,
  rather than only prohibiting concurrent calls. The prohibition still holds for direct calls.
- This is a workaround for a harness bug, so keep it separable: if the bridge learns to dispatch
  concurrent calls, the batch path stays useful (it still beats N round trips) but the urgency goes.
  See the `IF A BETTER HOOK APPEARS OR BUGS ARE RESOLVED` note in `src/claudeSkill.ts`.
