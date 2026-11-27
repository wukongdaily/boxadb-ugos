'use strict';
// AXML(AndroidManifest.xml 二进制) + resources.arsc 解析器。
// 纯 DataView、无 DOM —— 浏览器 Web Worker 与 Node 单测共用同一份代码。
// 目标：把 android:label / android:icon 的资源 id 解析成「真实文字 / APK 内文件路径 / 颜色 / 再引用」，
// 从而读到正确图标（含 adaptive 的 foreground/background 引用）与真实应用名，取代文件名猜测。

const rdU16 = (d, o) => d.getUint16(o, true);
const rdU32 = (d, o) => d.getUint32(o, true);

// ResValue 数据类型常量
const TYPE_REFERENCE = 0x01, TYPE_STRING = 0x03;
const COLOR_TYPES = new Set([0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23]);
const isPath = (s) => typeof s === 'string' && (s.includes('/') || /\.(png|webp|xml|jpg|jpeg|gif)$/i.test(s));

// ── ResStringPool chunk → 字符串数组 ──────────────────────────
function parseStringPool(dv, buf, poolStart) {
  if (rdU16(dv, poolStart) !== 0x0001) return [];
  const count = rdU32(dv, poolStart + 8);
  const flags = rdU32(dv, poolStart + 16);
  const stringsStart = rdU32(dv, poolStart + 20);   // 表头: type/hs/size(8) stringCount(8) styleCount(12) flags(16) stringsStart(20) stylesStart(24)
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const dataBase = poolStart + stringsStart;
  const td = isUtf8 ? new TextDecoder('utf-8') : new TextDecoder('utf-16le');
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const sp = dataBase + rdU32(dv, poolStart + 28 + i * 4); // 偏移表从 +28 起（header 28 字节）
    if (isUtf8) {
      let p = sp;
      let n = dv.getUint8(p); p += (n & 0x80) ? 2 : 1;
      let bl = dv.getUint8(p); p += (bl & 0x80) ? 2 : 1;
      const bLen = (bl & 0x80) ? (((bl & 0x7f) << 8) | dv.getUint8(p - 1)) : bl;
      out[i] = td.decode(new Uint8Array(buf, p, bLen));
    } else {
      let p = sp;
      let n = rdU16(dv, p); p += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | rdU16(dv, p); p += 2; }
      out[i] = td.decode(new Uint8Array(buf, p, n * 2));
    }
  }
  return out;
}

// ── AXML：解析成轻量元素树，返回 application 与 launcher 组件（供“启动器优先取图标/名”）──
export function parseManifestXml(buf) {
  const dv = new DataView(buf);
  if (rdU16(dv, 0) !== 0x0003) return null;
  const fileSize = rdU32(dv, 4);
  let off = 8, pool = [];
  if (rdU16(dv, off) === 0x0001) { pool = parseStringPool(dv, buf, off); off += rdU32(dv, off + 4); }
  const roots = [], stack = [];
  while (off + 8 <= fileSize) {
    const type = rdU16(dv, off), csize = rdU32(dv, off + 4);
    if (csize <= 0 || off + csize > fileSize) break;
    if (type === 0x0102 /* START_ELEMENT */) {
      const name = pool[rdU32(dv, off + 20)] || '';
      const attrStartVal = rdU16(dv, off + 24);
      const attrSize = rdU16(dv, off + 26) || 20;
      const attrCount = rdU16(dv, off + 28);
      const attrsStart = off + 16 + attrStartVal;
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const p = attrsStart + i * attrSize;
        const an = pool[rdU32(dv, p + 4)]; if (!an) continue;
        const rawIdx = rdU32(dv, p + 8);
        attrs[an] = { type: dv.getUint8(p + 15), data: rdU32(dv, p + 16), raw: rawIdx !== 0xffffffff ? pool[rawIdx] : null };
      }
      const node = { name, attrs, children: [] };
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      stack.push(node);
    } else if (type === 0x0103 /* END_ELEMENT */) { stack.pop(); }
    off += csize;
  }
  // 收集全部元素
  const all = []; (function w(ns) { for (const n of ns) { all.push(n); w(n.children); } })(roots);
  const application = all.find((n) => n.name === 'application') || null;
  const isLauncher = (n) => (n.name === 'activity' || n.name === 'activity-alias') && n.children.some((f) =>
    f.name === 'intent-filter' && (() => {
      let a = false, c = false;
      for (const x of f.children) { const nm = (x.attrs && x.attrs.name && x.attrs.name.raw) || ''; if (x.name === 'action' && /android\.intent\.action\.MAIN$/.test(nm)) a = true; if (x.name === 'category' && /android\.intent\.category\.(LEANBACK_)?LAUNCHER$/.test(nm)) c = true; }
      return a && c;
    })());
  const launchers = all.filter(isLauncher);
  return { application, launchers };
}

// ── adaptive-icon 编译 XML：{background, foreground, monochrome} ──
export function parseAdaptiveXml(buf) {
  const dv = new DataView(buf);
  if (rdU16(dv, 0) !== 0x0003) return null;
  const fileSize = rdU32(dv, 4);
  let off = 8, pool = [];
  if (rdU16(dv, off) === 0x0001) { pool = parseStringPool(dv, buf, off); off += rdU32(dv, off + 4); }
  const tags = new Set(['background', 'foreground', 'monochrome']);
  const out = {};
  while (off + 8 <= fileSize) {
    const type = rdU16(dv, off), csize = rdU32(dv, off + 4);
    if (csize <= 0 || off + csize > fileSize) break;
    if (type === 0x0102) {
      const name = pool[rdU32(dv, off + 20)] || '';
      if (tags.has(name)) {
        const attrStartVal = rdU16(dv, off + 24);
        const attrSize = rdU16(dv, off + 26) || 20, attrCount = rdU16(dv, off + 28);
        const attrsStart = off + 16 + attrStartVal;
        for (let i = 0; i < attrCount; i++) {
          const p = attrsStart + i * attrSize;
          if (pool[rdU32(dv, p + 4)] === 'drawable') {
            out[name] = { type: dv.getUint8(p + 15), data: rdU32(dv, p + 16) };
          }
        }
      }
    }
    off += csize;
  }
  return out;
}

// ── resources.arsc 表：解析 package/type/entry，提供 resolve(id) ──
export function ArscTable(buf) {
  const dv = new DataView(buf);
  if (rdU16(dv, 0) !== 0x0002) throw new Error('not RES_TABLE_TYPE');
  const gp = parseStringPool(dv, buf, 12);      // 全局字符串池紧跟 12 字节表头
  const packages = [];
  let off = 12 + rdU32(dv, 12 + 4);             // 跳到全局池之后
  while (off + 8 <= dv.byteLength) {
    const t = rdU16(dv, off), csize = rdU32(dv, off + 4);
    if (csize <= 0) break;
    if (t === 0x0200) packages.push(parsePackage(off));
    off += csize;
  }

  function parsePackage(pStart) {
    const pkgId = rdU32(dv, pStart + 8);
    const keyStringOff = rdU32(dv, pStart + 276); // 头部: id@8, name[256]@12, typeIdStrings@268, count@272, keyStrings@276
    const keyPool = parseStringPool(dv, buf, pStart + keyStringOff);
    const typesBy = {};
    const pkgEnd = pStart + rdU32(dv, pStart + 4);
    // keyStrings 池之后紧跟各 TYPE chunk；直接定位到该池尾部
    let c = pStart + keyStringOff + rdU32(dv, pStart + keyStringOff + 4);
    while (c + 8 <= pkgEnd) {
      const ct = rdU16(dv, c), cs = rdU32(dv, c + 4);
      if (cs <= 0 || c + cs > pkgEnd) break;
      if (ct === 0x0201) {           // 仅 RES_TABLE_TYPE（值）；0x0202 是 TYPE_SPEC 规格块，跳过
        const id = rdU32(dv, c + 8);
        (typesBy[id] = typesBy[id] || []).push({ start: c, ct });
      }
      c += cs;
    }
    return { pkgId, typesBy, keyPool };
  }

  function findValue(tc, entryIdx) {
    const c = tc.start;
    const headerSize = rdU16(dv, c + 2);
    // 不同 aapt 变体字段位置不同：用算术自洽法确定 entryCount/entriesStart
    //   entriesStart ≈ headerSize + entryCount*4
    let entryCount = null, entriesStart = null;
    for (const [ecF, esF] of [[12, 16], [16, 20]]) {
      const ec = rdU32(dv, c + ecF), es = rdU32(dv, c + esF);
      if (ec > 0 && ec < 200000 && es >= headerSize + ec * 4 - 8 && es < rdU32(dv, c + 4)) { entryCount = ec; entriesStart = es; break; }
    }
    if (entryCount == null) { entryCount = rdU32(dv, c + 12); entriesStart = rdU32(dv, c + 16); }
    if (entryIdx >= entryCount) return null;
    const offRel = rdU32(dv, c + headerSize + entryIdx * 4);
    if (offRel === 0xffffffff) return null;
    return decodeEntry(c + entriesStart + offRel);
  }

  function decodeEntry(ePos) {
    const eflags = rdU16(dv, ePos + 2);
    const complex = (eflags & 0x0001) !== 0;
    const valuePos = complex ? ePos + 8 + 4 + 4 : ePos + 8; // complex: parent(4)+count(4) 后第一个 value
    const dataType = dv.getUint8(valuePos + 3);
    const data = rdU32(dv, valuePos + 4);
    if (dataType === TYPE_STRING) {
      const s = gp[data] != null ? gp[data] : null;
      return { kind: isPath(s) ? 'file' : 'str', value: s };
    }
    if (dataType === TYPE_REFERENCE) return { kind: 'ref', value: data >>> 0 };
    if (COLOR_TYPES.has(dataType)) return { kind: 'color', value: data >>> 0 };
    return null;
  }

  function resolve(id, depth = 0) {
    if (id == null || depth > 8) return null;
    const pkg = (id >>> 24) & 0xff, typeId = (id >>> 16) & 0xff, entryIdx = id & 0xffff;
    let P = packages[0];
    for (const p of packages) if (p.pkgId === pkg) { P = p; break; }
    if (!P) return null;
    const list = P.typesBy[typeId];
    if (!list) return null;
    for (const tc of list) {
      const v = findValue(tc, entryIdx);
      if (!v) continue;
      if (v.kind === 'ref') { const r = resolve(v.value, depth + 1); if (r) return r; }
      return v;
    }
    return null;
  }

  return { resolve, globalPool: gp, packages };
}

const T_REF = 0x01, T_STR = 0x03;
// 一次性解析出「真实应用名 + 图标去向」。Worker 与主线程回退共用此函数，逻辑单点。
// 图标取“启动器组件自声明的 icon 优先，否则 application icon”（与桌面实际显示一致，修 himedia 这类）。
// 返回 { label, iconPath(栅格相对路径) , iconColor(0xAARRGGBB) , iconXml(adaptive/selector 的 .xml 路径) }
export function resolveMeta(manifestBuf, arscBuf) {
  const table = ArscTable(arscBuf);
  const m = parseManifestXml(manifestBuf) || {};
  const app = m.application;
  const launchers = m.launchers || [];
  const launcherIcon = launchers.map((l) => l.attrs && l.attrs.icon).find(Boolean) || null;
  const iconRef = launcherIcon || (app && app.attrs && app.attrs.icon) || null;
  const labelRef = (app && app.attrs && app.attrs.label)
    || launchers.map((l) => l.attrs && l.attrs.label).find(Boolean) || null;

  let label = null;
  if (labelRef) {
    if (labelRef.raw && !labelRef.raw.startsWith('@')) label = labelRef.raw;
    else if (labelRef.type === T_REF) { const r = table.resolve(labelRef.data >>> 0); if (r && r.kind === 'str') label = r.value; }
  }
  let iconPath = null, iconColor = null, iconXml = null;
  if (iconRef) {
    let v = null;
    if (iconRef.type === T_REF) v = table.resolve(iconRef.data >>> 0);
    else if (iconRef.type === T_STR && iconRef.raw) v = { kind: 'file', value: iconRef.raw };
    if (v && v.kind === 'file') {
      if (/\.(png|webp|jpe?g|gif)$/i.test(v.value)) iconPath = v.value;
      else if (/\.xml$/i.test(v.value)) iconXml = v.value;
    } else if (v && v.kind === 'color') iconColor = v.value;
  }
  return { label, iconPath, iconColor, iconXml };
}
