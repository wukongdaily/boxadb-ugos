'use strict';
// ADB 消息层：24B 小端头 command,arg0,arg1,len,data_check,command_check(=~command)
const cmd = s => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const CMD = { CNXN: cmd('CNXN'), AUTH: cmd('AUTH'), OPEN: cmd('OPEN'), OKAY: cmd('OKAY'), CLSE: cmd('CLSE'), WRTE: cmd('WRTE'), STLS: cmd('STLS'), MORE: cmd('MORE'), NONE: cmd('NONE') };
const VERSION = 0x01000001, MAXDATA = 1024 * 1024;
const checksum = b => { let s = 0; for (const x of b) s = (s + x) >>> 0; return s; };

function encode(command, arg0, arg1, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(command >>> 0, 0);
  h.writeUInt32LE(arg0 >>> 0, 4);
  h.writeUInt32LE(arg1 >>> 0, 8);
  h.writeUInt32LE(payload.length, 12);
  h.writeUInt32LE(checksum(payload), 16);
  h.writeUInt32LE((~command) >>> 0, 20);
  return Buffer.concat([h, payload]);
}
function decode(buf) {
  if (buf.length < 24) throw new Error('头不足 24 字节：' + buf.length);
  const command = buf.readUInt32LE(0), arg0 = buf.readUInt32LE(4), arg1 = buf.readUInt32LE(8);
  const len = buf.readUInt32LE(12), dcheck = buf.readUInt32LE(16), ccheck = buf.readUInt32LE(20);
  if (ccheck !== ((~command) >>> 0)) throw new Error(`command_check 不符（字节序错乱？）command=${hex4(command)} ccheck=${hex4(ccheck)}`);
  if (buf.length < 24 + len) throw new Error(`载荷不完整：需 ${24 + len}，只有 ${buf.length}`);
  const payload = buf.subarray(24, 24 + len);
  // 真机 adbd 的 AUTH 包 data_check 恒为 0：不匹配只标记，不能判死
  const checkOk = !len || checksum(payload) === dcheck;
  return { command, arg0, arg1, payload, name: name(command), total: 24 + len, checkOk, dcheck };
}
const hex4 = n => '0x' + n.toString(16).padStart(8, '0');
const name = c => Object.keys(CMD).find(k => CMD[k] === c) || hex4(c);
class Reader {                       // 从任意切分的字节流里重组消息
  constructor(onMsg) { this.buf = Buffer.alloc(0); this.onMsg = onMsg; this.err = null; }
  push(chunk) {
    if (this.err) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    while (!this.err && this.buf.length >= 24) {
      const len = this.buf.readUInt32LE(12);
      if (len > MAXDATA) { this.err = new Error('声明长度越界：' + len); break; }
      if (this.buf.length < 24 + len) break;
      let m; try { m = decode(this.buf); } catch (e) { this.err = e; break; }
      this.buf = this.buf.subarray(m.total);
      this.onMsg(m);
    }
  }
}
// 服务串以 NUL 结尾
const cstring = s => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const strip0 = b => { const i = b.indexOf(0); return (i < 0 ? b : b.subarray(0, i)).toString('utf8'); };
module.exports = { CMD, VERSION, MAXDATA, encode, decode, Reader, cstring, strip0, checksum, name, hex4 };
