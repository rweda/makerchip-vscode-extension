# 012: An IDE call made while a panel is still connecting times out

- Status: open
- Area: `extension.ts` (`callIdeMethodWithResult`, panel/webview readiness)
- Created: 2026-10-06

`makerchip.callIdeMethodWithResult` starts its timeout the moment it is called, with no regard for
whether the panel has finished connecting. A call issued during reconnection therefore burns its
whole budget waiting for an IDE that is not listening yet, and fails with
`Timeout waiting for IDE method '<name>' result` even though nothing is wrong.

Observed: `openThirdPartyPane` immediately after a `makerchip_reload_panels` timed out and the pane
was not created; an identical retry succeeded. The default budget is 10s
(`timeoutMs: number = 10000`).

The failure is particularly unhelpful for an agent, which has no way to distinguish "the IDE
rejected this" from "the IDE had not loaded yet", so its reasonable next step -- change the request
-- is the wrong one. The right action is simply to wait and repeat.

## Shape of a fix

Two candidates, not exclusive:

1. **Chain the timer to readiness.** Do not start the clock until the webview has reported `ready`
   (the handler already logs `✓ Connected to <serverUrl>`), so the budget measures the IDE method,
   not the connection. This is the more accurate fix: the timeout is meant to bound a call, and a
   call that has not been delivered has not started.
2. **Raise the default**, or distinguish a connect budget from a call budget. Cruder, but it also
   covers a panel that is slow for some other reason.

Either way the timeout message should say which phase elapsed -- "panel never became ready" reads
very differently from "the IDE method did not answer" -- because that distinction is what tells a
caller whether retrying is sensible.

## Note

`makerchip_reload_panels` reports `No open Makerchip panels to reload` and does not open one, so a
caller that wants a panel has to compile something first to create it. That is defensible, but it is
a second way to arrive at "my first call failed and I do not know why"; worth considering alongside
this.
