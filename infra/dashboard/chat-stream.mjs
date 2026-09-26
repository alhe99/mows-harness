// Turns a `chat --stream` child's raw stdout into delta/end callbacks. Pulled out of
// agentAction's chat branch in lite.mjs so it has its own unit coverage —
// scripts/chat-stream-utf8-check.mjs imports and exercises this exact function, not a copy
// of its logic, so the check cannot silently drift out of sync with production the way a
// throwaway script would (Task 6 fix round 1, F2/F10).
export function wireChatStream(stdout, onDelta, onEnd) {
  // Without this, `buf += d` coerces each raw Buffer chunk to a string with its own,
  // independent UTF-8 decode. A multi-byte character split across a chunk boundary (not
  // hypothetical — non-ASCII replies are routine) then decodes as U+FFFD replacement bytes
  // on BOTH sides of the split, silently, with JSON.parse succeeding either way — nothing
  // for `catch {}` below to catch. setEncoding('utf8') hands chunks to Node's internal
  // StringDecoder instead, which holds an incomplete trailing sequence until the next chunk
  // completes it (fix round 1, F2).
  stdout.setEncoding('utf8');
  let buf = '', dropped = 0;
  stdout.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o.end) onEnd(o); else onDelta(o);
      } catch {
        // A malformed line from the CLI must not crash the dashboard — counted rather than
        // silently discarded, so at least the fact of a drop is observable (fix round 1, F2).
        dropped++;
      }
    }
  });
  return { drops: () => dropped };
}
