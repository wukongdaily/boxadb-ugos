'use strict';
// 桥的身份与配对凭据：adbkey 私钥、自签证书、每台设备的 psk/identity
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { selfSigned } = require('./x509.js');
const { encodeAdbPubkey } = require('./pubkey.js');

const FILE = 'adb-peer.json';
let dir = '';
let cache = null;

function init(stateDir) {
  dir = stateDir;
  fs.mkdirSync(dir, { recursive: true });
  cache = null;
  return dir;
}
const file = () => path.join(dir, FILE);

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch { cache = { identites: {} }; }
  if (!cache.identites) cache.identites = {};
  return cache;
}
function save() { fs.writeFileSync(file(), JSON.stringify(cache, null, 1), { mode: 0o600 }); }

function identity() {
  const c = load();
  if (c.adbkeyPem && c.certPem) {
    const privateKey = crypto.createPrivateKey(c.adbkeyPem);
    return { privateKey, publicKey: crypto.createPublicKey(privateKey), keyPem: c.adbkeyPem, certPem: c.certPem };
  }
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  c.adbkeyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  c.certPem = selfSigned(kp).pem;
  c.pubkeyB64 = encodeAdbPubkey(kp.publicKey).toString('base64');
  save();
  return { privateKey: crypto.createPrivateKey(c.adbkeyPem), publicKey: kp.publicKey, keyPem: c.adbkeyPem, certPem: c.certPem };
}

// 必须合并写：recover 只更新 port，若整条覆盖会抹掉 pair 时写入的 peerHost，
// 于是「这台配过对」再也认不出来，重启后又去弹配对表单
function remember(inst, pskBuf, extra = {}) {
  const c = load();
  const prev = c.identites[inst] || {};
  const entry = { ...prev, ...extra, at: new Date().toISOString() };
  if (pskBuf) entry.psk = Buffer.isBuffer(pskBuf) ? pskBuf.toString('hex') : String(pskBuf);
  c.identites[inst] = entry;
  save();
}
const lookup = inst => load().identites[inst] || null;
// 判定「这个 IP 是否配过对」。开关关着时设备完全不可见，只能靠本地记录，
// 而旧版本曾把 peerHost 覆盖掉，所以这里必须容错：只有一条凭据且它没归属信息时，宁可当作配过对。
function hintFor(host) {
  const entries = Object.entries(load().identites);
  const exact = entries.find(([, v]) => v.peerHost === host);
  if (exact) return { instance: exact[0], ...exact[1] };
  const unnamed = entries.filter(([, v]) => !v.peerHost);
  if (entries.length === 1 && unnamed.length === 1) return { instance: unnamed[0][0], ...unnamed[0][1] };
  return null;
}

function knownFor(host) {
  const c = load();
  for (const [inst, v] of Object.entries(c.identites)) if (v.peerHost === host) return { instance: inst, ...v };
  return null;
}
function list() {
  const c = load();
  return Object.entries(c.identites).map(([instance, v]) => ({ instance, port: v.port || null, at: v.at || null, peerHost: v.peerHost || null }));
}
function forget(inst) { delete load().identites[inst]; save(); }
const fingerprint = () => {
  const c = load();
  if (!c.certPem) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(file())).digest('hex').slice(0, 12); } catch { return null; }
};

module.exports = { init, identity, remember, lookup, knownFor, hintFor, list, forget, fingerprint };
