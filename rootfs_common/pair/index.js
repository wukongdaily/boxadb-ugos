'use strict';
// 配对 / 自愈钉端口编排。真机验通要点：
//   配对门 = 首字节即 TLS1.3；连接门 = 明文 CNXN → STLS → 客户端也回 STLS → TLS1.3(外部 PSK + 客户端证书)
//   三处必须同一把 RSA key：PeerInfo 公钥 / TLS 客户端证书 / AUTH 私钥
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { runPairing } = require('./pairing.js');
const peerinfo = require('./peerinfo.js');
const { encodeAdbPubkey } = require('./pubkey.js');
const w = require('./adbwire.js');
const mdns = require('./mdns.js');
const ks = require('./keystore.js');

const CIPHERS = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
const FEATURES = 'host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,delayed_ack';
const ERR = (step, msg) => Object.assign(new Error(msg), { step });
const withTimeout = (p, ms, step) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(ERR(step, '超时 ' + ms + 'ms')), ms)),
]);

const probe = (host, port, ms) => new Promise(res => {
  const sk = net.connect(port, host);
  const done = (v) => { clearTimeout(t); try { sk.destroy(); } catch {} res(v); };
  const t = setTimeout(() => done(false), ms);
  sk.once('connect', () => done(true));
  sk.once('error', () => done(false));
});

// 读一条完整 adb 消息（24B 头 + 声明长度载荷）
async function readMsg(sock, ms) {
  const head = await readN(sock, 24, ms);
  const len = head.readUInt32LE(12);
  if (len > 1024 * 1024) throw ERR('handshake', '设备声明的载荷长度异常：' + len);
  return w.decode(len ? Buffer.concat([head, await readN(sock, len, ms)]) : head);
}

async function readN(sock, n, ms) {
  const t0 = Date.now();
  for (;;) {
    const d = sock.read(n);
    if (d && d.length === n) return d;
    if (d) sock.unshift(d);
    const left = ms - (Date.now() - t0);
    if (left <= 0) throw ERR('handshake', '等 adbd 的 STLS 超时');
    await new Promise(r => {
      const t = setTimeout(r, left);
      sock.once('readable', () => { clearTimeout(t); r(); });
    });
  }
}

// 配对门：TLS1.3 起手的 SPAKE2 交换，成功后持久化 identity + psk
async function pair({ host, port, code, timeout = 25000 }) {
  if (!/^\d{6}$/.test(String(code))) throw ERR('code', '配对码应为 6 位数字');
  const ident = ks.identity();
  const sock = tls.connect({ host, port, minVersion: 'TLSv1.3', rejectUnauthorized: false, key: ident.keyPem, cert: ident.certPem });
  await withTimeout(new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', e => rej(ERR('pair-tls', e.code || e.message))); }), timeout, 'pair-tls');
  let binding;
  try { binding = sock.exportKeyingMaterial(64, 'adb-label\u0000'); }
  catch (e) { sock.destroy(); throw ERR('exporter', e.message); }
  const pw = Buffer.concat([Buffer.from(String(code), 'ascii'), binding]);
  const myPeerInfo = peerinfo.rsaFromKey524(encodeAdbPubkey(ident.publicKey));
  let r;
  try {
    r = await withTimeout(runPairing({ role: 'client', pwbuf: pw, out: sock, inStream: sock, myPeerInfo, timeout: timeout - 2000 }), timeout, 'pairing');
  } catch (e) {
    sock.destroy();
    throw ERR(e.message.includes('GCM') ? 'code' : 'pairing', e.message);
  }
  const info = peerinfo.assertShape(r.peerPeerInfo, 'pair');
  const identity = info.hint;
  ks.remember(identity, r.psk, { peerHost: host });
  sock.destroy();
  return { identity, psk: r.psk, aesKey: r.aesKey };
}

// 连接门：升级到 TLS1.3-PSK，然后下 tcpip:<pinPort>
async function pin({ host, port, identity, psk, pinPort = 5555, timeout = 8000 }) {
  const ident = ks.identity();
  const key = Buffer.isBuffer(psk) ? psk : Buffer.from(String(psk), 'hex');
  const raw = net.connect(port, host);
  raw.pause(); raw.setNoDelay(true);
  const die = (step, msg) => { try { raw.destroy(); } catch {} throw ERR(step, msg); };
  await withTimeout(new Promise((res, rej) => { raw.once('connect', res); raw.once('error', e => rej(ERR('connect', e.code || e.message))); }), timeout, 'connect');
  raw.write(w.encode(w.CMD.CNXN, w.VERSION, w.MAXDATA, w.cstring(FEATURES)));
  const hello = await readMsg(raw, timeout).catch(e => die('handshake', e.message));
  if (hello.name === 'CNXN') die('plaintext', '这台设备不需要配对，直接明文连接即可');
  if (hello.name !== 'STLS') die('handshake', '设备首包不是 STLS，而是 ' + hello.name);
  raw.write(w.encode(w.CMD.STLS, w.VERSION, 0));
  const sock = tls.connect({
    socket: raw, rejectUnauthorized: false, minVersion: 'TLSv1.3', ciphers: CIPHERS,
    key: ident.keyPem, cert: ident.certPem,
    pskCallback: () => ({ psk: key, identity }),
  });
  const hs = await Promise.race([
    new Promise(res => sock.once('secureConnect', () => res({ ok: true }))),
    new Promise(res => sock.once('error', e => res({ ok: false, why: e.code || e.message }))),
    new Promise(res => setTimeout(() => res({ ok: false, why: 'timeout' }), timeout)),
  ]);
  if (!hs.ok) { try { sock.destroy(); } catch {} die('tls', 'TLS 升级失败：' + hs.why); }
  const msgs = [];
  const out = [];
  let device = null;
  let closed = false;
  const rd = new w.Reader(m => {
    msgs.push(m.name);
    if (m.name === 'CNXN' && !device) device = w.strip0(m.payload);
    if (m.name === 'WRTE') { out.push(m.payload.toString('utf8')); sock.write(w.encode(w.CMD.OKAY, 7, m.arg1)); }
    if (m.name === 'CLSE') closed = true;
  });
  sock.on('data', d => rd.push(d));
  await new Promise(r => setTimeout(r, 1200));
  if (!device) { sock.destroy(); die('cnxn', 'TLS 建立后设备未发 CNXN（psk 可能已失效，需重新配对）'); }
  sock.write(w.encode(w.CMD.OPEN, 7, 0, w.cstring('tcpip:' + pinPort)));
  const t0 = Date.now();
  while (!closed && out.join('').length === 0 && Date.now() - t0 < timeout) await new Promise(r => setTimeout(r, 150));
  const text = out.join('').trim();
  try { sock.destroy(); } catch {}
  const reachable = await probe(host, pinPort, 2000);
  return { device, msgs, text, pinned: /restarting in TCP mode/i.test(text) || reachable, reachable };
}

// 自愈：现查 mDNS（端口每次开机都变）→ 用已存 psk 开门钉端口
async function recover({ host, pinPort = 5555, timeout = 8000, mdnsMs = 2000 } = {}) {
  if (host && await probe(host, pinPort, 1200)) return { ok: true, already: true, pinPort };   // 端口已通，无需任何自愈
  const found = await mdns.connect(mdnsMs, host);
  const known = ks.list();
  // 只认「配过对且属于这台 IP」的实例；无归属信息的旧记录仅在当地只有一条凭据时才敢套用
  const sole = known.length === 1 && found.length === 1;
  let hit = found.find((f) => known.some((k) => k.instance === f.instance &&
    (!host || !k.peerHost ? (k.peerHost ? k.peerHost === host : sole) : k.peerHost === host)));
  // 盒子重启后 mDNS 实例名的随机后缀可能变（adb-<serial>-xxxx 会换），严格匹配会误判成「没配过对」。
  // 家里只有一台设备、只有一条凭据时，按“唯一候选”直接认它。
  if (!hit && known.length === 1 && found.length === 1) hit = found[0];
  const line = '[recover] found=' + (found.map((f) => f.instance + ':' + f.port).join(',') || '-') +
    ' known=' + (known.map((k) => k.instance + '@' + (k.peerHost || '-')).join(',') || '-') +
    ' hit=' + (hit ? hit.instance : '-');
  console.log(line);
  if (process.env.BOXADB_LOG_FILE) { try { require('node:fs').appendFileSync(process.env.BOXADB_LOG_FILE, new Date().toISOString() + ' ' + line + '\n'); } catch {} }
  if (!hit) return { ok: false, need: found.length ? 'pair' : 'manual-port', discovered: found,
    reason: found.length ? '发现的实例没有已存凭据' : '未发现无线调试广播（可能是自动发现不可用，也可能开关确实没开）' };
  const rec = ks.lookup(hit.instance);
  if (!rec || !rec.psk) return { ok: false, need: 'pair', reason: '无 psk' };
  try {
    const r = await pin({ host, port: hit.port, identity: hit.instance, psk: rec.psk, pinPort, timeout });
    ks.remember(hit.instance, Buffer.from(rec.psk, 'hex'), { port: hit.port, peerHost: host });   // 顺手补回归属，旧记录会被逐步修好
    return { ok: true, identity: hit.instance, port: hit.port, ...r };
  } catch (e) {
    return { ok: false, need: 'pair', step: e.step, reason: e.message, identity: hit.instance };
  }
}

module.exports = { pair, pin, recover, CIPHERS, FEATURES };
