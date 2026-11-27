'use strict';
// 无线配对 API：飞牛版（server.js 直连调用）与 Docker 版（sidecar daemon）共用同一套语义与中文话术
const keystore = require('./keystore.js');
const wireless = require('./index.js');
const mdns = require('./mdns.js');

const FAIL_HINT = {
  code: '配对码不正确或已过期，请回到配对窗口重新获取',
  pairing: '配对中断，请确认配对窗口仍停留在屏幕上',
  'pair-tls': '连不上配对端口，请确认配对窗口是打开状态',
  connect: '连不上连接端口，请照无线调试第一屏核对端口号',
  handshake: '设备没有按预期应答，请确认目标 IP 是这台盒子',
  tls: '这台设备的配对已失效，需要重新配对一次',
  cnxn: '设备拒绝了已保存的配对，需要重新配对一次',
  timeout: '设备响应超时，请确认盒子在线且无线调试已开启',
  plaintext: '这台设备不需要配对，直接填 IP 连接即可',
  'no-service': '盒子重启后「无线调试」会自动关掉：用遥控器打开 设置 → 开发者选项 → 无线调试（不用再输配对码），然后重新点连接即可',
  'not-paired': '这台设备还没配过对：在电视上点开「使用配对码配对设备」，把配对端口和 6 位配对码填进去再提交',
  'manual-port': '没查到无线调试广播：可能是盒子刚重启（开关会自动关），也可能是容器网络隔离查不到。请把电视「无线调试」第一屏的连接端口填到 ①；这台若还没配过对，再填 ② 的配对端口和 6 位码',
};

function recoverVerdict({ r, known }) {
  if (r.ok) return { ok: true, identity: r.identity, port: r.port, pinned: r.pinned, device: r.device, paired: true };
  const reason = String(r.reason || '');
  const noService = r.need === 'manual-port' || reason.includes('未发现') || reason.includes('不可见');
  if (noService && known) return { ok: false, need: 'enable-wireless', paired: true, identity: known.instance, hint: FAIL_HINT['no-service'] };
  // 查不到广播 ≠ 没配过对：容器网络隔离时也会这样，必须说两种可能并给手填出口
  if (noService) return { ok: false, need: 'manual-port', paired: false, reason: r.reason, hint: FAIL_HINT['manual-port'] };
  const notPaired = reason.includes('已存凭据') || reason === '无 psk';
  return { ok: false, need: 'pair', paired: !!known, reason: r.reason,
    hint: notPaired ? FAIL_HINT['not-paired'] : (FAIL_HINT[r.step] || FAIL_HINT.timeout) };
}

const bad = (error, hint) => ({ status: 400, body: { error, hint: hint || error } });
const isPrivateIPv4 = (h) => {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(h || ''))) return false;
  const [a, b] = String(h).split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
};

async function pairFlow({ host, pairPort, code, connPort, pinPort = 5555, log = () => {} }) {
  if (!isPrivateIPv4(host)) return bad('bad-host', '目标地址必须是局域网内 IPv4');
  const pp = Number(pairPort);
  if (!Number.isInteger(pp) || pp < 1 || pp > 65535) return bad('bad-pair-port', '配对端口请填 1-65535 的数字');
  if (!/^\d{6}$/.test(String(code || ''))) return bad('bad-code', '配对码是 6 位数字（电视第二屏上那串）');
  let p;
  try {
    p = await wireless.pair({ host, port: pp, code: String(code) });
  } catch (e) {
    log(`pair fail [${host}:${pairPort}] step=${e.step || 'unknown'} ${e.message}`);
    return bad(e.step || 'pairing', FAIL_HINT[e.step] || e.message);
  }
  let port = Number(connPort) || 0;
  if (!port) {
    const found = await mdns.connect(2000, host);
    const hit = found.find((f) => f.instance === p.identity) || found[0];
    if (hit) port = hit.port;
  }
  if (!port) { log(`pair ok, no conn port [${host}]`); return { status: 200, body: { ok: true, paired: p.identity, pinned: false, need: 'conn-port' } }; }
  try {
    const r = await wireless.pin({ host, port, identity: p.identity, psk: p.psk, pinPort });
    keystore.remember(p.identity, null, { peerHost: host, port });
    log(`pair ok [${host}] ${p.identity} pinned=${r.pinned}`);
    return { status: 200, body: { ok: true, paired: p.identity, pinned: r.pinned, pinPort, device: r.device, reply: r.text } };
  } catch (e) {
    log(`pair pinned fail [${host}:${port}] ${e.step || ''} ${e.message}`);
    return { status: 200, body: { ok: true, paired: p.identity, pinned: false, error: e.step, hint: FAIL_HINT[e.step] || e.message } };
  }
}

async function recoverFlow({ host, quick, pinPort = 5555, log = () => {} }) {
  if (host && !isPrivateIPv4(host)) return bad('bad-host', '目标地址必须是局域网内 IPv4');
  // NAT 容器里根本收不到广播：跑倒计时只会白等 90 秒，直接请用户填第一屏的连接端口
  if (host && !mdns.discoverable(host)) {
    const k = keystore.hintFor(host);
    return { status: 200, body: { ok: false, need: 'manual-port', paired: !!k, lastPort: k && k.port ? Number(k.port) : null, hint: FAIL_HINT['manual-port'] } };
  }
  const known = host ? keystore.hintFor(host) : null;
  const r = await wireless.recover({ host: host || undefined, pinPort, mdnsMs: quick ? 900 : 2000 });
  log(`recover ${r.ok ? 'ok' : (r.need || '?')} ${r.identity || ''} ${r.reason || ''}`);
  return { status: 200, body: recoverVerdict({ r, known }) };
}

async function discoverFlow({ host } = {}) {
  const discoverable = host ? mdns.discoverable(host) : true;   // 没给目标就无从判断，按可用处理（前端总会带 IP）
  const known = keystore.hintFor(host);
  const lastPort = known && known.port ? Number(known.port) : null;
  if (!discoverable) return { status: 200, body: { discoverable: false, lastPort, pairing: [], connect: [] } };
  const [pairing, connect] = await Promise.all([mdns.pairing(1800, host), mdns.connect(1800, host)]);
  const seen = new Set(keystore.list().map((x) => x.instance));
  return { status: 200, body: { discoverable: true, lastPort, pairing, connect: connect.map((c) => ({ ...c, paired: seen.has(c.instance) })) } };
}

module.exports = { FAIL_HINT, recoverVerdict, pairFlow, recoverFlow, discoverFlow, isPrivateIPv4 };
