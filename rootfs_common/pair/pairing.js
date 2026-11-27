// 配对状态机：SPAKE2 交换 → 派生密钥 → PEER_INFO 交换（均 client 先发）
// 帧序：SPAKE2_MSG 交换（client 先发）→ 派生密钥 → PEER_INFO 交换（client 先发）
const { FrameParser, Recorder, encodeFrame, TYPE_SPAKE2, TYPE_PEER_INFO, ProtocolError } = require('./frame.js');
const spake2 = require('./spake2.js');
const pi = require('./peerinfo.js');

const SPAKE2_LEN = 32;

// 按帧类型等待，不匹配不入队
function makeWaiter() {
  const q = [], waiters = [];
  let failure = null;
  const rejectAll = e => { for (const w of waiters) { clearTimeout(w.t); w.rej(e); } waiters.length = 0; };
  return {
    push(f) {
      const i = waiters.findIndex(w => w.type === f.type);
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.t); w.res(f); }
      else q.push(f);
    },
    fail(e) { if (!failure) { failure = e; rejectAll(e); } },
    wait(type, ms) {
      if (failure) return Promise.reject(failure);
      const i = q.findIndex(f => f.type === type);
      if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const entry = { type, res, rej, t: null };
        entry.t = setTimeout(() => {
          const k = waiters.indexOf(entry);
          if (k >= 0) waiters.splice(k, 1);
          rej(new ProtocolError(`等待 type=${type} 超时（${ms}ms）`));
        }, ms);
        waiters.push(entry);
      });
    },
  };
}

/**
 * 输入接驳（顺序敏感）：先排空"挂监听之前就已缓冲"的字节，再挂 data 监听进入 flowing。
 * 反过来的话，read() 取出的块会在 flowing 恢复时被 data 事件再投递一次 —— 字节重复会让帧解析全盘错位。
 */
function attachInput(inStream, handle) {
  if (inStream.readableFlowing !== true) { let pre; while ((pre = inStream.read()) !== null && pre.length) handle(pre); }
  inStream.on('data', handle);
}

// out: Writable（帧字节写它）  inStream: Readable（对端字节）
async function runPairing({ role, password, pwbuf, out, inStream, myPeerInfo, timeout = 3000 }) {
  const pw = pwbuf || Buffer.from(String(password), 'ascii');
  const isClient = role === 'client';
  const w = makeWaiter();
  const parser = new FrameParser(f => {
    if (f.type === TYPE_SPAKE2 || f.type === TYPE_PEER_INFO) w.push(f);
    else if (f.type === 2) w.done = f;
    else w.fail(new ProtocolError(`未知帧类型：${f.type}`));
  });

  const handle = c => { try { parser.push(c); } catch (e) { e.message = `[${role}] ` + e.message; w.fail(e); } };
  attachInput(inStream, handle);

  const log = [];
  const send = (label, bytes) => { log.push(label); out.write(bytes); };
  const sp = isClient ? spake2.alice(pw) : spake2.bob(pw);

  // 1) SPAKE2 消息交换
  let peerMsg;
  if (isClient) {
    if (sp.msg.length !== SPAKE2_LEN) throw new ProtocolError('我方 SPAKE2 消息长度异常');
    send('c>spake2', encodeFrame(TYPE_SPAKE2, sp.msg));
    peerMsg = (await w.wait(TYPE_SPAKE2, timeout)).payload;
  } else {
    peerMsg = (await w.wait(TYPE_SPAKE2, timeout)).payload;
    if (sp.msg.length !== SPAKE2_LEN) throw new ProtocolError('我方 SPAKE2 消息长度异常');
    send('d>spake2', encodeFrame(TYPE_SPAKE2, sp.msg));
  }
  if (peerMsg.length !== SPAKE2_LEN) throw new ProtocolError(`对端 SPAKE2 消息长度 ${peerMsg.length}，应为 ${SPAKE2_LEN}`);

  
  const { aesKey, psk, km } = sp.finish(peerMsg);
  const rec = new Recorder(aesKey);

  
  const recvPeerInfo = async () => {
    const f = await w.wait(TYPE_PEER_INFO, timeout);
    const their = rec.open(TYPE_PEER_INFO, f.payload);
    try { pi.assertShape(their, role); } catch (e) { e.peerInfoPlain = their; throw e; }
    return their;
  };
  const sendPeerInfo = () => send(isClient ? 'c>peerinfo' : 'd>peerinfo', rec.seal(TYPE_PEER_INFO, myPeerInfo));

  let peerPeerInfo;
  if (isClient) { sendPeerInfo(); peerPeerInfo = await recvPeerInfo(); }
  else { peerPeerInfo = await recvPeerInfo(); sendPeerInfo(); }

  return { aesKey, psk, km, recorder: rec, log, peerPeerInfo, get done() { return w.done; } };
}

module.exports = { runPairing, makeWaiter, attachInput, SPAKE2_LEN };
