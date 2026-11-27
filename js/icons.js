'use strict';
// 应用「真名 + 真图标」懒加载补全器。
// 首屏先用首字母头像 + 包名尾段（app.js 已渲染）；本模块只在卡片进入可视区时，低并发地：
//   抽 base.apk 的 AndroidManifest.xml + resources.arsc → Web Worker 里 AXML/arsc 解析
//   → 拿到真实应用名（覆盖显示）+ android:icon 资源路径 → 抽该图标显示；
//   若 icon 是 .xml/解析失败，则回退旧的“文件名猜测”选一张；都不行保持首字母。
// 结果缓存进 IndexedDB（存于打开网页的浏览器，盒子 0 写入）；切走/断开会取消在途任务。

const DB_NAME = 'boxadb-appmeta';
const STORE = 'meta';
const MAX_WORKERS = 2;
const CACHE_VER = 3;   // 解析/抽取逻辑变更时递增，旧缓存自动作废

let dbPromise = null;
let observer = null;
let queue = [];
let running = 0;
let alive = 0;
const objUrls = new Set();

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
async function idbGet(key) {
  try { const d = await db(); return await new Promise((res, rej) => { const t = d.transaction(STORE, 'readonly').objectStore(STORE).get(key); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); } catch { return null; }
}
async function idbPut(key, val) {
  try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch { /* 隐私模式可能禁写 */ }
}

// ── Worker（解析）+ 主线程回退 ──────────────────────────
let _worker, _pending = new Map(), _seq = 0, _wBad = false;
function getWorker() {
  if (_worker) return _worker;
  if (_wBad) return null;
  try {
    _worker = new Worker('js/ares-worker.js', { type: 'module' });
    _worker.onmessage = (e) => { const { id, ok, error, ...r } = e.data; const p = _pending.get(id); if (p) { _pending.delete(id); ok ? p.res(r) : p.rej(new Error(error || 'parse failed')); } };
    _worker.onerror = () => { _wBad = true; for (const [, p] of _pending) p.rej(new Error('worker error')); _pending.clear(); };
  } catch { _wBad = true; return null; }
  return _worker;
}
async function resolveMeta(manifestBuf, arscBuf) {
  const w = getWorker();
  if (w) {
    const id = ++_seq;
    return await new Promise((res, rej) => { _pending.set(id, { res, rej }); w.postMessage({ id, manifest: manifestBuf, arsc: arscBuf }, [manifestBuf, arscBuf]); });
  }
  const a = await import('./ares.js');
  return a.resolveMeta(manifestBuf, arscBuf);
}

async function looksValid(blob) {
  try { const bmp = await createImageBitmap(blob); const ok = bmp.width >= 32 && bmp.height >= 32; try { bmp.close(); } catch {} return ok; } catch { return false; }
}
function paintIcon(el, blob) {
  if (!el.isConnected) return;
  const url = URL.createObjectURL(blob); objUrls.add(url);
  el.classList.add('has-img'); el.style.background = 'none';
  el.innerHTML = `<img class="app-ic-img" src="${url}" alt="" draggable="false">`;
}
const mimeOf = (p) => /\.webp$/i.test(p) ? 'image/webp' : (/\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png');

// 文件名猜测兜底（arsc 解析不到可用栅格时）
async function heuristicIcon(T, pkg) {
  const cands = await T.pickIconMembers(pkg);
  for (const c of cands) {
    const bytes = await T.extractZipMember(c.apk, c.member);
    if (!bytes) continue;
    const blob = new Blob([bytes], { type: mimeOf(c.member) });
    if (await looksValid(blob)) return { blob };
  }
  return null;
}

async function hydrateOne(el, pkg, getT) {
  const gen = alive;
  const card = el.closest('.app-card');
  const nameT = card && card.querySelector('.app-name-t');
  const cached = await idbGet(pkg);
  const fresh = cached && cached.v === CACHE_VER;
  if (fresh && cached.none) return;
  if (fresh && (cached.blob || cached.label)) {
    if (gen !== alive) return;
    if (cached.label && nameT) nameT.textContent = cached.label;
    if (cached.blob) paintIcon(el, cached.blob);
    return;
  }
  let T; try { T = await getT(); } catch { return; }
  if (gen !== alive) return;
  // 老设备（Android <5.0）：不做图标/真名解析（设备 unzip 常缺失、且解析吃老机器资源），保持首字母头像。
  const sdk = await T.deviceSdk();
  if (sdk && sdk < 21) return;
  let label = null, blob = null, mime = null;
  try {
    const base = await T.baseApkPath(pkg);
    if (base) {
      const mf = await T.extractZipMember(base, 'AndroidManifest.xml');
      const ar = await T.extractZipMember(base, 'resources.arsc');
      if (gen !== alive) return;
      if (mf && ar) {
        const meta = await resolveMeta(mf.buffer, ar.buffer);
        if (gen !== alive) return;
        label = meta.label || null;
        if (meta.iconPath) {
          const bytes = await T.extractZipMember(base, meta.iconPath);
          if (bytes) { const b = new Blob([bytes], { type: mimeOf(meta.iconPath) }); if (await looksValid(b)) { blob = b; mime = b.type; } }
        }
      }
    }
  } catch { /* arsc 失败 → 走回退 */ }
  if (gen !== alive) return;
  if (!blob) { const h = await heuristicIcon(T, pkg); if (h) blob = h.blob; }   // 回退文件名法
  if (gen !== alive) return;
  if (label && nameT) nameT.textContent = label;
  if (blob) paintIcon(el, blob);
  await idbPut(pkg, (label || blob) ? { label, blob, mime, v: CACHE_VER } : { none: true, v: CACHE_VER });
}

function pump() {
  while (running < MAX_WORKERS && queue.length) {
    const { el, pkg } = queue.shift(); running++;
    Promise.resolve().then(() => hydrateOne(el, pkg, el._getT))
      .catch(() => {})
      .finally(() => { running--; pump(); });
  }
}

export function reset() {
  alive++; queue = [];
  if (observer) { observer.disconnect(); observer = null; }
  for (const u of objUrls) { try { URL.revokeObjectURL(u); } catch {} }
  objUrls.clear();
}

export function attach(gridEl, getTango) {
  reset();
  if (!gridEl || typeof window.IntersectionObserver === 'undefined') return;
  const els = [...gridEl.querySelectorAll('.app-ic[data-pkg]:not([data-ic-done])')];
  if (!els.length) return;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target; observer.unobserve(el);
      el.dataset.icDone = '1'; el._getT = getTango;
      queue.push({ el, pkg: el.dataset.pkg }); pump();
    }
  }, { rootMargin: '200px' });
  for (const el of els) observer.observe(el);
}
