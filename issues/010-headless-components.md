# 010: Agent one-shot tasks via a headless IDE Component

- Status: open
- Area: makerchip-extension / LM tools; depends on headless Components in the IDE (mono)
- Created: 2026-09-29

## What this is

The mechanism lives in the IDE, not here: a **headless IDE Component** is a third-party component
that is exactly like a third-party pane except that it is not a pane — a hidden iframe, so the
sandboxing, provenance (by origin, e.g. `platform.ai`) and permission story are identical to the
ones panes already have. See the mono repo:

- `issues/007-single-instance-panes-and-pane-state.md` — "Generalize beyond Panes to headless IDE
  Components": state + lifecycle (reserve, updateState, close) should not be Pane-specific.
- `issues/006-pane-api-trust-model.md` — the trust/approval model for component→IDE mutations
  (`IDE#paneRpcAllowedIdeMethods`), i.e. the capability grant.
- `issues/001-component-lifecycle-standardization.md` and
  `issues/004-decouple-flexsplit-from-ide.md` — the lifecycle and DOM-coupling work this sits on.

This issue records only the **extension-side** interest, so the motivation is not lost in a repo
that cannot see it.

## Why the extension cares

A headless Component that **tears itself down when finished** is the general mechanism for an agent
to perform a complex one-shot task, and it resolves something the LM tool surface cannot.

An agent can fan out — many independent tool calls in one round, executed together — but it cannot
**chain**: using one call's result as the next call's input requires seeing that result, which ends
the turn. Every dependency edge therefore costs a full model round trip, a fresh inference pass over
the whole conversation. The dominant cost is not latency but **context**: a loop over N operations
puts N results into the transcript when only a summary is wanted.

Agent-authored code running inside such a Component collapses that. Loops, conditionals, retries,
early exit and filtering happen in-process; intermediates live in variables and never enter the
transcript; one result comes back.

## Provenance is already handled

Agent-authored code has no origin of its own, but that is not new here and not specific to headless
Components — it is the same for an agent-authored third-party *pane*, and the identity model already
covers it. The IDE stamps **`platform.<agent>`** (e.g. `platform.ai`) when the host relays an action
on behalf of a less-trusted agent, distinguishing it from first-hand `platform` events, and it cannot
forge the reserved `ide` identity. See `doc-src/plugin/Third_Party_Pane_API.md` in mono ("Identities").
What such an identity is *allowed* to do is the trust model's business, i.e. mono
`issues/006-pane-api-trust-model.md` — not a new policy to invent here.

What is genuinely specific to the one-shot agent case is lifetime, not identity:

- **Deterministic teardown** on error, timeout and cancellation — subscriptions revoked,
  capabilities dropped, no orphaned context.
- **Interruptible** resource limits, not just a wall-clock timeout: a tight loop has to be stoppable.

On approval: per-call consent does not survive a script making dozens of calls, but the script is
itself a reviewable artifact. Showing it before it runs is arguably better than approving an opaque
sequence, because intent is visible rather than inferred. Pair that with logging the code and the
calls it made, so a run is auditable after the fact.

## Relationship to `makerchip_invoke_tool`'s `calls`

`calls` batches several tool invocations into one so the harness's one-call-per-round bridge limit
cannot hang them (see the BATCHING note on `InvokeToolTool`). It is deliberately dumb: a serial
list, no data flow, no control flow. Keep it that way. Parallelism, nesting or result interpolation
would each be a step toward reimplementing a programming language inside a tool input, with no
debugger. If more than a flat serial list is needed, this issue is the answer, not a richer batch.
