#!/usr/bin/env node
// shot-name-check.mjs — the stored name of a /shot upload (routes/actions.mjs shotName): the real name wins, a nameless upload takes its extension
// from the content type, and nothing is ever guessed as .jpg (2026-10-19: .md/.docx uploads had landed as shot-<ms>.jpg).
//   node scripts/shot-name-check.mjs
import { shotName } from '../infra/dashboard/routes/actions.mjs';

let bad = 0;
const ok = (name, got, want) => { const c = got === want; if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${c ? '' : ` got ${got} want ${want}`}`); };
ok('a named .md keeps its name', shotName('text/markdown', encodeURIComponent('notes.md'), 1), 'shot-1-notes.md');
ok('a named .docx keeps its name', shotName('application/vnd.openxmlformats-officedocument.wordprocessingml.document', encodeURIComponent('Detalles de hallazgo.docx'), 1), 'shot-1-Detalles_de_hallazgo.docx');
ok('a mac screenshot name is reduced, extension kept', shotName('image/png', encodeURIComponent('Screenshot 2026-10-11 at 5.21.17 PM.png'), 1), 'shot-1-Screenshot_2026-10-11_at_5.21.17_PM.png');
ok('a nameless markdown is .md, not .jpg', shotName('text/markdown', '', 1), 'shot-1.md');
ok('a nameless pdf is .pdf', shotName('application/pdf', undefined, 1), 'shot-1.pdf');
ok('a nameless text with a charset is .txt', shotName('text/plain; charset=utf-8', '', 1), 'shot-1.txt');
ok('a nameless jpeg is .jpg', shotName('image/jpeg', '', 1), 'shot-1.jpg');
ok('a nameless png is .png', shotName('image/png', '', 1), 'shot-1.png');
ok('an unknown nameless type is .bin, never .jpg', shotName('application/octet-stream', '', 1), 'shot-1.bin');
ok('no content type at all is .bin', shotName(undefined, '', 1), 'shot-1.bin');
ok('a path in the name cannot leave the dir', shotName('text/plain', encodeURIComponent('../../etc/passwd'), 1), 'shot-1-_.._etc_passwd');
ok('a malformed x-name falls back to the type', shotName('text/markdown', '%E0%A4%A', 1), 'shot-1.md');
process.exit(bad ? 1 : 0);
