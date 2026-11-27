'use strict';
import * as BoxTerm from './terminal.js';
import * as Icons from './icons.js';
// 诊断数据出口：app.js 不直接 import tango（它是懒加载的），这里挂一个取数函数
let __diagGetter = null; window.__boxadbDiag = () => (__diagGetter ? __diagGetter() : Promise.resolve({}));

// 自托管形态（Docker / 飞牛）由服务端注入该 meta；此形态下桥在 NAS 上，USB 入口不渲染。
const SELF_HOSTED = !!document.querySelector('meta[name="boxadb-mode"][content="selfhosted"]');
// 诊断面板：只有 URL 带 ?diag=1 才出现，正常使用时界面里完全看不到
const DIAG = typeof location !== 'undefined' && location.search.includes('diag=1');

const state = {
  connected: false,
  connecting: false,
  demo: false,
  device: null,
  ip: '',
  prefs: {},
  appsScope: 'third', // 应用管理分组：third 第三方 / system 系统
};

// ── 小工具（function 声明，避免顶层调用时的 TDZ）────────
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadPrefs() { try { return JSON.parse(localStorage.getItem('boxadb') || '{}'); } catch { return {}; } }
function savePrefs() { try { localStorage.setItem('boxadb', JSON.stringify(state.prefs)); } catch {} }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function formatBytes(n){ const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return n.toFixed(n<10&&i?1:0)+' '+u[i]; }
function hue(str){ let h=0; for(let i=0;i<(str||'').length;i++) h=(h*31+str.charCodeAt(i))>>>0; return `hsl(${h%360} 50% 34%)`; }
function toast(msg, kind='info', ms=2800){ const el=document.createElement('div'); el.className='toast'+(kind!=='info'?' '+kind:''); el.textContent=msg; $('#toasts').appendChild(el); setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .2s';},ms-200); setTimeout(()=>el.remove(),ms); }

// 全屏等待倒计时：大圆环 + 秒数 + 文案；连上、取消或超时即收
const CD_LEN = 339.29;                       // 2πr，r=54
function showCountdown(totalSec, lines, onCancel) {
  const mask = $('#pair-countdown'); if (!mask) return { close: () => {}, left: () => 0 };
  const ta = $('#cd-text-a'), tb = $('#cd-text-b'), num = $('#cd-num'), bar = $('#cd-bar'), btn = $('#cd-cancel');
  if (ta) ta.textContent = (lines && lines[0]) || '请在电视上打开';
  if (tb) tb.textContent = (lines && lines[1]) || '「无线调试」开关';
  let left = totalSec;
  const paint = (s) => { num.textContent = String(s); bar.style.strokeDashoffset = String(CD_LEN * (1 - s / totalSec)); };
  paint(left);
  mask.hidden = false;
  // 秒数由遮罩自己的心跳驱动：探测/握手再慢也不该让它定格
  const timer = setInterval(() => { if (left > 1) { left--; paint(left); } else close(); }, 1000);
  function close() { clearInterval(timer); mask.hidden = true; if (btn) btn.onclick = null; }
  if (btn) btn.onclick = () => onCancel && onCancel();
  return { close, left: () => left };
}

// ── 惰性加载传输层 ─────────────────────────────────────
let _t = null;
async function tango() { if (!_t) { _t = await import('./tango.js'); if (_t.getDiag) __diagGetter = () => _t.getDiag(); } return _t; }

// ── 假设备（仅 ?demo=1 预览用）─────────────────────────
function demoDevice(ip='192.168.66.172'){ return { brand:'ONN', model:'ONN Google TV (Android 14)', android:'Android 14（SDK 34）', cpu:'Amlogic S905X4', gpu:'Mali-G31', arch:'64 位', mem:'可用 1.2 GB / 共 2.9 GB', resolution:'3840 × 2160', appCount:'18 个', uptime:'2 天 6 小时', storageText:'已用 4.1 GB / 共 11 GB（剩 6.9 GB）', storagePct:37, addr:`${ip}:5555` }; }
const DEMO_APPS = [
  { pkg:'com.netflix.ninja', name:'Netflix' }, { pkg:'com.google.android.youtube.tv', name:'YouTube' },
  { pkg:'tv.pluto.android', name:'Pluto TV' }, { pkg:'org.xbmc.kodi', name:'Kodi' },
  { pkg:'com.spotify.tv.android', name:'Spotify' }, { pkg:'com.plexapp.android', name:'Plex' },
];
const DEMO_SYSTEM_APPS = [
  { pkg:'com.android.settings', name:'设置' }, { pkg:'com.android.systemui', name:'系统界面' },
  { pkg:'com.google.android.tv', name:'电视服务' }, { pkg:'com.android.bluetooth', name:'蓝牙' },
  { pkg:'com.google.android.gms', name:'Google 服务', disabled:true }, { pkg:'com.android.providers.media', name:'媒体存储' },
];

// ── 顶栏 & 连接 ────────────────────────────────────────
function renderStatus() {
  const pill=$('#status-pill'), btn=$('#connect-btn');
  if (state.connecting)     { pill.className='pill busy'; pill.textContent=state.demo?'演示中':'连接中…'; btn.textContent='断开'; btn.disabled=true; }
  else if (state.connected) { pill.className='pill on';   pill.textContent=state.demo?'演示中':'已连接';   btn.textContent='断开'; btn.disabled=state.demo; }
  else                      { pill.className='pill off';  pill.textContent='未连接'; btn.textContent='连接'; btn.disabled=false; }
  renderDeviceInfo();
  if (typeof updateSummary==='function') updateSummary();
}
function renderDeviceInfo(){
  const d=state.device;
  const set=(id,v)=>{const e=$(id); if(e) e.textContent=v;};
  set('#i-model',d?.model??'—'); set('#i-brand',d?.brand??'—'); set('#i-android',d?.android??'—');
  set('#i-cpu',d?.cpu??'—'); set('#i-gpu',d?.gpu??'—'); set('#i-arch',d?.arch??'—');
  set('#i-mem',d?.mem??'—'); set('#i-res',d?.resolution??'—');
  set('#i-appcount',d?.appCount??'—'); set('#i-uptime',d?.uptime??'—');
  set('#i-storage',d?.storageText??'—');
  const pct=(d&&d.storagePct)||0;
  const pctEl=$('#i-storage-pct'); if(pctEl) pctEl.textContent=d?`· 已用 ${pct}%`:'';
  const bar=$('#i-storage-bar'); if(bar){ bar.style.width=Math.min(100,pct)+'%'; bar.style.background=pct>90?'var(--danger)':(pct>70?'var(--warn)':'var(--accent)'); }
}
async function doConnect() {
  if (state.demo) return;
  // crypto.subtle 只在安全上下文（https 或 localhost）可用——没有它无法生成 ADB 密钥
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle)) {
    showInsecureDialog(); return;
  }
  if (state.connected) { const T=await tango(); await T.disconnect(); BoxTerm.closeSession(); Icons.reset(); state.connected=false; state.device=null; renderStatus(); toast('已断开','warn'); return; }
  const ip=$('#device-ip').value.trim();
  state.ip=ip; state.prefs.ip=ip; savePrefs();
  state.connecting=true; renderStatus();
  try {
    const T=await tango();
    await T.connect({ ip });
    state.device=await T.fetchDevice(ip);
    state.connected=true;
    toast(`已连接：${state.device.brand} ${state.device.model}`);
    renderDiag();
  } catch (err) {
    renderDiag();
    // 端口不对的几种表现都给一次机会：A=5555 没人监听，C=有应答但不是明文 ADB，T=明文撞进加密端口
    if (err && (err.code === 'NEED_PORT' || err.code === 'NEED_PAIRING' || err.code === 'BRIDGE_UNREACHABLE')) {
      if (await autoRecover(ip)) return;          // 以前配过对：静默把端口钉回来，不打扰用户
      showPortDialog(ip, err.code === 'NEED_PAIRING' ? 'NEED_PORT' : err.code); return;
    }
    toast('连接失败：'+err.message,'err',4200);
  } finally { state.connecting=false; renderStatus(); if (state.connected) refreshApps(); }
}

// ── 把调试端口固定回 5555：先试已存凭据自愈，不行再让用户填电视上的两屏 ──
async function finishConnect(T, ip, msg) {
  await T.connect({ ip, authTimeoutMs: 90000, onStall: (why) => handleStall(why, {}) });
  state.device = await T.fetchDevice(ip); state.connected = true;
  renderDiag();
  toast(msg || '已连接');
  return true;
}

async function autoRecover(ip) {
  if (!(await pairAvailable())) return false;
  let r;
  try { r = await (await tango()).recoverWireless(ip); } catch { return false; }
  if (r && r.ok) {
    try { return await finishConnect(await tango(), ip, '已自动恢复端口并连上，不用重新配对'); }
    catch { return false; }
  }
  if (r && r.need === 'enable-wireless') return waitWirelessOn(ip, r.hint);
  lastRecover = r && r.need === 'manual-port' ? r : null;
  return false;
}

const WAIT_SEC = 90;
let waitGen = 0;
async function waitWirelessOn(ip, hint) {
  const my = ++waitGen;
  let cancelled = false;
  const ctl = showCountdown(WAIT_SEC, null, () => { cancelled = true; waitGen++; ctl.close(); });
  const T = await tango();
  const stopAt = Date.now() + WAIT_SEC * 1000;
  let busy = false;
  while (!cancelled && waitGen === my && Date.now() < stopAt) {
    if (!busy) {
      busy = true;
      let r2 = null;
      try { r2 = await T.recoverWireless(ip, true); } catch {}
      busy = false;
      if (cancelled || waitGen !== my) break;
      if (r2 && r2.ok) {
        ctl.close();
        toast('检测到无线调试已打开，正在自动固定端口…', 'info', 2600);
        try { return await finishConnect(T, ip, '已自动固定并连上，全程没用到配对码'); } catch { return false; }
      }
      if (r2 && r2.need === 'pair') { ctl.close(); return false; }   // 确实没配过对 / 凭据失效 → 才弹表单
    }
    await new Promise(r => setTimeout(r, 2000));   // 探测节奏 2 秒；秒数由遮罩自己的心跳走
  }
  ctl.close();
  if (cancelled || waitGen !== my) return true;                    // 用户取消 / 已交给新一轮，不再多嘴
  toast('还没检测到盒子的无线调试：确认开关已打开后，再点一次连接', 'warn', 9000);
  return true;
}

// 桥说「没发现无线调试服务」＝十有八九是盒子刚重启，开关自己关了；这种别让用户去输配对码
function needsWirelessOn(hint) {
  if (!hint) return;
  toast(hint, 'warn', 12000);
}

// stall 分两类：有来文＝在等你点「允许」（显示状态块，别报失败）；完全没来文＝疑似 TLS 配对端口
function handleStall(why, ctx = {}) {
  const stall = ctx.stall, m = ctx.m;
  if (why === 'await-allow') {
    const allow = $('#pair-allow');
    if (m && !m.hidden && allow) { allow.hidden = false; allow.scrollIntoView({ block: 'nearest' }); }
    toast('设备已应答，正在等你在电视上点「允许 USB 调试」…', 'warn', 9000);
    return;
  }
  if (stall && m && !m.hidden) stall.hidden = false;
  toast('这个端口是加密端口（无线调试），需要配对', 'warn', 6000);
}

let pairCap = null;
let lastRecover = null;   // 容器等查不到广播的环境：把「请填连接端口」带到弹窗上
// 配对能力以桥的实际应答为准（/discover 404＝这个桥没有配对组件，入口自动隐藏）。
// 不再按形态写死：桌面 Pages + 随包 Node 的桥同样能配对。
async function pairAvailable() {
  if (pairCap === null) { try { pairCap = await (await tango()).wirelessAvailable(); } catch { pairCap = false; } }
  return pairCap;
}

async function showPortDialog(ip, reason){
  const m=$('#port-modal'); if(!m) return;
  const title=$('#port-title'), desc=$('#port-desc');
  const inp=$('#port-input'), hint=$('#port-modal-ip'), ok=$('#port-ok'), cancel=$('#port-cancel');
  const pinp=$('#pair-port-input'), cinp=$('#pair-code-input');
  const pg=$('#pair-group'), det=$('#port-detect'), note=$('#pair-note');
  const canPair = await pairAvailable();
  if (pg) pg.hidden = !canPair;
  if (note) note.hidden = !canPair;
  let disc = null;
  if (canPair) { try { disc = await (await tango()).discoverWireless(ip); } catch { disc = null; } }
  // NAT 容器里查不到广播：这个按钮只会让人白点，直接不显示
  if (det) det.hidden = !canPair;
  if(title) title.textContent = reason !== 'NEED_PORT' ? '这台设备的 5555 端口没有反应'
    : (canPair ? '这个端口不接受明文连接，需要配对' : '这个端口只接受加密连接');
  if (desc && lastRecover && lastRecover.hint) desc.innerHTML = lastRecover.hint;
  else if(desc) desc.innerHTML = reason !== 'NEED_PORT'
    ? '多数是重启后调试端口变成了随机值（安卓 11 以上的电视常见）。填 ① 就能连；要是提示需要配对，再补 ②。我连上后会<b>自动固定成 5555</b>，以后只填 IP 就能连。'
    : (canPair
        ? '端口上确实有服务，但它是安卓 11+「无线调试」的加密端口。把<b>第二屏</b>的配对端口和 6 位配对码填到 ②，我配完对会<b>自动固定成 5555</b>；以后重启也只要开着无线调试就行。'
        : '端口上确实有服务，但它是安卓 11+「无线调试」的加密端口，明文进不去。<b>当前这个版本（连的是本机/容器里的桥）还不能配对</b>：请先用电脑执行一次 <code>adb tcpip 5555</code> 把盒子端口固定下来，之后回到这里只填 IP 就能连。');
  if(hint) hint.textContent = ip;
  if(inp) inp.value = ''; // 绝不自动预填端口
  if(pinp) pinp.value = '';
  if(cinp) cinp.value = '';
  if(ok) ok.textContent = canPair ? '连接并固定端口' : '连接并固定端口';
  const stall=$('#port-stall'); if(stall) stall.hidden = true;
  m.hidden=false;
  const first = canPair && !(inp && inp.value) ? inp
    : (canPair && cinp && !cinp.value ? cinp : inp);
  if (first) setTimeout(()=>first.focus(), 60);
  if(cancel) cancel.onclick=()=>{ m.hidden=true; };
  if(det) det.onclick=async ()=>{
    det.disabled=true; const t0=det.textContent; det.textContent='查找中…';
    try{
      const T=await tango(); const d=await T.discoverWireless((state.ip || $('#device-ip').value || '').trim());
      const c=(d.connect||[])[0], pp=(d.pairing||[])[0];
      if(c&&inp&&!inp.value) inp.value=c.port;
      if(pp&&pinp) pinp.value=pp.port;
      toast(c ? `已自动填入：连接端口 ${c.port}${pp ? '、配对端口 ' + pp.port : ''}${c.paired ? '（这台配过对，② 留空即可）' : ''}` : '没查到无线调试广播：请确认电视上「无线调试」已打开，或手填端口');
      if (disc && disc.discoverable === false) toast('当前网络环境查不到局域网广播，请手填端口', 'warn', 6000);
    }catch(e){ toast('自动查找失败：'+(e&&e.message||e),'err',6000); }
    finally{ det.disabled=false; det.textContent=t0; }
  };
  if(!ok) return;
  ok.onclick=async ()=>{
    const port=Number((inp && inp.value || '').trim());
    const pairPort=Number((pinp && pinp.value || '').trim());
    const code=(cinp && cinp.value || '').trim();
    const wantPair = canPair && (pairPort>0 || code.length>0);
    if (wantPair){
      if(!(Number.isInteger(pairPort)&&pairPort>0&&pairPort<=65535)){ toast('配对端口请填 1-65535 的数字','warn'); return; }
      if(!/^\d{6}$/.test(code)){ toast('配对码是 6 位数字（电视第二屏上那串）','warn'); return; }
    } else if(!Number.isInteger(port) || port<1 || port>65535){ toast('端口请填 1-65535 的数字','warn'); return; }
    ok.disabled=true; ok.textContent='处理中…';
    const stall=$('#port-stall');
    try{
      const T=await tango();
      if (wantPair){
        const r=await T.pairWireless({ host:ip, pairPort, code, connPort:(Number.isInteger(port)&&port>0)?port:undefined });
        if (r.need==='conn-port') { toast('配对成功了，但没找到连接端口：请把 ① 的端口填上再提交一次','warn',8000); if(stall) stall.hidden=true; return; }
        if (!r.pinned) toast(r.hint || '已配对，但端口没固定成功，正在尝试直接连接','warn',7000);
      } else {
        await T.connect({ ip, port, onStall: (why) => handleStall(why, { stall, m }) });
        await T.enableTcpip(5555);
        await T.disconnect();
      }
      // 首次用本页面的钥匙连 5555，设备会弹「允许 USB 调试」：这不是失败，等用户点即可（给足 90 秒）
      await T.connect({ ip, authTimeoutMs: 90000, onStall: (why) => handleStall(why, { stall, m }) });
      state.device=await T.fetchDevice(ip); state.connected=true;
      savePrefs();
      m.hidden=true;
      toast('已固定为 5555。第一次连本页面时电视会弹「允许 USB 调试」，点允许即可', '', 9000);
      renderDiag();
      const allow=$('#pair-allow'); if (allow) allow.hidden = true;
    }catch(err){
      renderDiag();
      const msg = err && err.message ? err.message : String(err);
      if (err && err.code === 'NEED_PAIRING') {
        // 填的是加密端口但没填 ②：先试已存凭据静默恢复；不行就回到同一个弹窗、聚焦 ②
        if (await autoRecover(ip)) { m.hidden = true; ok.textContent = '连接并固定端口'; return true; }
        showPortDialog(ip, 'NEED_PORT');
        const c2 = $('#pair-code-input'); if (c2) setTimeout(() => c2.focus(), 80);
        return;
      }
      if (/还在等电视|允许 USB 调试/.test(msg)) { toast(msg, 'warn', 12000); ok.textContent='我点过允许了，再连一次'; ok.disabled=false; return; }
      if (err && (err.code==='code'||err.step==='code')) toast('配对码不对或已过期：回到电视那个窗口，重新抄一遍 6 位码','err',8000);
      else if (err && (err.code==='tls'||err.code==='cnxn')) toast('这台设备的配对已失效，请重新开一次配对窗口','err',8000);
      else if (err && err.code==='plaintext') toast('这台设备不需要配对：直接填 IP 连接即可','warn',7000);
      else if (err && err.code==='pair-tls') toast('连不上配对端口：请确认电视上的配对窗口还开着，端口抄的是第二屏那个','err',8000);
      else if (err && err.code==='NEED_PORT') toast('这个端口也连不上：请确认填的是电视上当前显示的端口','err',7000);
      else toast('还是没成功：'+msg,'err',6500);
      ok.textContent='再试一次';
    }finally{
      ok.disabled=false;
      state.connecting=false; renderStatus(); if(state.connected) refreshApps();
    }
  };
}
async function doConnectUsb() {
  if (state.demo) return;
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle)) {
    showInsecureDialog(); return;
  }
  if (state.connected) { toast('已连接；如需换连接方式，请先点上方「断开」。', 'warn'); return; }
  state.connecting=true; renderStatus();
  try {
    const T=await tango();
    await T.connectUsb();
    state.device=await T.fetchDevice('USB');
    state.connected=true;
    toast(`已连接（USB）：${state.device.brand} ${state.device.model}`);
  } catch (err) {
    toast('USB 连接失败：'+err.message,'err',4800);
  } finally { state.connecting=false; renderStatus(); if (state.connected) refreshApps(); }
}
function bindHeader(){
  $('#connect-btn').addEventListener('click', doConnect);
  $('#device-ip').addEventListener('keydown', e=>{ if(e.key==='Enter') doConnect(); });
  const ut=$('#usb-toggle'); if (ut) ut.addEventListener('click', ()=>{ const p=$('#usb-panel'); if (p) p.hidden=!p.hidden; });
  const ub=$('#connect-usb-btn'); if (ub) ub.addEventListener('click', doConnectUsb);
  const uc=$('#usb-close'); if (uc) uc.addEventListener('click', ()=>{ const p=$('#usb-panel'); if (p) p.hidden=true; });
  // HTML 默认 hidden：Pages / 桌面版且浏览器支持 WebUSB 时才显示
  if (!SELF_HOSTED && navigator.usb) { const t=$('#usb-toggle'); if (t) t.hidden=false; }
  else { const p=$('#usb-panel'); if (p) p.hidden=true; }
  state.prefs=loadPrefs();
  if (state.prefs.ip) $('#device-ip').value=state.prefs.ip;
}

// ── 诊断面板（?diag=1）：把连不上的原因分成 A/B/C/D/E 五类显示出来 ──
function renderDiag(){
  if (!DIAG) return;
  const box = $('#diag'); if (!box) return;
  box.hidden = false;
  const T = window.__boxadbDiag;
  Promise.resolve(T && T()).then(d => {
    const lines = [
      '桥地址：' + (d.bridge || '—'),
      '目标：' + (d.target || '未发起'),
      '分类：' + (d.kind || '—'),
      '原文：' + (d.detail || '—'),
      '固定端口(tcpip)：' + (d.tcpip || '未执行'),
    ];
    box.textContent = lines.join('\n');
  }).catch(() => { box.textContent = '诊断数据读取失败'; });
}

// ── 标签页 ─────────────────────────────────────────────
function bindTabs(){
  $$('.tab').forEach(t=>t.addEventListener('click',()=>{
    $$('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    $$('.panel').forEach(p=>p.classList.add('hidden'));
    const view=$('#view-'+t.dataset.view); view.classList.remove('hidden');
    try { t.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'}); } catch {}
    if(t.dataset.view==='terminal'){ BoxTerm.open($('#term')); }
  }));
}
// 标签条溢出时，用左右箭头引导“还能滑”；能排下时自动隐藏
function bindTabsNav(){
  const tabs=$('#tabs'); if(!tabs) return;
  const L=$('#tabs-left'), R=$('#tabs-right');
  function refresh(){
    const overflow=tabs.scrollWidth-tabs.clientWidth>2;
    const atL=tabs.scrollLeft<=2;
    const atR=tabs.scrollLeft+tabs.clientWidth>=tabs.scrollWidth-2;
    if(L) L.classList.toggle('show', overflow && !atL);
    if(R) R.classList.toggle('show', overflow && !atR);
  }
  const step=()=>Math.max(140, tabs.clientWidth*0.8);
  tabs.addEventListener('scroll',refresh,{passive:true});
  window.addEventListener('resize',refresh);
  if(L) L.addEventListener('click',()=>tabs.scrollBy({left:-step(),behavior:'smooth'}));
  if(R) R.addEventListener('click',()=>tabs.scrollBy({left:step(),behavior:'smooth'}));
  requestAnimationFrame(refresh);
  window.addEventListener('load',refresh);
}

// ── 安装队列 ───────────────────────────────────────────
function detectKind(n){ n=n.toLowerCase();
  if(n.endsWith('.apk'))return{k:'APK',i:'📱'}; if(n.endsWith('.xapk'))return{k:'XAPK',i:'📦'};
  if(n.endsWith('.apkm'))return{k:'APKM',i:'🧱'}; return{k:'未知',i:'❓'};}
function addFiles(files){ const ul=$('#install-queue');
  for(const f of files){ const {k,i}=detectKind(f.name); const li=document.createElement('li'); li.className='q-item'; li._file=f;
    li.innerHTML=`<div class="q-ic">${i}</div><div class="q-main"><div class="q-name">${escapeHtml(f.name)}</div>
      <div class="q-meta">${formatBytes(f.size)} · ${k} · <span class="status">待安装</span></div><div class="q-bar"><i></i></div></div>
      <span class="badge detect">待安装</span><button class="btn primary q-install">安装</button><button class="q-x" title="移除">×</button>`;
    ul.appendChild(li);
    li.querySelector('.q-x').onclick=()=>{ li.remove(); updateSummary(); };
    li.querySelector('.q-install').onclick=()=>installOne(li);
  }
  updateSummary();
}
function updateSummary(){ const items=$$('#install-queue .q-item'); const n=items.length; const bytes=items.reduce((s,li)=>s+((li._file&&li._file.size)||0),0);
  const sum=$('#queue-summary'); if(sum) sum.textContent = n? `队列 ${n} 个 · ${formatBytes(bytes)}` : '队列为空';
  const all=$('#install-all'); if(all) all.disabled = n===0 || state.demo || !state.connected;
  const clr=$('#clear-queue'); if(clr) clr.disabled = n===0;
}
async function installOne(li){
  const file=li._file; const badge=li.querySelector('.badge'), status=li.querySelector('.status'), btn=li.querySelector('.q-install'), bar=li.querySelector('.q-bar>i');
  if(!state.connected){ toast('请先连接盒子','warn'); return; }
  if(state.demo){ toast('演示模式无设备，连接后才能安装','warn'); return; }
  if(li._installing) return;
  li._installing=true; btn.disabled=true; badge.className='badge detect'; badge.textContent='安装中'; status.textContent='准备…'; bar.style.width='0';
  try{
    const T=await tango();
    await T.installFile(file,(done,total)=>{ const p=Math.min(99,Math.round(done/((total||file.size)||1)*100)); bar.style.width=p+'%'; status.textContent=p+'%'; });
    badge.className='badge ok'; badge.textContent='完成'; bar.style.width='100%'; status.textContent='已安装'; toast(`已安装：${file.name}`);
  }catch(err){ badge.className='badge err'; badge.textContent='失败'; status.textContent=err.message; toast('安装失败：'+err.message,'err',4200); }
  finally{ li._installing=false; btn.disabled=false; updateSummary(); }
}
async function installAll(){ const items=$$('#install-queue .q-item');
  for(const li of items){ const st=li.querySelector('.badge')?.textContent; if(st==='完成'||st==='安装中') continue; await installOne(li); } }
function clearQueue(){ $('#install-queue').innerHTML=''; updateSummary(); }
function bindInstall(){ const dz=$('#dropzone'), input=$('#file-input');
  dz.addEventListener('click',e=>{ if(e.target.tagName!=='BUTTON') input.click(); });
  $('#pick-files').addEventListener('click',()=>input.click());
  input.addEventListener('change',()=>{ addFiles(input.files); input.value=''; });
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));
  $('#install-all').addEventListener('click',installAll);
  $('#clear-queue').addEventListener('click',clearQueue);
  bindNas();
  if (SELF_HOSTED) {
    // 自托管形态（NAS/Docker）直接显示入口，不靠异步探针（inner 窗口里 import 慢一拍
    // 会让按钮永远 hidden）；没授权点了会给引导文案，不影响体验
    const b = $('#pick-nas'); if (b) b.hidden = false;
  }
  updateSummary();
}


// ── 从 NAS 选择安装包（自托管形态：绿联授权文件夹 / 飞牛 NAS 文件）──────
let nasPath = '';
async function nasApi(path){
  const T = await tango();
  const r = await fetch(`${T.BRIDGE_BASE}/nas/list?path=${encodeURIComponent(path || '')}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// 伪装成 File：只实现安装流程真正用到的 name / size / arrayBuffer()
function nasLike(e){
  return {
    name: e.name, size: e.size || 0,
    async arrayBuffer(){
      const T = await tango();
      const r = await fetch(`${T.BRIDGE_BASE}/nas/file?path=${encodeURIComponent(e.path)}`);
      if (!r.ok) throw new Error('从 NAS 读取失败（HTTP ' + r.status + '）');
      return await r.arrayBuffer();
    },
  };
}
function nasShowNote(text){
  const n = $('#nas-note'); if (!n) return;
  n.hidden = !text; n.textContent = text || '';
}
async function nasRender(path){
  const list = $('#nas-list'); if (!list) return;
  list.innerHTML = '<div class="nas-empty">读取中…</div>';
  const crumb = $('#nas-crumb'); if (crumb) crumb.textContent = '/' + (path || '');
  let d;
  try { d = await nasApi(path); }
  catch (err) { list.innerHTML = ''; nasShowNote('NAS 接口不可用：' + err.message); return; }
  nasShowNote(d.ok ? '' : (d.hint || d.message || '读取失败'));
  const items = d.items || [];
  if (!items.length) { list.innerHTML = '<div class="nas-empty">这里没有 apk / xapk / apkm</div>'; return; }
  nasPath = d.path || path || '';
  list.innerHTML = '';
  for (const e of items) {
    const row = document.createElement('div');
    row.className = 'nas-row'; row.setAttribute('role', 'option'); row.tabIndex = 0;
    const meta = e.dir ? '' : `${formatBytes(e.size)} · ${new Date((e.mtime || 0) * 1000).toLocaleDateString()}`;
    row.innerHTML = `<span>${e.dir ? '📁' : '📦'}</span><span class="nm">${escapeHtml(e.name)}</span><span class="sz">${meta}</span>`;
    const act = () => {
      if (e.dir) { nasRender(e.path); return; }
      addFiles([nasLike(e)]);
      $('#nas-modal').hidden = true;
      toast(`已加入队列：${e.name}`, 'info', 3200);
    };
    row.addEventListener('click', act);
    row.addEventListener('keydown', ev => { if (ev.key === 'Enter') act(); });
    list.appendChild(row);
  }
}
function bindNas(){
  const btn = $('#pick-nas'); if (!btn) return;
  btn.addEventListener('click', () => { $('#nas-modal').hidden = false; nasRender(''); });
  $('#nas-close').addEventListener('click', () => { $('#nas-modal').hidden = true; });
  $('#nas-refresh').addEventListener('click', () => nasRender(nasPath));
  $('#nas-up').addEventListener('click', () => {
    const parts = (nasPath || '').split('/').filter(Boolean);
    parts.pop();
    nasRender(parts.join('/'));
  });
  $('#nas-modal').addEventListener('click', e => { if (e.target.id === 'nas-modal') $('#nas-modal').hidden = true; });
}


// ── 应用管理 ───────────────────────────────────────────
async function refreshApps(){ const body=$('#apps-body');
  if(!state.connected){ body.innerHTML='<div class="empty">未连接设备 — 连接后将在此显示应用列表。</div>'; return; }
  const demoList = state.appsScope==='system' ? DEMO_SYSTEM_APPS : DEMO_APPS;
  if(state.demo){ renderAppGrid(demoList); return; }
  body.innerHTML='<div class="empty">正在读取应用列表…</div>';
  try { const T=await tango(); const apps=await T.listApps({scope:state.appsScope}); renderAppGrid(apps); }
  catch(err){ body.innerHTML=`<div class="empty">读取失败：${escapeHtml(err.message)}</div>`; }
}
function renderAppGrid(apps){ Icons.reset(); const q=($('#app-search').value||'').toLowerCase();
  const list=apps.filter(a=>!q||a.name.toLowerCase().includes(q)||a.pkg.toLowerCase().includes(q));
  const body=$('#apps-body'); if(!list.length){ body.innerHTML='<div class="empty">没有匹配的应用</div>'; return; }
  body.innerHTML='<div class="app-grid"></div>'; const g=body.firstElementChild;
  const sys = state.appsScope==='system';
  for(const a of list){ const card=document.createElement('div'); card.className='app-card'+(a.disabled?' off':'');
    const letter=((a.name||a.pkg||'?').trim().charAt(0)||'?').toUpperCase();
    // 第三方：可卸载；系统：不可卸载，只能禁用/启用，其余三个按钮一致
    const dangerBtn = sys
      ? (a.disabled ? '<button class="mini ok" data-act="enable">启用</button>'
                    : '<button class="mini warn" data-act="disable">禁用</button>')
      : '<button class="mini danger" data-act="uninstall">卸载</button>';
    const offTag = a.disabled ? '<span class="tag-off">已禁用</span>' : '';
    card.innerHTML=`<div class="app-ic" data-pkg="${escapeHtml(a.pkg)}" style="background:${hue(a.pkg)};color:#fff;font-weight:700">${escapeHtml(letter)}</div><div class="app-info"><div class="app-name"><span class="app-name-t">${escapeHtml(a.name)}</span>${offTag}</div>
      <div class="app-pkg">${escapeHtml(a.pkg)}</div><div class="app-acts">
      <button class="mini" data-act="launch">启动</button><button class="mini" data-act="stop">强制停止</button>
      ${dangerBtn}<button class="mini" data-act="clear">清除数据</button></div></div>`;
    card.querySelectorAll('.mini').forEach(b=>b.onclick=()=>appAction(b,a)); g.appendChild(card);
  }
  // 首屏已是字母头像；仅连上真机时后台懒加载补真图标（切走/断开会 Icons.reset 取消）
  if(state.connected && !state.demo){ requestAnimationFrame(()=>Icons.attach(g, tango)); }
}
async function appAction(btn,a){ const act=btn.dataset.act;
  if(!state.connected){ toast('未连接设备','warn'); return; }
  if(act==='uninstall' && !confirm(`确认卸载 ${a.name}？`)) return;
  if(act==='clear' && !confirm(`确认清除 ${a.name} 的数据？`)) return;
  if(act==='disable' && !confirm(`确认禁用系统应用「${a.name}」？\n\n禁用后它将停止运行并从桌面消失，可能影响相关系统功能。\n之后可在本列表点「启用」恢复。`)) return;
  if(state.demo){ toast(`（演示）${act}: ${a.pkg}`,'warn'); return; }
  btn.disabled=true;
  try { const T=await tango();
    if(act==='launch') await T.launch(a.pkg);
    else if(act==='stop') await T.forceStop(a.pkg);
    else if(act==='clear') await T.clearData(a.pkg);
    else if(act==='uninstall'){ await T.uninstall(a.pkg); toast(`已卸载 ${a.name}`); await refreshApps(); }
    else if(act==='disable'){ await T.disableApp(a.pkg); toast(`已禁用 ${a.name}`,'warn'); await refreshApps(); }
    else if(act==='enable'){ await T.enableApp(a.pkg); toast(`已启用 ${a.name}`); await refreshApps(); }
  } catch(err){ toast(act+' 失败：'+err.message,'err'); } finally { btn.disabled=false; }
}
function bindApps(){ $('#refresh-apps').addEventListener('click',refreshApps);
  $('#app-search').addEventListener('input',()=>state.connected&&refreshApps());
  $$('#apps-scope .seg-btn').forEach(b=>b.addEventListener('click',()=>{
    if(state.appsScope===b.dataset.scope) return;
    state.appsScope=b.dataset.scope;
    $$('#apps-scope .seg-btn').forEach(x=>{ const on=x===b; x.classList.toggle('active',on); x.setAttribute('aria-selected',on); });
    $('#app-search').value='';
    refreshApps();
  }));
}

// ── 遥控器 ─────────────────────────────────────────────
function bindRemote(){
  $$('#view-remote .rkey, #view-remote .dp').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!state.connected){ toast('未连接设备','warn'); return; }
    btn.classList.add('flash'); setTimeout(()=>btn.classList.remove('flash'),120);
    const code=btn.dataset.key, label=btn.title||btn.textContent.trim();
    if(state.demo){ toast(`（演示）${label} → keyevent ${code}`,'info',1200); return; }
    try { const T=await tango(); await T.keyevent(code); } catch(err){ toast('按键失败：'+err.message,'err'); }
  }));
  $$('#view-remote .action').forEach(btn=>btn.addEventListener('click',()=>runDeviceAction(btn.dataset.act,btn)));
}
async function runDeviceAction(act,btn){
  if(!state.connected){ toast('未连接设备','warn'); return; }
  const names={screenshot:'截屏',reboot:'重启'};
  const label=names[act]||act;
  if(state.demo){ toast(`（演示）${label}`,'warn'); return; }
  if(act==='reboot' && !confirm('确认重启盒子？')) return;
  btn.disabled=true;
  try { const T=await tango();
    if(act==='screenshot'){ const blob=await T.screenshot(); downloadBlob(blob, `boxadb-${Date.now()}.png`); toast('已截屏并下载'); }
    else if(act==='reboot'){ await T.reboot(''); toast('已发送重启'); }
  } catch(err){ toast(label+' 失败：'+err.message,'err',4200); } finally { btn.disabled=false; }
}
function downloadBlob(blob,name){ const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }

// ── 日志（一次 logcat -d 抓取；连续流下一步接入）────────
function bindLog(){
  $('#log-start').onclick=async()=>{ if(!state.connected){toast('未连接设备','warn');return;} if(state.demo){toast('（演示）日志稍后接入','warn');return;}
    $('#log-out').textContent='拉取中…'; try{ const T=await tango(); $('#log-out').textContent=await T.shell('logcat -d -v brief -t 400'); }catch(err){ $('#log-out').textContent='! '+err.message; } };
  $('#log-clear').onclick=()=>$('#log-out').textContent='';
  $('#log-download').onclick=()=>{ const txt=$('#log-out').textContent; if(!txt){toast('无日志','warn');return;} downloadBlob(new Blob([txt],{type:'text/plain'}),`logcat-${Date.now()}.txt`); };
  $('#log-filter').addEventListener('input',e=>{ /* 过滤展示下一步增强 */ });
}

function bindProto(){ const b=$('#prototype-banner'); if(b) $('#proto-close')?.addEventListener('click',()=>b.remove()); }

// ── 演示预览 ───────────────────────────────────────────
function seedDemo(){ state.demo=true; state.connected=true; state.device=demoDevice(); renderStatus(); renderAppGrid(DEMO_APPS); }

// ── 非加密访问引导（浏览器禁止 http 页面生成 ADB 密钥）────────
// 计算最可能的 https 地址：飞牛默认 5666(http)→5667(https)；http 默认端口→https 默认端口；其余端口原样保留
// 飞牛网关路径（/app/xxx）统一跳桌面主页：飞牛没有可直达应用窗口的深链，
// 窗口开关由桌面自己负责，跳主页最一致
function insecureFixUrl(){
  try{
    const u=new URL(location.href);
    let p=u.port;
    if(p==='5666') p='5667';
    else if(p==='80') p='';
    const host=p?`${u.hostname}:${p}`:u.hostname;
    if(/^\/app\//i.test(u.pathname)) return `https://${host}/`;
    return `https://${host}${u.pathname}${u.search}${u.hash}`;
  }catch(err){ return ''; }
}
function showInsecureDialog(){
  const m=$('#insecure-modal'); if(!m) return;
  // 两套引导按「服务是否自带 https 端口」分流（不能复用 SELF_HOSTED）：
  //   有 boxadb-tls-port（Docker/NAS 容器）→ 一键切自己的 https；
  //   没有（飞牛网关，加密入口是 5667）→ 走「打开飞牛加密主页」
  const tlsPort=(document.querySelector('meta[name="boxadb-tls-port"]')?.content||'').trim();
  const ownTls=/^\d{2,5}$/.test(tlsPort);
  // 平台分流：绿联 UGOS 走自己的引导（从系统桌面打开），不显示飞牛文案
  const platform=(document.querySelector('meta[name="boxadb-platform"]')?.content||'').trim();
  const fnosBox=$('#insecure-fnos'), selfBox=$('#insecure-selfhost'), ugosBox=$('#insecure-ugos');
  if(fnosBox) fnosBox.hidden = ownTls || !SELF_HOSTED || platform==='ugos';
  if(selfBox) selfBox.hidden = !ownTls;
  if(ugosBox) ugosBox.hidden = platform!=='ugos';
  if(platform==='ugos'){ // UGOS：引导到系统桌面入口，其余按钮逻辑（改端口/自签跳转）都不适用
    const s=$('#insecure-url'), b=$('#insecure-fix'), t=$('#insecure-tls'), turl=$('#insecure-tls-url');
    if(s) s.textContent=''; if(b) b.hidden=true; if(t) t.hidden=true; if(turl) turl.textContent='';
    m.hidden=false; return;
  }

  const httpsUrl=ownTls
    ? `https://${location.hostname}:${tlsPort}${location.pathname}${location.search}` : '';
  const tbtn=$('#insecure-tls'), turl=$('#insecure-tls-url');
  if(tbtn) tbtn.hidden=!httpsUrl;
  if(turl) turl.textContent=httpsUrl?`将打开：${httpsUrl}`:'';
  if(tbtn) tbtn.onclick=()=>{
    if(window.self===window.top){ location.replace(httpsUrl); return; }
    const w=window.open(httpsUrl,'_blank','noopener');
    if(!w){ toast('浏览器拦住了新标签，请手动把地址里的 http:// 改成 https://','err',8000); return; }
    toast('证书提示页点「高级 → 继续访问」，只需一次即可长期使用','info',7000);
  };
  const url=ownTls?'':insecureFixUrl();
  const s=$('#insecure-url'); if(s) s.textContent=url?`将打开：${url}`:'';
  const b=$('#insecure-fix');
  if(b) b.onclick=()=>{
    if(!url){ toast('无法自动计算地址，请手动修改','warn'); return; }
    if (window.self === window.top) { location.replace(url); return; }
    // iframe 内（飞牛桌面）必须开新标签：自签证书警告只在整页可点「继续访问」
    const w=window.open(url, '_blank', 'noopener');
    if(!w){ toast('浏览器拦住了新标签：请手动把地址里的 http:// 改成 https://、端口 5666 改成 5667','err',8000); return; }
    toast('已打开飞牛加密主页：证书提示页点「高级 → 继续访问」，然后在桌面重新点开「盒子助手」','info',8000);
  };
  const l=$('#insecure-later'); if(l) l.onclick=()=>{ m.hidden=true; };
  m.hidden=false;
}

// ── 启动 ───────────────────────────────────────────────
function boot(){
  bindProto(); bindHeader(); bindTabs(); bindTabsNav(); bindInstall(); bindApps(); bindRemote(); bindLog();
  renderStatus();
  if (location.search.includes('demo=1')) seedDemo();
  // 非加密页面整个 ADB 流程都不可用 → 打开页面就主动引导（演示模式除外）
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle) && !state.demo) showInsecureDialog();
}
document.addEventListener('DOMContentLoaded', boot);
