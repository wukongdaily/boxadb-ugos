// PEER_INFO（官方 adb + Google TV 双向实测）：总长 8192
//   [0]=type：0 RSA（客户端发）| 1 PSK identity hint（设备发）
//   [1..]=ASCII 文本：RSA 侧为 base64(blob)+' '+用户+NUL；hint 侧为实例名，其余补零
const TOTAL = 8192, TYPE_LEN = 1, DATA_LEN = TOTAL - TYPE_LEN;
const PT_RSA = 0, PT_PSK = 1;
const os = require('os');
const { ProtocolError } = require('./frame.js');

function rsaFromKey524(key524, user = os.hostname()) {
  if (key524.length !== 524) throw new ProtocolError(`RSA 公钥结构 ${key524.length} 字节，应为 524`);
  const b64 = Buffer.from(key524.toString('base64'), 'ascii');
  const who = Buffer.from(String(user), 'utf8');
  const text = Buffer.concat([b64, Buffer.from([0x20]), who, Buffer.from([0])]);
  if (text.length > DATA_LEN) throw new ProtocolError('PeerInfo 文本超长：' + text.length);
  const out = Buffer.alloc(TOTAL);
  out[0] = PT_RSA;
  text.copy(out, TYPE_LEN);
  return out;
}
function pskHint(text) {
  const b = Buffer.from(String(text), 'utf8');
  if (b.length > 64) throw new ProtocolError('psk identity hint 超过 64 字节');
  const out = Buffer.alloc(TOTAL);
  out[0] = PT_PSK;
  b.copy(out, TYPE_LEN);
  return out;
}

function readRsa(peerInfo) {
  if (peerInfo[0] !== PT_RSA) throw new ProtocolError(`type=${peerInfo[0]}，不是 RSA`);
  const data = peerInfo.subarray(TYPE_LEN);
  const end = data.indexOf(0x20);
  if (end < 0) throw new ProtocolError('PeerInfo 文本里找不到分隔空格');
  const b64 = data.subarray(0, end);
  let blob;
  try { blob = Buffer.from(b64.toString('ascii'), 'base64'); } catch (e) { throw new ProtocolError('base64 段无法解码：' + e.message); }
  const user = data.subarray(end + 1, data.indexOf(0, end + 1) < 0 ? data.length : data.indexOf(0, end + 1)).toString('utf8');
  return { type: peerInfo[0], key524: blob, user, textLen: b64.length };
}

function assertShape(peerInfo, where) {
  if (peerInfo.length !== TOTAL) throw new ProtocolError(`${where}：PEER_INFO 长度 ${peerInfo.length}，应为 ${TOTAL}`);
  if (peerInfo[0] !== PT_RSA && peerInfo[0] !== PT_PSK) throw new ProtocolError(`${where}：未知 peer info type ${peerInfo[0]}`);
  if (peerInfo[0] === PT_RSA) {
    const r = readRsa(peerInfo);
    if (r.key524.length !== 524) throw new ProtocolError(`${where}：base64 解出 ${r.key524.length} B，应为 524`);
    const words = r.key524.readUInt32LE(0);
    if (words !== 64) throw new ProtocolError(`${where}：len 字段 = ${words}，2048 位密钥应为 64 个 32 位字`);
    if (r.key524.readUInt32LE(520) !== 65537) throw new ProtocolError(`${where}：公钥指数不是 65537`);
    const N = (() => { let v = 0n; for (let i = 31; i >= 0; i--) v = (v << 64n) | BigInt(r.key524.readBigUInt64LE(8 + i * 8)); return v; })();
    const n0 = BigInt(r.key524.readUInt32LE(4));
    if ((N * n0) % (1n << 32n) !== (1n << 32n) - 1n) throw new ProtocolError(`${where}：n0inv 与模数不自洽`);
    return r;
  }

  const end = peerInfo.indexOf(0, TYPE_LEN);
  const hint = peerInfo.subarray(TYPE_LEN, end < 0 ? TOTAL : end).toString('utf8');
  for (let i = (end < 0 ? TOTAL : end + 1); i < TOTAL; i++) if (peerInfo[i] !== 0) throw new ProtocolError(`${where}：hint 之后存在非零字节（偏移 ${i}）`);
  return { type: peerInfo[0], hint };
}
module.exports = { TOTAL, PT_RSA, PT_PSK, rsaFromKey524, pskHint, readRsa, assertShape };
