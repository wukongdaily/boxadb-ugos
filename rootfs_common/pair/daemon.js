'use strict';
// Docker 形态的配对 sidecar：只监听 127.0.0.1，由 Go 桥把 /pair /recover /discover 转过来
const http = require('node:http');
const path = require('node:path');
const keystore = require('./keystore.js');
const api = require('./api.js');

const PORT = Number(process.env.BOXADB_PAIR_PORT || 8770);
const HOST = process.env.BOXADB_PAIR_HOST || '127.0.0.1';
const PIN = Number(process.env.BOXADB_PIN_PORT || 5555);
keystore.init(process.env.BOXADB_STATE_DIR || path.join(process.env.DATA_DIR || '/data', 'pair'));

const say = (...a) => {
  const line = [new Date().toISOString(), '[pair]', ...a].join(' ');
  console.log(line);
  if (process.env.BOXADB_LOG_FILE) { try { require('node:fs').appendFileSync(process.env.BOXADB_LOG_FILE, line + '\n'); } catch {} }
};

// 桥被强杀时来不及回收子进程，这里靠 stdin 管道：父进程一没，读端就 EOF，sidecar 自己退出
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 4096) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});
const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };

http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad-request' }); }
  if (u.pathname === '/health') { send(res, 200, { ok: true, nonce: process.env.BOXADB_PAIR_NONCE || '' }); return; }
  const run = async () => {
    if (u.pathname === '/discover' && req.method === 'GET') return await api.discoverFlow({ host: String(u.searchParams.get('host') || '').trim() });
    const b = req.method === 'POST' ? await readBody(req) : {};
    const host = String(b.host || u.searchParams.get('host') || '').trim();
    if (u.pathname === '/pair') return await api.pairFlow({ host, pairPort: b.pairPort, code: b.code, connPort: b.connPort, pinPort: Number(b.pinPort) || PIN, log: say });
    if (u.pathname === '/recover') return await api.recoverFlow({ host, quick: b.quick === true, pinPort: PIN, log: say });
    return { status: 404, body: { error: 'not-found' } };
  };
  run().then((r) => send(res, r.status, r.body)).catch((e) => { say('error', e.message); send(res, 500, { error: 'internal', hint: String(e.message || e) }); });
}).listen(PORT, HOST, () => say(`ready on http://${HOST}:${PORT}  state=${process.env.BOXADB_STATE_DIR || path.join(process.env.DATA_DIR || '/data', 'pair')}  pinPort=${PIN}`));
