// 配对帧：ver(1)=1 | type(1) | len(4 BE) | payload；GCM nonce = 8B 小端计数 + 4B 0，收发独立
const crypto = require('crypto');
const VERSION = 1;
const TYPE_SPAKE2 = 0, TYPE_PEER_INFO = 1;
const MAX_PAYLOAD = 64 * 1024;
const TAG_LEN = 16;

class ProtocolError extends Error {}

function encodeFrame(type, payload) {
  if (payload.length > MAX_PAYLOAD) throw new ProtocolError('payload 超出上限');
  const h = Buffer.alloc(6);
  h[0] = VERSION; h[1] = type; h.writeUInt32BE(payload.length, 2);
  return Buffer.concat([h, payload]);
}

// 增量解析，chunk 边界任意
class FrameParser {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; this.done = false; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (!this.done) {
      if (this.buf.length < 6) return;
      if (this.buf[0] !== VERSION) throw new ProtocolError(`版本不符：期望 1，收到 ${this.buf[0]}`);
      const len = this.buf.readUInt32BE(2);
      if (len === 0 || len > MAX_PAYLOAD) throw new ProtocolError(`长度越界：${len}`);
      if (this.buf.length < 6 + len) return;
      const type = this.buf[1];
      const payload = this.buf.subarray(6, 6 + len);
      this.buf = this.buf.subarray(6 + len);
      this.onFrame({ type, length: len, payload: Buffer.from(payload) });
    }
  }
}

const nonceFor = counter => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64LE(BigInt(counter), 0);   // 前 8 字节小端，后 4 字节保持 0
  return n;
};

// 加解密记录层，send/recv 各自计数
class Recorder {
  constructor(key) { this.key = key; this.sendCount = 0; this.recvCount = 0; this.nonces = { send: [], recv: [] }; }
  seal(type, plaintext) {
    const nonce = nonceFor(this.sendCount);
    this.nonces.send.push(nonce);
    const c = crypto.createCipheriv('aes-128-gcm', this.key, nonce);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    this.sendCount++;
    return encodeFrame(type, Buffer.concat([ct, c.getAuthTag()]));   // 密文 + tag
  }
  open(type, framePayload) {
    if (framePayload.length < TAG_LEN + 1) throw new ProtocolError('密文过短');
    const nonce = nonceFor(this.recvCount);
    this.nonces.recv.push(nonce);
    const d = crypto.createDecipheriv('aes-128-gcm', this.key, nonce);
    d.setAuthTag(framePayload.subarray(framePayload.length - TAG_LEN));
    let pt;
    try {
      pt = Buffer.concat([d.update(framePayload.subarray(0, framePayload.length - TAG_LEN)), d.final()]);
    } catch (e) {
      throw new ProtocolError(`GCM 认证失败（type=${type}, recv=${this.recvCount}）`);
    }
    this.recvCount++;
    return pt;
  }
}

module.exports = { VERSION, TYPE_SPAKE2, TYPE_PEER_INFO, MAX_PAYLOAD, TAG_LEN, ProtocolError, encodeFrame, FrameParser, Recorder, nonceFor };
