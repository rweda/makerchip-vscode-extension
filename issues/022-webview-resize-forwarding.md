# 022: Investigate resize forwarding into the IDE iframe (cross-origin jQuery access)

- Status: open
- Area: webview
- Created: 2026-11-09

`webview.ts`'s `forwardResizeToIframe` reads `iframeWindow.jQuery` on the IDE iframe. That iframe is served
from the Makerchip server (or a tunnel), a different origin from the webview, so the access throws (the
console showed a jQuery error at `out/webview.js:513`), and the `dispatchEvent` fallback cannot reach a
cross-origin window either. The code's comments say the IDE also observes its own `#ide-root`, which may be
what keeps resizing working.

There is a known, outstanding resize bug that may or may not be related; it did not reproduce in a quick test.
Investigate before removing the forwarding: whether it ever works (same-origin dev setups?), what the IDE's own
observer covers, and whether the resize bug traces here. If the forwarding is dead, replace it with a
postMessage the IDE handles, or remove it.
