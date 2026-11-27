// SPAKE25519（口令 = 6 位配对码 ‖ 64 字节 TLS exporter 通道绑定）
// 曲线运算复用已验模块 curve.js（300/300 对齐 Node 自带 ed25519）
const c = require('./curve.js'), crypto = require('crypto');
const { L, B, add, neg, mul, encode, decode } = c;

// BoringSSL 专用 M/N，阶 2L / 8L
const M = decode(Buffer.from('5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e', 'hex'));
const N = decode(Buffer.from('10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778', 'hex'));

const NAME_C = Buffer.from('adb pair client\0');
const NAME_S = Buffer.from('adb pair server\0');
const le64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function harden(w) { if (w & 1n) w += L; if (w & 2n) w += 2n * L; if (w & 4n) w += 4n * L; return w; }
const pwHash = pw => crypto.createHash('sha512').update(pw).digest();
function wFrom(h) { let v = 0n; for (let i = 63; i >= 0; i--) v = (v << 8n) | BigInt(h[i]); return harden(v % L); }

function transcript(clientMsg, serverMsg, dhEnc, h) {
  return crypto.createHash('sha512').update(Buffer.concat([
    le64(NAME_C.length), NAME_C, le64(NAME_S.length), NAME_S,
    le64(clientMsg.length), clientMsg, le64(serverMsg.length), serverMsg,
    le64(dhEnc.length), dhEnc, le64(h.length), h,
  ])).digest();
}

const hkdf = (km, info, len) => Buffer.from(crypto.hkdfSync('sha256', km, Buffer.alloc(32), Buffer.from(info), len));
// info 串已经真机互操作验证（错一位即 GCM 失败）
const INFO_AES = 'adb pairing_auth aes-128-gcm key';
const INFO_PSK = 'adb pairing_auth psk';
const aesKeyOf = km => hkdf(km, INFO_AES, 16);
const pskOf = km => hkdf(km, INFO_PSK, 32);

function gen() { const r = crypto.randomBytes(64); let v = 0n; for (let i = 63; i >= 0; i--) v = (v << 8n) | BigInt(r[i]); v %= L; return v << 3n; }

function alice(pw) {
  const h = pwHash(pw), w = wFrom(h), x = gen();
  const msg = encode(add(mul(B, x), mul(M, w)));       // X = M + x*P
  return { msg, finish(serverMsg) {
    const Q = add(decode(serverMsg), neg(mul(N, w)));  // (Y - N^w)^x
    const km = transcript(msg, serverMsg, encode(mul(Q, x)), h);
    return { km, aesKey: aesKeyOf(km), psk: pskOf(km) };
  } };
}
function bob(pw) {
  const h = pwHash(pw), w = wFrom(h), y = gen();
  const msg = encode(add(mul(B, y), mul(N, w)));       // Y = N + y*P
  return { msg, finish(clientMsg) {
    const Q = add(decode(clientMsg), neg(mul(M, w)));  // (X - M^w)^y
    const km = transcript(clientMsg, msg, encode(mul(Q, y)), h);
    return { km, aesKey: aesKeyOf(km), psk: pskOf(km) };
  } };
}
module.exports = { alice, bob, aesKeyOf, pskOf, INFO_AES, INFO_PSK, M, N };
