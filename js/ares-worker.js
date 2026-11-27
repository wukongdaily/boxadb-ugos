// AXML/arsc 解析在 Web Worker 里跑，避免大 arsc（最大 ~2.4MB）解析占用主线程造成卡顿。
// 无状态：每次消息带齐所需字节缓冲，调用 ares.js 的 resolveMeta 返回结果。
import { resolveMeta } from './ares.js';

self.onmessage = (e) => {
  const { id, manifest, arsc } = e.data;
  try {
    self.postMessage(Object.assign({ id, ok: true }, resolveMeta(manifest, arsc)));
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
