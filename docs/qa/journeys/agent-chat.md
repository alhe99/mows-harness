---
mode: headless
target: http://127.0.0.1:3005
---
# Agent chat streams

1. Open `/ui/agents`. Expect at least one agent card.
2. Click an agent that has a completed run. Expect a Chat section with a composer.
3. Type "In one line: what did your last run find?" and send.
4. Expect the message to appear immediately as a `you` bubble, before any reply.
5. Expect the reply to grow **incrementally**: sample the assistant bubble's text length three times over six seconds and assert it increases at least twice. A reply that appears in one block is a regression, even though it looks correct.
6. Scroll the transcript up mid-stream. Expect the view NOT to jump to the bottom on the next token, and expect a "Jump to latest" control to appear.
7. Click "Jump to latest". Expect the view to return to the bottom and to follow new tokens again.
8. Resize to 375×812 and focus the composer. Expect the composer to remain visible with the keyboard raised, and no horizontal page scroll.
9. Reload mid-stream. Expect the completed reply to appear exactly once, with no duplicated text.
