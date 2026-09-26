// Persisted regression check for Task 6 fix round 1, finding F2: a multi-byte UTF-8
// character split across a stdout chunk boundary must survive intact. Exercises the SAME
// wireChatStream() function agentAction's chat branch uses (infra/dashboard/chat-stream.mjs),
// not a copy of its logic, so this cannot silently drift out of sync with production the way
// the implementer's original throwaway script could (and did — it no longer exists). No
// server, no spawn, no root: a PassThrough stands in for a real child's stdout, with the
// write split at an exact byte offset a real OS pipe read can (and, on this box, has) produce.
import { PassThrough } from 'node:stream';
import { wireChatStream } from '../infra/dashboard/chat-stream.mjs';

let failed = false;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) failed = true;
}

// "café ☕" — é is U+00E9 (UTF-8: 0xC3 0xA9), ☕ is a 3-byte sequence. Split the buffer
// mid-character, right after the é's lead byte.
const line = JSON.stringify({ seq: 1, delta: 'café ☕' }) + '\n';
const bytes = Buffer.from(line, 'utf8');
const splitAt = bytes.indexOf(0xc3) + 1; // ends ON the é's lead byte
const chunk1 = bytes.subarray(0, splitAt);
const chunk2 = bytes.subarray(splitAt);
if (chunk1.length === 0 || chunk2.length === 0) throw new Error('fixture did not split mid-character — check the byte offset');

const deltas = [];
const stdout = new PassThrough();
const stream = wireChatStream(stdout, o => deltas.push(o), () => {});
stdout.write(chunk1);
stdout.write(chunk2);
stdout.end();
await new Promise(resolve => stdout.on('end', resolve));

check('a multi-byte character split across a chunk boundary survives intact',
  deltas.length === 1 && deltas[0].delta === 'café ☕');
check('no drop was counted for a boundary that decodes cleanly',
  stream.drops() === 0);

// A genuinely malformed line (never a valid boundary artifact once setEncoding('utf8') is in
// place) must still be counted rather than silently vanishing.
const deltas2 = [];
const stdout2 = new PassThrough();
const stream2 = wireChatStream(stdout2, o => deltas2.push(o), () => {});
stdout2.write('not json at all\n');
stdout2.write(JSON.stringify({ seq: 2, delta: 'ok' }) + '\n');
stdout2.end();
await new Promise(resolve => stdout2.on('end', resolve));

check('a malformed line is counted as a drop, not silently discarded', stream2.drops() === 1);
check('a valid line after a malformed one still gets through',
  deltas2.length === 1 && deltas2[0].delta === 'ok');

process.exit(failed ? 1 : 0);
