const p = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = x => ((x % p) + p) % p;
function powm(b, e) { let r = 1n, a = mod(b); while (e > 0n) { if (e & 1n) r = r * a % p; a = a * a % p; e >>= 1n; } return r; }
const inv = x => powm(x, p - 2n);
const d = mod(-121665n * inv(121666n));
const SQ = powm(2n, (p - 1n) / 4n);
function recoverX(y) {
  const xx = mod((y * y - 1n) * inv(mod(d * y * y + 1n)));
  let x = powm(xx, (p + 3n) / 8n);
  if (mod(x * x - xx) !== 0n) x = mod(x * SQ);
  if (mod(x * x - xx) !== 0n) return null;
  if (x & 1n) x = p - x;
  return x;
}
const By = mod(4n * inv(5n)), Bx = recoverX(By);
const B = [Bx, By, 1n, mod(Bx * By)];
const ID = [0n, 1n, 1n, 0n];
function add(P, Q) {
  const [x1,y1,z1,t1] = P, [x2,y2,z2,t2] = Q;
  const A = mod((y1-x1)*(y2-x2)), Bb = mod((y1+x1)*(y2+x2)), C = mod(2n*t1*t2*d), D = mod(2n*z1*z2);
  const E = mod(Bb-A), F = mod(D-C), G = mod(D+C), H = mod(Bb+A);
  return [mod(E*F), mod(G*H), mod(F*G), mod(E*H)];
}
function neg(P) { const [x,y,z,t] = P; return [mod(-x), y, z, mod(-t)]; }
function mul(P, k) { let acc = ID, Q = P; k = ((k % (8n*L)) + 8n*L) % (8n*L); while (k > 0n) { if (k & 1n) acc = add(acc, Q); Q = add(Q, Q); k >>= 1n; } return acc; }
function encode(P) {
  const [X,Y,Z] = P, zi = inv(Z), x = mod(X*zi), y = mod(Y*zi);
  const out = Buffer.alloc(32); let v = y;
  for (let i = 0; i < 32; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  out[31] |= (Number(x & 1n) << 7);
  return out;
}
function decode(buf) {
  const bytes = Buffer.from(buf), sign = bytes[31] >> 7;
  bytes[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= p) return null;
  const x = recoverX(y); if (x === null) return null;
  const xx = (BigInt(sign) === (x & 1n)) ? x : p - x;
  return [xx, y, 1n, mod(xx * y)];
}
const isID = P => encode(P).equals(Buffer.from('0100000000000000000000000000000000000000000000000000000000000000','hex'));
module.exports = { p, L, B, ID, add, neg, mul, encode, decode, isID, mod, inv,
  clampScalar: seed => { const h = Buffer.from(require('crypto').createHash('sha512').update(Buffer.from(seed)).digest().subarray(0,32)); h[0]&=248; h[31]&=127; h[31]|=64; let s=0n; for(let i=31;i>=0;i--) s=(s<<8n)|BigInt(h[i]); return s; } };
