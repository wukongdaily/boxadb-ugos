'use strict';
// 最小 DNS-SD：查 _adb-tls-pairing / _adb-tls-connect 的实例名与端口（非 root，组播 224.0.0.251:5353）
const dgram = require('node:dgram');
const os = require('node:os');

const PAIRING = '_adb-tls-pairing._tcp.local';
const CONNECT = '_adb-tls-connect._tcp.local';

function nameToLabels(name) {
  const out = [];
  for (const l of name.split('.')) {
    if (!l) continue;
    out.push(l.length);
    for (const c of Buffer.from(l, 'utf8')) out.push(c);
  }
  out.push(0);
  return Buffer.from(out);
}
function query(names) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(names.length, 4);
  // QCLASS 置 QU 位（0x8001）＝要求对方单播应答：Linux 上不加这个位常常只收到 PTR、收不到 SRV
  return Buffer.concat([h, ...names.map(n => Buffer.concat([nameToLabels(n), (() => { const b = Buffer.alloc(4); b.writeUInt16BE(12, 0); b.writeUInt16BE(0x8001, 2); return b; })()]))]);
}
function readName(buf, off) {
  let name = '', consumed = -1, guard = 0;
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) { if (consumed < 0) consumed = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {                       // 压缩指针：消费止于指针 2 字节，名字到目标处继续
      if (consumed < 0) consumed = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      if (++guard > 10) break;
      continue;
    }
    name += (name ? '.' : '') + buf.toString('utf8', off + 1, off + 1 + len);
    off += 1 + len;
  }
  if (consumed < 0) consumed = off;
  return { name, off: consumed };
}
function parse(buf) {
  const out = [];
  if (buf.length < 12) return out;
  let off = 12;
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  const skipQ = () => { const q = readName(buf, off); off = q.off + 4; };      // 问题段 footer 4B
  for (let i = 0; i < qd && off < buf.length; i++) skipQ();
  for (let i = 0; i < an + ns + ar && off < buf.length; i++) {
    const q = readName(buf, off); off = q.off;
    if (off + 10 > buf.length) break;                                          // 记录段 footer 10B
    const type = buf.readUInt16BE(off);
    const rdLen = buf.readUInt16BE(off + 8);
    off += 10;
    const rd = buf.subarray(off, off + rdLen);
    off += rdLen;
    if (type === 12) { const n = readName(buf, off - rdLen); if (n.name) out.push({ type: 'PTR', name: n.name }); }
    else if (type === 33 && rdLen >= 6) out.push({ type: 'SRV', name: q.name, port: rd.readUInt16BE(4) });
    else if (type === 1 && rdLen >= 4) out.push({ type: 'A', name: q.name, ip: [...rd.subarray(0, 4)].join('.') });
  }
  return out;
}
// 只跳过虚拟/隧道网卡；**不能跳过 br* 与 bond***：绿联等 NAS 开了虚拟机后，
// 业务地址常常挂在 br0 / br-lan 这类桥接口上，跳过它 ＝ 一个网卡都不剩，组播永远发不出去。
const SKIP_IF = /^(docker|veth|virbr|tun|tap|cni|flannel|kube|lo)/;
function lanIPv4(host) {
  const want = host ? String(host).split('.').slice(0, 3).join('.') : null;
  const out = [];
  for (const [dev, addrs] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IF.test(dev)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('127.')) continue;
      // 有目标时只发往和目标同 /24 的网卡，避免组播被送到 docker/其它网段
      if (want && a.address.split('.').slice(0, 3).join('.') !== want) continue;
      out.push({ dev, address: a.address });
    }
  }
  return out.slice(0, 4);
}
function openSocket(port, bindAddr) {
  return new Promise(resolve => {
    const sk = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const fail = () => { if (settled) return; settled = true; try { sk.close(); } catch {} resolve(null); };
    sk.once('error', fail);
    setTimeout(fail, 900);
    try {
      sk.bind(port, bindAddr, () => {
        if (settled) return;
        settled = true;
        try { sk.setMulticastTTL(2); sk.setMulticastLoopback(true); sk.setMulticastInterface(bindAddr); } catch {}
        try { sk.addMembership('224.0.0.251', bindAddr); } catch {}
        resolve(sk);
      });
    } catch { fail(); }
  });
}
function buildQuery(names, qu) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(names.length, 4);
  return Buffer.concat([h, ...names.map((n) => Buffer.concat([
    nameToLabels(n), (() => { const b = Buffer.alloc(4); b.writeUInt16BE(12, 0); b.writeUInt16BE(qu ? 0x8001 : 1, 2); return b; })(),
  ]))]);
}
// 每个候选网口各开一对 socket（临时端口 / 5353），并分别发带与不带 QU 位的查询后合并：
// macOS 上应答回到临时端口，Linux 多网卡上只有走对网口 + 5353 才收得到 SRV
async function ask(names, ms, host) {
  const found = [];
  const socks = [];
  const ifaces = lanIPv4(host);
  if (host && process.env.BOXADB_LOG_FILE) {
    try {
      require('node:fs').appendFileSync(process.env.BOXADB_LOG_FILE,
        new Date().toISOString() + ' [mdns] host=' + host + ' ifaces=' + (ifaces.map((i) => i.dev + '/' + i.address).join(',') || '-') + '\n');
    } catch {}
  }
  for (const it of ifaces) {
    for (const port of [0, 5353]) {
      const sk = await openSocket(port, it.address);
      if (!sk) continue;
      sk.on('message', (msg) => { try { found.push(...parse(msg)); } catch {} });
      for (const qu of [true, false]) {
        try { sk.send(buildQuery(names, qu), 5353, '224.0.0.251', () => {}); } catch {}
      }
      socks.push(sk);
    }
  }
  if (!socks.length) return found;
  await new Promise((r) => setTimeout(r, ms));
  for (const sk of socks) { try { sk.close(); } catch {} }
  return found;
}
async function browse(service, ms = 1500, host) {
  const seen = new Map();
  let recs = await ask([service], ms, host);
  const ptrs = [...new Set(recs.filter((r) => r.type === 'PTR' && r.name).map((r) => r.name))];
  if (ptrs.length) recs = recs.concat(await ask(ptrs, ms, host));
  for (const r of recs) {
    if (r.type !== 'SRV') continue;
    const inst = r.name.split('.')[0];
    if (!seen.has(inst)) seen.set(inst, { instance: inst, port: r.port });
  }
  return [...seen.values()];
}
// 兼容旧签名：(ms) 或 (ms, host)
const pairing = (ms, host) => browse(PAIRING, ms, host);
const connect = (ms, host) => browse(CONNECT, ms, host);
// 能否在本机发现 mDNS 广播：判据是「有没有和目标同一 /24 的网口」。
// NAT 容器里只有容器内网段（如 172.17/192.168.215），组播到不了局域网；NAS 版跑在主机上则同段可用。
function discoverable(host) {
  if (!host) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('127.')) return true;
    }
    return false;
  }
  const want = String(host).split('.').slice(0, 3).join('.');
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && a.address.split('.').slice(0, 3).join('.') === want) return true;
  }
  return false;
}

module.exports = { pairing, connect, browse, parse, query: (n) => buildQuery(n, false), discoverable };
