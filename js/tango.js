import * as adb from './vendor/adb.js';
import * as stream from './vendor/stream-extra.js';
import CredentialStore from './vendor/adb-credential-web.js';
import { unzipSync } from './vendor/fflate.js';

// 桥地址：Pages 场景固定连本机 127.0.0.1:8765。
// 自托管形态（NAS/Docker）改为同源 + 前缀，前缀由服务端运行时注入，前端无构建期改写：
//   <meta name="boxadb-mode" content="selfhosted"> + <meta name="boxadb-prefix" ...>（容器为空）
export const selfHosted = typeof document !== 'undefined'
  && document.querySelector('meta[name="boxadb-mode"]')?.content === 'selfhosted';
const bridgePrefix = typeof document !== 'undefined'
  ? (document.querySelector('meta[name="boxadb-prefix"]')?.content || '') : '';
export const BRIDGE_BASE = selfHosted
  ? `${location.protocol}//${location.host}${bridgePrefix}`
  : 'http://127.0.0.1:8765';
const DEFAULT_PORT = 5555;                            // 固定端口，不进输入框
// 连不上时的提示按形态给：NAS/Docker 版根本没有「电脑上的桥接程序」这回事
const bridgeHint = selfHosted
  ? '请确认盒子已开机、与 NAS 在同一网络，并已开启网络调试'
  : '请确认电脑上的桥接程序正在运行（窗口别关），且盒子与本机在同一网络';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let handle = null; // { adb, closeSocket }

// 连接诊断：把「连不上」拆成浏览器侧能确定的四种情况，供 ?diag=1 面板显示。
// 依据是 WS 隧道有没有建立：没建立=端口没人监听/桥不可达；建立了但 adbd 立刻断开=
// 那个端口跑的是 TLS（无线调试）或不是 adbd。
const diag = { bridge: BRIDGE_BASE, target: '', kind: '', detail: '', tcpip: '' };
export function getDiag() { return Object.assign({}, diag); }

// ── 把 WebSocket 字节流包成 ADB 的包流 ───────────────
async function bridgeStream(host, port) {
  const wsUrl = BRIDGE_BASE.replace(/^http/, 'ws') +
    `/adb?host=${encodeURIComponent(host)}&port=${port}`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  let inbound = 0;                       // 入向字节：有来文＝adbd 在说话（多半是 AUTH，等用户点允许）
  let firstByte = -1;                    // 首字节判型：'C'/'A'＝明文 ADB 报文；0x14-0x17＝TLS 记录（加密端口）

  await new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { socket.close(); } catch {} const e = new Error('连接超时：' + bridgeHint); e.code = 'BRIDGE_TIMEOUT'; reject(e); }, 8000);
      socket.onopen = () => { clearTimeout(t); resolve(); };
      socket.onerror = () => { clearTimeout(t); const e = new Error('无法连接：' + bridgeHint); e.code = 'BRIDGE_UNREACHABLE'; reject(e); };
  });

  const readable = new ReadableStream({
    start(c) {
      socket.onmessage = e => {
        if (e.data instanceof ArrayBuffer) {
          if (firstByte < 0 && e.data.byteLength > 0) firstByte = new Uint8Array(e.data)[0];
          inbound += e.data.byteLength; c.enqueue(new Uint8Array(e.data));
        }
        else c.error(new Error('桥接返回了非二进制数据'));
      };
      socket.onerror = () => c.error(new Error('桥接连接错误'));
      socket.onclose = () => c.close();
    },
    cancel() { try { socket.close(); } catch {} },
  });
  const writable = new stream.MaybeConsumable.WritableStream({
    write(chunk) { if (socket.readyState !== WebSocket.OPEN) throw new Error('桥接已关闭'); socket.send(chunk); },
    close() { try { socket.close(); } catch {} },
    abort() { try { socket.close(); } catch {} },
  });

  return {
    connection: {
      readable: readable.pipeThrough(new stream.StructDeserializeStream(adb.AdbPacket)),
      writable: stream.pipeFrom(writable, new adb.AdbPacketSerializeStream()),
    },
    inbound: () => inbound,
    firstByte: () => firstByte,
    closeSocket: () => { try { socket.close(); } catch {} },
  };
}

// ── 连接（含 RSA 认证；首次要在盒子上允许调试）────────
export async function connect({ ip, port = DEFAULT_PORT, onStall, authTimeoutMs = 30000, stallMs = 8000 } = {}) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip || '')) throw new Error('请输入合法 IPv4，如 192.168.66.157');
  diag.target = ip + ':' + port; diag.kind = ''; diag.detail = ''; diag.tcpip = '';
  let stream;
  try {
    stream = await bridgeStream(ip, port);
  } catch (e) {
    diag.kind = e && e.code === 'BRIDGE_TIMEOUT' ? 'A-桥/端口无响应' : 'A-端口没人监听';
    diag.detail = String(e && e.message || e);
    throw e;
  }
  const { connection, closeSocket } = stream;
  // 对端首字节是 TLS 记录头（0x14-0x17）＝无线调试的加密端口，明文进不去
  const isTlsPeer = () => { const b = stream.firstByte ? stream.firstByte() : -1; return b >= 0x14 && b <= 0x17; };
  const tlsErr = () => { const err = new Error('这个端口只接受加密连接（无线调试），需要配对'); err.code = 'NEED_PAIRING'; return err; };
  let transport;
  try {
    // 认证本身最长等 30 秒（盒子弹窗要点允许）；但 8 秒内一个 ADB 报文都没有，
    // 几乎可以断定对端在等 TLS ClientHello —— 先给用户一句人话，别让他干等。
    const auth = adb.AdbDaemonTransport.authenticate({ serial: `${ip}:${port}`, connection, credentialStore: new CredentialStore('boxadb') });
    const first = await Promise.race([
      auth.then(() => 'ok', () => 'err'),
      new Promise(r => setTimeout(() => r('stall'), stallMs)),
    ]);
    // 关键区分：8 秒没结果，但期间**有报文往来** = adbd 已发了 AUTH、正等用户在盒子上点「允许」，
    // 这不是 TLS 端口、更不是失败；只有完全没来文才像 TLS 配对端口。
    if (first === 'stall') {
      // 加密端口最常见：要么回了 TLS 记录（首字节 0x14-0x17），要么干脆沉默。
      // 两种都立刻判「需要配对」，别让用户干等满 authTimeoutMs。
      if (isTlsPeer()) throw tlsErr();
      if (stream.inbound && stream.inbound() > 0) {
        diag.kind = 'D-明文可达，等盒子授权';
        diag.detail = `已收到 ${stream.inbound()} 字节：设备在等用户点「允许 USB 调试」`;
        if (onStall) { try { onStall('await-allow'); } catch {} }
      } else {
        diag.kind = 'C-端口无响应（疑似 TLS 配对端口）';
        diag.detail = `${stallMs / 1000} 秒内没有任何 ADB 报文：对端在等 TLS 握手，明文进不去`;
        if (onStall) { try { onStall('tls'); } catch {} }
        throw tlsErr();
      }
    }
    transport = await withTimeout(auth, authTimeoutMs, '还在等电视上的「允许 USB 调试」：点完允许再按一次连接即可');
  } catch (e) {
    closeSocket();
    // 明文报文被 TLS 端口拒掉时，解析流会先炸——首字节说了算，优先判加密端口
    if (isTlsPeer()) { diag.kind = 'C-端口只接受 TLS（无线调试配对类）'; diag.detail = String(e && e.message || e); throw tlsErr(); }
    const m = String(e?.message || e);
    if (/auth/i.test(m)) { diag.kind = 'D-明文可达，等盒子授权'; diag.detail = m; throw new Error('设备未授权：请在电视/盒子上点「允许 USB 调试」（勾上一律允许）后重试'); }
    // adbd 应答一下就断开：典型是端口上跑的是无线调试（TLS）而不是明文 ADB，或根本没开 5555
    if (/connection closed unexpectedly/i.test(m)) {
      diag.kind = 'C-端口只接受 TLS（无线调试配对类）'; diag.detail = m;
      const err = new Error('这台设备没在 5555 上监听'); err.code = 'NEED_PORT'; throw err;
    }
    // 其它断开类错误（配对端口常见）也按 TLS 处理，但原文照记，便于继续归类
    diag.kind = /closed|reset|EOF|unexpected/i.test(m) ? 'C-端口拒绝明文（配对端口常见）' : 'E-其它';
    diag.detail = m;
    throw e;
  }
  diag.kind = 'B-已连上（明文 ADB 可达）'; diag.detail = '';
  const a = new adb.Adb(transport);
  handle = { adb: a, closeSocket };
  _sdk = null;   // 换设备复位 SDK 缓存
  a.disconnected.then(() => { if (handle && handle.adb === a) handle = null; }, () => {});
  return { adb: a, closeSocket };
}

// ── USB 直连（WebUSB，仅 Chromium）─────────────────────
// 少数机型不便走 WiFi 桥时的兜底。关键前提：本机 adb server 会占着 USB 句柄，
// 浏览器要连之前必须先 `adb kill-server` 释放，否则 requestDevice 拿到也连不上。
export async function connectUsb() {
  if (!navigator.usb) throw new Error('当前浏览器不支持 USB 直连，请改用 Chrome / Edge');
  const { AdbDaemonWebUsbDeviceManager } = await import('./vendor/adb-daemon-webusb.js');
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  let device;
  try {
    device = await manager.requestDevice();
  } catch (e) {
    if (/busy|claim|open/i.test(String(e && e.message || e)))
      throw new Error('设备被占用：请先在终端运行 adb kill-server 释放后重试');
    throw new Error('未选择设备（已取消）');
  }
  if (!device) throw new Error('未选择设备（已取消）');
  const connection = await device.connect();   // WebUSB 的 connection 已是 ADB 包流，直接喂 authenticate
  let transport;
  try {
    transport = await withTimeout(
      adb.AdbDaemonTransport.authenticate({ serial: device.serial || 'usb', connection, credentialStore: new CredentialStore('boxadb') }),
      30000, '连接超时：请在盒子上允许 USB 调试'
    );
  } catch (e) {
    try { device.close(); } catch {}
    throw /auth/i.test(String(e?.message || e)) ? new Error('设备未授权：请在盒子弹窗点「允许 USB 调试」') : e;
  }
  const a = new adb.Adb(transport);
  handle = { adb: a, closeSocket: () => { try { device.close(); } catch {} } };
  _sdk = null;
  a.disconnected.then(() => { if (handle && handle.adb === a) handle = null; }, () => {});
  return { adb: a };
}

export function connected() { return !!handle; }

export async function disconnect() {
  if (!handle) return;
  const h = handle; handle = null; _sdk = null;
  try { await h.adb.close(); } catch {}
  try { h.closeSocket(); } catch {}
}

function requireAdb() { if (!handle) throw new Error('未连接设备'); return handle.adb; }

// 设备 Android SDK 级别（连接后惰性取一次并缓存；断开/换设备复位）。取不到返回 0。
let _sdk = null;
export async function deviceSdk() {
  if (_sdk != null) return _sdk;
  try {
    const s = (await shell('getprop ro.build.version.sdk')).trim();
    _sdk = parseInt(s, 10) || 0;
  } catch { _sdk = 0; }
  return _sdk;
}

// 让 adbd 自己切到固定端口（等价于电脑上的 adb tcpip 5555）：
// 走已建立的 ADB 通道，不需要 adb 二进制、不需要 root、不需要电脑参与。
// ── 无线调试配对：浏览器拿不到 TLS 客户端证书与导出密钥，只有桥能做 ──
async function api(path, body) {
  const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const r = await fetch(BRIDGE_BASE + path, init);
  const d = await r.json().catch(() => ({}));
  if (d && d.error) { const e = new Error(d.hint || d.error); e.code = d.error; e.step = d.error; throw e; }
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return d;
}
export const discoverWireless = (host) => api('/discover' + (host ? '?host=' + encodeURIComponent(host) : ''));
let wirelessProbe = null;
export function wirelessAvailable() {              // 桥是否真的实现了配对接口（桥没带配对组件 → 404 → 界面不出配对口）
  // 所有形态一律以探测为准，绝不按形态写死：Pages+桌面随包 Node 的桥同样支持配对。
  // 必须看到「发现结果的样子」才算支持：只看「没报错」会被 SPA 兜底（200 + index.html）骗出死控件
  if (!wirelessProbe) wirelessProbe = discoverWireless().then((d) => !!(d && Array.isArray(d.connect))).catch(() => false);
  return wirelessProbe;
}
export const pairWireless = (o) => api('/pair', o);
export const recoverWireless = (host, quick) => api('/recover', quick ? { host, quick: true } : { host });

export async function enableTcpip(port = DEFAULT_PORT) {
  const a = requireAdb();
  try {
    const r = await (a.tcpip && a.tcpip.enable ? a.tcpip.enable(port) : rawTcpip(a, port));
    diag.tcpip = '✓ adbd 应答：' + String(r).trim();
    return r;
  } catch (e) { diag.tcpip = '✗ 失败：' + String(e && e.message || e); throw e; }
}
async function rawTcpip(a, port) {
  const out = await a.createSocketAndWait(`tcpip:${port}`);
  if (!/restarting in TCP mode/i.test(String(out))) throw new Error(String(out || '切换失败'));
  return out;
}

// ── 底层：跑一条一次性 shell，返回文本输出 ──────────────
// 用 subprocess（shellProtocol 优先，其次 noneProtocol），命令结束流会关闭，
// 不会像 createSocket('shell:') 那样在某些 adbd 上不关流导致永久 await。
export async function shell(cmd) {
  const a = requireAdb();
  const sp = a.subprocess?.shellProtocol;
  const np = a.subprocess?.noneProtocol;
  try {
    if (sp) {
      const proc = await sp.spawn(cmd);
      try {
        const [out, err] = await Promise.all([collect(proc.stdout), collect(proc.stderr)]);
        await Promise.race([proc.exited, sleep(3000)]);
        const dec = new TextDecoder();
        return dec.decode(out) + (err && err.length ? dec.decode(err) : '');
      } finally { try { await proc.stdin?.close(); } catch {} }
    }
    if (np) {
      const proc = await np.spawn(cmd);
      try {
        const out = await collect(proc.output);
        await Promise.race([proc.exited, sleep(3000)]);
        return new TextDecoder().decode(out);
      } finally { try { await proc.stdin?.close(); } catch {} }
    }
    const sock = await a.createSocket('shell:' + cmd);
    try { return new TextDecoder().decode(await collect(sock.readable)); }
    finally { try { await sock.close(); } catch {} }
  } catch (e) {
    if (e && /abort|timeout/i.test(String(e.name||''))) return '';
    throw e;
  }
}

async function collect(readable) {
  const r = readable.getReader(); const parts = [];
  for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); }
  const size = parts.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(size); let p = 0; for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}

// ── 列应用：scope='third' 第三方（-3）/ 'system' 系统（-s）；顺带标记已禁用的包 ──
export async function listApps({ scope = 'third' } = {}) {
  const raw = await shell(`pm list packages ${scope === 'system' ? '-s' : '-3'}`);
  const pkgs = raw.split('\n').map(l => (l.match(/^package:(.+)$/) || [])[1]).filter(Boolean);
  let disabled = new Set();
  try {
    const d = await shell('pm list packages -d');
    disabled = new Set(d.split('\n').map(l => (l.match(/^package:(.+)$/) || [])[1]).filter(Boolean));
  } catch {}
  // 尽力补一个人类可读名：从包名尾段（真实图标/label 走 PackageManager dump，后续增强）
  return pkgs.map(pkg => ({ pkg, name: pkg.split('.').filter(Boolean).slice(-1)[0] || pkg, disabled: disabled.has(pkg) }));
}

export async function keyevent(code) { return shell(`input keyevent ${code}`); }

export async function launch(pkg) {
  const a = requireAdb();
  const out = await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  if (/no activities|no events|error|exception/i.test(out)) {
    // 回退：取 launcher activity 再 am start
    const act = (await shell(`cmd package resolve-activity --brief ${pkg}`)).split('\n').pop().trim();
    if (act && act.includes('/')) return shell(`am start -n ${act}`);
    throw new Error('无法启动该应用');
  }
  return out;
}
export async function forceStop(pkg) { return shell(`am force-stop ${pkg}`); }
export async function clearData(pkg)  { return shell(`pm clear ${pkg}`); }
export async function uninstall(pkg)  { return shell(`pm uninstall ${pkg}`); }

// 系统应用不能卸载，只能禁用（disable-user 对当前用户生效，无需 root，可随时 enable 恢复）
export async function disableApp(pkg) {
  const out = await shell(`pm disable-user --user 0 ${pkg}`);
  if (!/new state:\s*disabled/i.test(out)) throw new Error((out || '').trim() || '禁用失败：该应用可能受系统保护');
  return out;
}
export async function enableApp(pkg) {
  const out = await shell(`pm enable ${pkg}`);
  if (!/new state:\s*(enabled|default)/i.test(out)) throw new Error((out || '').trim() || '启用失败');
  return out;
}

// 用 exec: 服务跑一条命令并往其 stdin 写二进制（必须 exec:，shell: 会套 PTY 改坏字节）
async function shellWriteBytes(cmd, bytes) {
  const a = requireAdb();
  const sock = await a.createSocket('exec:' + cmd);
  try {
    const w = sock.writable.getWriter();
    await w.write(bytes);
    try { await w.close(); } catch {}
    const out = await collect(sock.readable);
    return new TextDecoder().decode(out);
  } finally { try { await sock.close(); } catch {} }
}

// 用 adb sync 把整段字节写到设备文件（obb 用；obb 必须落存储）
async function pushBytes(path, bytes, mtimeSec) {
  const a = requireAdb();
  const sync = await a.sync();
  try {
    const rs = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    await sync.write({ filename: path, file: rs, permission: 0o644, mtime: mtimeSec || Math.floor(Date.now() / 1000) });
  } finally { try { await sync.dispose(); } catch {} }
}

// ── ABI 预检：在把 APK 传给盒子之前先判断架构兼容性（32 位系统装 64 位包等）──
const KNOWN_ABIS = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86', 'x86_64', 'riscv64'];
const ABI_LABEL = {
  'arm64-v8a': '64 位 ARM（arm64-v8a）',
  'armeabi-v7a': '32 位 ARM（armeabi-v7a）',
  armeabi: '32 位 ARM（armeabi）',
  x86_64: '64 位 x86',
  x86: '32 位 x86',
  riscv64: 'RISC-V 64',
};
const abiLabel = a => ABI_LABEL[a] || a;

// 扫描 apk 字节里的 zip 条目名（不解压内容），收集它需要的 native ABI。
// 信号来源：lib/<abi>/ 目录、config.<abi>.apk split 文件名。
// 返回 Set（可能为空=无 native 代码）；包结构读不出来时返回 null（不拦截，交给设备裁决）。
export function apkRequiredAbis(bytes) {
  const found = new Set();
  try {
    unzipSync(bytes, { filter: f => {
      const n = f.name || '';
      if (n.startsWith('lib/')) {
        const d = n.split('/')[1];
        if (d && KNOWN_ABIS.includes(d)) found.add(d);
      }
      const cm = n.match(/(?:^|\/)config\.([a-z0-9_]+)\.apk$/i);
      if (cm) {
        const a = cm[1].replace(/_/g, '-');
        if (KNOWN_ABIS.includes(a)) found.add(a);
      }
      return false; // 只读目录，不 inflate 任何文件
    } });
  } catch { return null; }
  return found;
}

// 纯判断：required=包需要的 ABI 集合，deviceAbis=设备 abilist。
// 只要有一个 ABI 能对上就放行（universal 包在 32 位机可装）；完全对不上才拦。
export function decideAbiCompat(required, deviceAbis) {
  if (!required || !required.size) return { ok: true };
  if (!deviceAbis || !deviceAbis.length) return { ok: true };
  if ([...required].some(a => deviceAbis.includes(a))) return { ok: true };
  const is32Only = !deviceAbis.includes('arm64-v8a') && deviceAbis.some(a => a === 'armeabi-v7a' || a === 'armeabi');
  if (required.size === 1 && required.has('arm64-v8a') && is32Only) {
    return { ok: false, msg: '这个安装包是 64 位（arm64）版本，你的盒子是 32 位系统，装不了。请下载页面里标着「armeabi-v7a / 32 位」的版本' };
  }
  return { ok: false, msg: `架构不匹配：安装包需要 ${[...required].map(abiLabel).join(' 或 ')}，而盒子只支持 ${deviceAbis.map(abiLabel).join(' / ')}，无法安装` };
}

// 安装前统一预检（拿不到设备 abilist 时不拦截，避免误报）
async function checkAbiCompat(apks) {
  const required = new Set();
  for (const p of apks) {
    const a = apkRequiredAbis(p.bytes);
    if (!a) return; // 有包读不了结构：放行
    a.forEach(x => required.add(x));
  }
  if (!required.size) return;
  let deviceAbis = [];
  try {
    deviceAbis = (await shell('getprop ro.product.cpu.abilist')).trim().split(',').map(s => s.trim()).filter(Boolean);
  } catch { return; }
  const d = decideAbiCompat(required, deviceAbis);
  if (!d.ok) throw new Error(d.msg);
}

// 解析安装包 → { apks:[{name,bytes}], obbs:[{name,pkg,bytes}] }
async function parsePackage(file) {
  const lower = (file.name || '').toLowerCase();
  if (lower.endsWith('.apk')) {
    return { apks: [{ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }], obbs: [] };
  }
  if (lower.endsWith('.xapk') || lower.endsWith('.apkm')) {
    const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
    let manifestPkg = '';
    if (zip['manifest.json']) { try { manifestPkg = JSON.parse(new TextDecoder().decode(zip['manifest.json'])).pkg || ''; } catch {} }
    const apks = [], obbs = [];
    for (const [k, v] of Object.entries(zip)) {
      const lk = k.toLowerCase();
      if (lk.endsWith('.apk')) apks.push({ name: k.split('/').pop(), bytes: v });
      else if (lk.endsWith('.obb')) {
        const base = k.split('/').pop();
        const pkg = manifestPkg || (base.match(/\.(.+)\.obb$/) || [])[1] || '';
        obbs.push({ name: base, bytes: v, pkg });
      }
    }
    return { apks, obbs };
  }
  throw new Error('不支持的文件类型（仅支持 .apk / .xapk / .apkm）');
}

// ── 把 INSTALL_FAILED_* / 厂商限制翻成中文指引 ──
export function friendlyInstallError(raw) {
  const s = String(raw || '');
  if (/install_switch_flag|disabled .*from pm|by system default|not allowed to install|install .*disabled/i.test(s))
    return '这台电视（TCL / 雷鸟 / 海信等厂商机型）默认禁止安装第三方应用。请先到电视「设置 → 安全 / 未知来源 / 允许安装第三方应用」里打开再装；也可在下方「ADB 终端」执行 settings put global install_switch_flag 1 试试。';
  if (/INSTALL_FAILED_NO_MATCHING_ABIS|res=-113/i.test(s))
    return '这个应用的 CPU 架构和盒子不匹配（例如给 32 位盒子装了 64 位包），换对应版本再装。';
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(s))
    return '盒子存储空间不足，先清理一些应用或文件再装。';
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(s))
    return '已装过同名应用但签名不一致，需要先在盒子上卸载旧版本再装。';
  if (/INSTALL_FAILED_OLDER_SDK|minSdkVersion/i.test(s))
    return '这个应用要求的安卓版本比盒子当前系统更高，装不了。';
  if (/INSTALL_FAILED_ABORTED|user rejected|aborted/i.test(s))
    return '安装被取消了（盒子上的确认弹窗被拒绝或超时）。';
  return s;
}

// ── 安装：APK/XAPK/APKM/APKS，split + obb，流式（APK 不落地，pm install-create/write/commit）──
export async function installFile(file, onProgress) {
  const { apks, obbs } = await parsePackage(file);
  if (!apks.length) throw new Error((file.name || '包') + ' 里没有可安装的 .apk');
  await checkAbiCompat(apks);   // 传输前预检：32 位盒子装 64 位包等，直接用人话拦截
  // base 优先（简单启发式；install-write 一个会话内可含多 split）
  apks.sort((x, y) => (/base/i.test(x.name) ? 0 : 1) - (/base/i.test(y.name) ? 0 : 1));

  const total = apks.reduce((s, p) => s + p.bytes.length, 0) + obbs.reduce((s, o) => s + o.bytes.length, 0);
  let done = 0;
  const tick = n => { done += n; onProgress && onProgress(done, total); };
  const fail = t => /fail|error|exception/i.test(t) && !/success/i.test(t);

  // 安卓 5.0 以下（SDK<21）：没有 pm install 会话 API。
  // 只支持单 APK 的传统安装（推文件 + pm install -r）；XAPK/APKS/APKM 这类分包直接明确提示不支持。
  const sdk = await deviceSdk();
  if (sdk && sdk < 21) {
    if (apks.length > 1 || obbs.length) {
      throw new Error('这台设备系统较旧（Android 5.0 以下），不支持 XAPK/APKS/APKM 分包安装，请下载普通 .apk 版本');
    }
    return await legacyInstall(apks[0], tick, total);
  }

  const create = await shell('pm install-create -r');
  const m = create.match(/\[(\d+)\]/);
  if (!m) throw new Error(friendlyInstallError('创建安装会话失败：' + create.trim()));
  const sid = m[1];

  try {
    for (const p of apks) {
      const res = await shellWriteBytes(`pm install-write -S ${p.bytes.length} ${sid} ${p.name}`, p.bytes);
      tick(p.bytes.length);
      if (fail(res)) throw new Error(friendlyInstallError('写入 ' + p.name + ' 失败：' + res.trim()));
    }
    for (const o of obbs) {
      if (!o.pkg) continue;
      const dir = `/sdcard/Android/obb/${o.pkg}`;
      await shell(`mkdir -p ${dir}`);
      await pushBytes(`${dir}/${o.name}`, o.bytes);
      tick(o.bytes.length);
    }
    const commit = await shell(`pm install-commit ${sid}`);
    if (fail(commit)) throw new Error(friendlyInstallError('提交安装失败：' + commit.trim()));
    onProgress && onProgress(total, total);
    return (file.name || '包') + ' 安装完成';
  } catch (e) {
    shell(`pm install-abandon ${sid}`).catch(() => {});
    throw e;
  }
}

// 老设备（Android <5.0）传统安装：把 APK 推到 /data/local/tmp → pm install -r → 删除临时文件。
async function legacyInstall(apk, tick) {
  const tmp = `/data/local/tmp/boxadb-${Date.now()}.apk`;
  try {
    await pushBytes(tmp, apk.bytes);
    tick && tick(apk.bytes.length);
    const r = await shell(`pm install -r '${tmp}'`);
    if (!/Success/i.test(r)) throw new Error(friendlyInstallError('安装失败：' + (r || '').trim()));
    return (apk.name || '包') + ' 安装完成';
  } finally {
    try { await shell(`rm -f '${tmp}'`); } catch {}
  }
}

// ── 截图：先写设备文件再 sync 读回，避免 shell PTY 把二进制 \r\n 改坏 ──
export async function screenshot() {
  const a = requireAdb();
  const tmp = '/data/local/tmp/boxadb-shot.png';
  await shell(`screencap -p ${tmp}`);
  try {
    const sync = await a.sync();
    try { const bytes = await collect(sync.read(tmp)); return new Blob([bytes], { type: 'image/png' }); }
    finally { try { await sync.dispose(); } catch {} }
  } finally {
    // 无论成功/失败都删除盒子上的临时截图，避免占用存储
    try { await shell(`rm -f ${tmp}`); } catch {}
  }
}

// 取某个包的 base.apk 绝对路径（抽 manifest/arsc/图标文件用）
export async function baseApkPath(pkg) {
  const out = await shell(`pm path ${pkg}`);
  return (out || '').split('\n').map((s) => s.trim().replace(/^package:/, '')).find((s) => /base\.apk$/.test(s)) || null;
}

// 读设备上某个绝对路径文件的原始字节（复用截图同款 sync.read 二进制通道），返回 Uint8Array
export async function readFileBytes(devPath) {
  const a = requireAdb();
  const sync = await a.sync();
  try { return await collect(sync.read(devPath)); }
  finally { try { await sync.dispose(); } catch {} }
}

// 在设备上解析 APK(zip) 成员路径，返回“候选图标列表”（按分数降序，最多 8 个），供调用方逐个试抽。
// 每个 apk 的候选各自打分打印「score⇥apk⇥name」，外层 sort -rn 全局排序（跨 base 与 split）。
// 打分：base 仅作平手微加(+2)；ic_launcher/app_icon 精确名(+10)；banner 是 TV 宽幅图，不当方形图标重罚(-12)；
// 前景/背景层罚(-15)；密度靠近 xhdpi/xxhdpi 加分。返回 [{apk,member}, ...]（无则空数组）。
export async function pickIconMembers(pkg) {
  const script =
    "for f in $(pm path " + pkg + " | tr -d '\\r' | sed 's/^package://'); do " +
    "unzip -l \"$f\" 2>/dev/null | grep -E 'res/(mipmap|drawable)[^ ]*/.*\\.(png|webp)$' | awk -v A=\"$f\" " +
    "'{n=$NF;split(n,pp,\"/\");b=pp[length(pp)];s=(A ~ /base\\.apk$/)?2:0;" +
    "if(n ~ /\\/mipmap/)s=s+3;" +
    "if(b ~ /^(ic_launcher|app_icon|ic_app|icon)\\.(png|webp)$/)s=s+12;else if(b ~ /launcher|app_icon/)s=s+8;" +
    "if(b ~ /banner/)s=s-12;if(b ~ /(foreground|background|_fg|_bg)/)s=s-15;" +
    "if(b ~ /facebook|notify|notification|abc_|ic_star|button|splash|panel|share|send|search|ic_menu|spinner|progress|checkbox|radiobutton|textfield|textfield/)s=s-25;" +
    "d=-1;if(n ~ /xxxhdpi/)d=5;else if(n ~ /xxhdpi/)d=4;else if(n ~ /xhdpi/)d=3;else if(n ~ /tvdpi/)d=3;else if(n ~ /hdpi/)d=2;else if(n ~ /mdpi/)d=1;" +
    "if(d==3||d==4)s=s+8;else if(d==5)s=s+3;else if(d==2)s=s+4;else if(d==1)s=s+1;s=s+$1/1000000;" +
    "print s\"\\t\"A\"\\t\"n}' ; done | sort -rn | head -8";
  const out = await shell(script);
  const list = [];
  for (const line of (out || '').split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length >= 3 && parts[2]) list.push({ apk: parts[1], member: parts[2] });
  }
  return list;
}

// 从 APK 里抽取指定成员字节：设备上 unzip -p 落到唯一临时文件 → sync.read 回传 → rm。
// 走“设备落地文件 + sync 二进制读”，二进制不经过 shell stdout，规避 PTY/换行破坏。
// tmp 必须每次唯一：懒加载并发=2，共用固定名会交叉读写导致“串图标”。
let _icSeq = 0;
export async function extractZipMember(apkPath, memberPath) {
  const tmp = '/data/local/tmp/boxadb-ic-' + Date.now().toString(36) + '-' + (_icSeq++).toString(36) + '.tmp';
  try {
    await shell(`unzip -p '${apkPath}' '${memberPath}' > '${tmp}' 2>/dev/null; :`);
    const bytes = await readFileBytes(tmp);
    return (bytes && bytes.length) ? bytes : null;
  } finally {
    try { await shell(`rm -f '${tmp}'`); } catch {}
  }
}

export async function reboot(mode = '') {
  const a = requireAdb();
  if (!mode) { await shell('reboot'); return; }
  if (!/^[a-z]+$/.test(mode)) throw new Error('非法的重启模式');
  const sock = await a.createSocket('reboot:' + mode);
  try { await sock.close(); } catch {}
}

// ── 设备信息（含 CPU / 架构 / 分辨率的取数逻辑）──────
export async function fetchDevice(ip) {
  const gp = async k => (await shell('getprop ' + k)).trim();
  const safe = async (fn, dflt) => { try { return await fn(); } catch { return dflt; } };

  const brand = (await safe(async () => gp('ro.product.brand'), '')) || (await safe(async () => gp('ro.product.manufacturer'), '')) || '未知';
  const model = (await safe(async () => gp('ro.product.model'), '')) || '未知';
  const release = await safe(async () => gp('ro.build.version.release'), '');
  const sdk = await safe(async () => gp('ro.build.version.sdk'), '');
  const abilist64 = await safe(async () => gp('ro.product.cpu.abilist64'), '');
  const arch = abilist64 ? '64 位' : '32 位';
  let cpu = await safe(() => detectCpu(), '未知');
  let resolution = '未知';
  const resM = (await safe(async () => shell('wm size'), '')).match(/(\d+)x(\d+)/); if (resM) resolution = `${resM[1]} × ${resM[2]}`;
  const osName = release ? `Android ${release}${sdk ? '（SDK ' + sdk + '）' : ''}` : '未知';

  // 存储
  let storageText = '—', storagePct = 0;
  await safe(async () => {
    // 优先 dumpsys diskstats（A11+ 非 root 也能读），失败再回退 df
    let p = parseDiskstats(await shell('dumpsys diskstats 2>/dev/null'));
    if (!p) p = parseDf(await shell('df /data 2>/dev/null || df /data/media 2>/dev/null || df'));
    if (p) { storageText = `已用 ${fmtKB(p.used)} / 共 ${fmtKB(p.total)}（剩 ${fmtKB(p.avail)}）`; storagePct = p.pct; }
  }, null);

  // 内存
  let mem = '—';
  await safe(async () => {
    const m = parseMeminfo(await shell('cat /proc/meminfo'));
    if (m) mem = `可用 ${fmtKB(m.avail)} / 共 ${fmtKB(m.total)}`;
  }, null);

  // 已装第三方应用数
  let appCount = '—';
  await safe(async () => {
    const n = (await shell('pm list packages -3')).split('\n').filter(l => l.startsWith('package:')).length;
    appCount = n + ' 个';
  }, null);

  // 运行时长
  let uptime = '—';
  await safe(async () => {
    const s = parseFloat((await shell('cat /proc/uptime')).trim().split(/\s+/)[0]);
    if (Number.isFinite(s)) uptime = fmtUptime(s);
  }, null);

  // GPU（多来源兜底：GLES/Vulkan 行 → ro.hardware.vulkan/egl 家族）
  let gpu = '未知';
  await safe(async () => {
    let name = parseGpu(await shell('dumpsys SurfaceFlinger 2>/dev/null | grep -iE "GLES:|Vulkan:" | head -1'));
    if (!name) {
      const fam = (await gp('ro.hardware.vulkan')) || (await gp('ro.hardware.egl')) || '';
      const f = fam.toLowerCase();
      if (/mali|bifrost|valhall|panfrost/.test(f)) name = 'Mali' + (f !== 'mali' ? ` (${fam})` : '');
      else if (/adreno/.test(f)) name = 'Adreno' + (f !== 'adreno' ? ` (${fam})` : '');
      else if (/powervr|pvrusd|rogue/.test(f)) name = 'PowerVR';
      else if (fam) name = fam;
    }
    if (name) gpu = name;
  }, null);

  return { brand, model, android: osName, cpu, arch, resolution,
           gpu, mem, appCount, uptime, storageText, storagePct,
           addr: `${ip}:${DEFAULT_PORT}` };
}

// —— 标准 Android 输出的解析/格式化（防御式）——
function tokKB(t){ const m=t.match(/^(\d+(?:\.\d+)?)([KMGT]?)B?$/i); if(!m) return null;
  const mult={ '':1,K:1,M:1024,G:1048576,T:1073741824 }[m[2].toUpperCase()]; return Math.round(parseFloat(m[1])*mult); }
function parseDf(out){
  for(const raw of (out||'').split('\n')){ const line=raw.trim(); if(!line||/Filesystem/i.test(line)) continue;
    const tk=line.split(/\s+/); const kb=tk.map(tokKB).filter(x=>x!=null&&x>0); const pm=tk.find(t=>/^\d+%$/.test(t));
    if(kb.length>=3){ const [total,used,avail]=kb; const pct=pm?parseInt(pm):Math.round(used/total*100); return {total,used,avail,pct}; } }
  return null; }
function parseDiskstats(out){ const f=(out||'').match(/Data-Free:\s*(\d+)/); const t=(out||'').match(/Data-Total:\s*(\d+)/);
  if(!f||!t) return null; const totalB=+t[1], freeB=+f[1], usedB=Math.max(0,totalB-freeB);
  return { total:Math.round(totalB/1024), used:Math.round(usedB/1024), avail:Math.round(freeB/1024), pct: totalB?Math.round(usedB/totalB*100):0 }; }
function parseMeminfo(out){
  const v={}; for(const line of (out||'').split('\n')){ const m=line.match(/^(\w+):\s+(\d+) kB/); if(m) v[m[1]]=+m[2]; }
  if(!v.MemTotal) return null;
  const avail = v.MemAvailable != null ? v.MemAvailable : (v.MemFree||0)+(v.Buffers||0)+(v.Cached||0);
  return { total:v.MemTotal, avail }; }
function fmtKB(kib){ if(!Number.isFinite(kib)||kib<=0) return '—';
  if(kib>=1048576) return (kib/1048576).toFixed(kib>=10485760?0:1)+' GB';
  if(kib>=1024) return Math.round(kib/1024)+' MB'; return kib+' KB'; }
function fmtUptime(sec){ const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);
  if(d>0) return `${d} 天 ${h} 小时`; if(h>0) return `${h} 小时 ${m} 分`; return `${m} 分钟`; }
function parseGpu(out){ const m=(out||'').match(/(?:GLES|Vulkan):\s*(.+)/i); if(!m) return '';
  const parts=m[1].split(',').map(s=>s.trim()).filter(Boolean); return parts[1]||parts[0]||''; }

// CPU 探测链（4 步，老设备也能出家族级结果）：
//  1) ro.soc.model（Android 12+ 精确型号）
//  2) /proc/device-tree/compatible（较新盒子常有 amlogic,s905x5m 之类）
//  3) ro.hardware / ro.boot.hardware（老设备定厂商家族，如 mstar/amlogic/mt58xx…）
//  4) ro.board.platform + /proc/cpuinfo 的 Hardware: 行（抠具体料号，如 MSD6A838）
async function detectCpu() {
  const gp = async (k) => { try { return (await shell('getprop ' + k)).trim(); } catch { return ''; } };
  let c = prettyCpu(await gp('ro.soc.model'));
  if (c) return c;
  let dts = '';
  try { dts = (await shell(`cat /proc/device-tree/compatible 2>/dev/null | tr '\\0' ' '`)).trim(); } catch {}
  c = prettyCpu(dts); if (c) return c;
  const hw = (await gp('ro.hardware')) || (await gp('ro.boot.hardware'));
  const board = await gp('ro.board.platform');
  let cpuHw = '';
  try { const ci = await shell('cat /proc/cpuinfo'); const mm = ci.match(/Hardware\s*:\s*(.+)/i); if (mm) cpuHw = mm[1].trim(); } catch {}
  const fam = familyOf(hw) || familyOf(board) || familyOf(cpuHw);
  if (fam) {
    const part = partOf(hw, fam) || partOf(board, fam) || partOf(cpuHw, fam);
    return part ? fam + ' ' + part : fam;
  }
  return board || cpuHw || hw || '未知';
}
// 厂商家族识别（顺序敏感：MStar 的 msd/mstar 先于 MediaTek，避免 MT58xx 误判）
const CPU_FAMILY = [
  [/mstar|\bmsd\d|mi3\b/i, 'MStar'],
  [/amlogic|meson|aml|g12[ab]|gxbb|tx[35]|s9\d\d/i, 'Amlogic'],
  [/hisilicon|\bhi3[57]\d|bigfish|\bhi37\d|v[0-9]00\b/i, '海思'],
  [/mediatek|\bmtk\b|\bmt5[0-9]{3}/i, 'MediaTek'],
  [/rockchip|\brk3?\d/i, 'Rockchip'],
  [/allwinner|\bsun[5-9]i|\bsun8|\bsun50/i, 'Allwinner'],
  [/novatek|\bnt\d{3,4}/i, 'Novatek'],
  [/broadcom|\bbcm\d/i, 'Broadcom'],
  [/\bqcom|\bmsm\d|(?<![a-z])sm\d{3}|sdm\d/i, 'Qualcomm'],
];
function familyOf(s) { if (!s) return ''; for (const [re, name] of CPU_FAMILY) if (re.test(s)) return name; return ''; }
// 从字符串里抠具体料号（如 MSD6A838 / S905X5M / MT5872 / RK3288 / Hi3798M）
function partOf(s, fam) {
  if (!s) return '';
  let m;
  switch (fam) {
    case 'MStar':     m = s.match(/(msd|mt)\s?([0-9][a-z0-9]{2,})/i); return m ? (m[1].toUpperCase() + m[2].toUpperCase()) : '';
    case 'Amlogic':   m = s.match(/s9\d\d[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case 'MediaTek':  m = s.match(/mt\d{3,5}[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case '海思':      m = s.match(/hi3[57]\d[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case 'Rockchip':  m = s.match(/rk\d[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case 'Allwinner': m = s.match(/sun[5-9][a-z0-9]*/i); return m ? m[0].toLowerCase() : '';
    case 'Novatek':   m = s.match(/nt\d{3,4}[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case 'Broadcom':  m = s.match(/bcm\d{4}[a-z0-9]*/i); return m ? m[0].toUpperCase() : '';
    case 'Qualcomm':  m = s.match(/(msm\d[a-z0-9]*|sm\d{3}[a-z0-9]*|sdm\d{3}[a-z0-9]*)/i); return m ? m[1].toUpperCase() : '';
    default: return '';
  }
}
// 给定任意原始串，输出“厂商 [料号]”；认不出返回 ''（由上层决定回退）
function prettyCpu(s) {
  if (!s) return '';
  const fam = familyOf(s);
  if (!fam) return '';
  const part = partOf(s, fam);
  return part ? fam + ' ' + part : fam;
}

// ── 交互 PTY（供 xterm 终端）；返回 pty：有 .output/.input 流、resize(rows,cols)、exited、kill ──
export async function openPty() {
  const a = requireAdb();
  // 优先真 PTY（需 adbd 支持 shell,V2 —— Android 5.0+）。老设备（约 4.4 及更早）没有 shellProtocol，
  // 直接读 .pty 会抛 undefined 错，所以必须先判存在再用。
  const sp = a.subprocess?.shellProtocol;
  if (sp && typeof sp.pty === 'function') {
    try { return await sp.pty({ terminalType: 'xterm-256color' }); } catch { /* 落到经典通道 */ }
  }
  // 回退：经典 shell: 通道（所有 adb 版本都有，adbd 侧仍分配 tty，可交互，仅不支持窗口 resize）。
  const sock = await a.createSocket('shell:');
  return {
    classic: true,
    output: sock.readable,
    input: sock.writable,
    resize() {},                 // 经典通道无 PTY，resize 空实现即可
    async kill() { try { await sock.close(); } catch {} },
  };
}

function withTimeout(promise, ms, msg) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}
