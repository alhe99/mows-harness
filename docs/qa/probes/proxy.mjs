// A TCP pass-through in front of the fixture dashboard, with one control: cut every connection now.
//
// WHY NOT ctx.setOffline(). Measured in Chromium: emulated offline does NOT tear down an
// already-established SSE socket — a delta injected "while offline" arrives anyway, so a reconnect
// test built on it is green without ever testing a reconnect. What a phone losing signal does to an
// open stream is kill the socket, so this kills the socket. It is also engine-portable, which
// setOffline is not.
//
// Node stdlib only. Ports are taken from argv so run.sh can keep everything out of the way of a
// real dashboard on the same box.
import net from 'node:net';
import http from 'node:http';

const LISTEN = Number(process.argv[2] || 3205);
const UPSTREAM = Number(process.argv[3] || 3105);
const CONTROL = Number(process.argv[4] || 3206);
const live = new Set();

net.createServer(sock => {
  const up = net.connect(UPSTREAM, '127.0.0.1');
  live.add(sock); live.add(up);
  const bye = () => { live.delete(sock); live.delete(up); sock.destroy(); up.destroy(); };
  for (const ev of ['error', 'close']) { sock.on(ev, bye); up.on(ev, bye); }
  sock.pipe(up); up.pipe(sock);
}).listen(LISTEN, '127.0.0.1', () => console.log('proxy on ' + LISTEN + ' -> ' + UPSTREAM));

http.createServer((req, res) => {
  const n = live.size;
  for (const s of live) s.destroy();
  live.clear();
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('cut ' + n + '\n');
}).listen(CONTROL, '127.0.0.1', () => console.log('control on ' + CONTROL));
