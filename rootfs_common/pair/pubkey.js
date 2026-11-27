const crypto = require('crypto');
// AOSP 公钥 blob：len(4)=32位字数 | n0inv(4) | nn(256) | rr(256) | e(4)=524B，小端
const P32 = 1n << 32n, P64 = 1n << 64n;   // len 字段 = 模数按 32 位分组的字数
function toWords(n, words) {
  const b = Buffer.alloc(8 * words);
  for (let i = 0; i < words; i++) b.writeBigUInt64LE((n >> (64n * BigInt(i))) & (P64 - 1n), i * 8);
  return b;
}
// Hensel 逐位提升求 a⁻¹ mod 2^32
function invMod2k(a, bits) {
  let x = 1n, m = 2n;                      // a 为奇数时 mod 2 的逆是 1
  for (let i = 1n; i < BigInt(bits); i++) {
    m <<= 1n;                             // 模数翻倍
    if ((a * x) % m !== 1n) x += m >> 1n;   // 当前解在翻倍模数下不成立 → 高位补 2^k
  }
  return x % m;
}
function encodeAdbPubkey(pub) {
  const jwk = pub.export({ format: 'jwk' });
  const N = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
  const E = BigInt('0x' + '00' + Buffer.from(jwk.e, 'base64url').toString('hex'));
  const words = 32;                                   // 2048 位
  if (N >= (1n << 2047n) && N < (1n << 2048n)) { } else throw new Error('仅支持 2048 位模数');
  const n0inv = invMod2k(N, 32);                       // N^{-1} mod 2^32
  const n0invNeg = (P32 - n0inv) % P32;               // AOSP 存的是 -N^{-1} mod 2^32
  const R = 1n << 2048n;
  const rr = R % N * (R % N) % N;                     // R^2 mod N
  const head = Buffer.alloc(4); head.writeUInt32LE(words * 2, 0);   // len 数 32 位字：2048 位 → 64
  const ni = Buffer.alloc(4); ni.writeUInt32LE(Number(n0invNeg), 0);
  const ex = Buffer.alloc(4); ex.writeUInt32LE(Number(E), 0);
  return Buffer.concat([head, ni, toWords(N, words), toWords(rr, words), ex]);
}

module.exports = { encodeAdbPubkey };
