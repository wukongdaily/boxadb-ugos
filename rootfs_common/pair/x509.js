'use strict';
// 手写最小 X.509 自签证书：CN=00、RSA-2048、sha256WithRSA、无扩展（Node 无证书生成 API）
const crypto = require('crypto');
const len = n => n < 0x80 ? Buffer.from([n]) : Buffer.from([0x80 | ((n.toString(16).length + 1) / 2 | 0), ...hexBE(n)]);
const hexBE = n => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const tlv = (tag, v) => Buffer.concat([Buffer.from([tag]), len(v.length), v]);
const seq = (...i) => tlv(0x30, Buffer.concat(i));
const set = (...i) => tlv(0x31, Buffer.concat(i));
const int = (bignumOrBuf) => {
  let b = Buffer.isBuffer(bignumOrBuf) ? bignumOrBuf : hexBE(bignumOrBuf.toString(16));
  if (b.length === 0) b = Buffer.from([0]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);      // 正数需前导 0x00
  return tlv(0x02, b);
};
const nul = Buffer.from([0x05, 0x00]);
const oid = (d) => tlv(0x06, d);
const oidSha256RSA = Buffer.from('2a864886f70d01010b', 'hex');   // 1.2.840.113549.1.1.11
const oidCN = Buffer.from('550403', 'hex');                      // 2.5.4.3
const bitstr = b => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const str = (tag, s) => tlv(tag, Buffer.from(s, 'ascii'));
const utc = s => tlv(0x17, Buffer.from(s, 'ascii'));
const rnd = (n) => { let x; do { x = crypto.randomBytes(n); } while (!(x[0] & 0x40)); x[0] &= 0x7f; return x; };
const algId = seq(oid(oidSha256RSA), nul);
const name = cn => seq(set(seq(oid(oidCN), str(0x0c, cn))));        // UTF8String
const p2 = n => String(n).padStart(2, '0');
// UTCTime: YYMMDDHHMMSSZ，不能带 ISO 的 T
const stamp = d => { const x = new Date(Date.now() + d * 864e5); return p2(x.getUTCFullYear() % 100) + p2(x.getUTCMonth() + 1) + p2(x.getUTCDate()) + p2(x.getUTCHours()) + p2(x.getUTCMinutes()) + p2(x.getUTCSeconds()) + 'Z'; };

function selfSigned(keypair, cn = '00', days = 3650) {
  const spki = keypair.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, int(2n)), int(rnd(20)), algId, name(cn),
    seq(utc(stamp(-1)), utc(stamp(days))), name(cn), spki
  );
  const sig = crypto.sign('sha256', tbs, keypair.privateKey);
  const der = seq(tbs, algId, bitstr(sig));
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');        // 每段都必须换行，末段后也要 \n，否则 PEM "bad end line"
  const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  return { pem, der, spki };
}
module.exports = { selfSigned };
