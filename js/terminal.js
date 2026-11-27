let term=null, fitAddon=null, pty=null, inWriter=null, running=false, openedEl=null, resizeTimer=null;

function termLib(){ return window.Terminal && (window.Terminal.Terminal || window.Terminal); }
function fitLib(){ return window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon); }

async function tango(){ return import('./tango.js'); }

export async function open(container){
  const T = termLib();
  if (!T) { console.warn('[terminal] xterm 未加载'); return; }
  if (!term) {
    term = new T({
      cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#080b0f', foreground: '#c9f7d8', cursor: '#3ddc84' },
      scrollback: 5000,
    });
    const F = fitLib();
    if (F) { fitAddon = new F(); term.loadAddon(fitAddon); }
    term.onData(send);
    term.onResize(({ rows, cols }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (pty && pty.resize) Promise.resolve(pty.resize(rows, cols)).catch(() => {}); }, 120);
    });
    term.open(container);
  }
  openedEl = container;
  fit();
  term.focus();
  if (!running) await startSession();
}

function fit(){ if (fitAddon) { try { fitAddon.fit(); } catch {} } }

async function startSession(){
  if (running) return;
  const T = await tango();
  if (!T.connected()) return;
  try {
    pty = await T.openPty();
    running = true;
    if (pty.resize) { try { await pty.resize(term.rows, term.cols); } catch {} }
    inWriter = pty.input.getWriter();
    const reader = pty.output.getReader();
    (async () => {
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; term.write(value); } }
      catch (e) { /* 流结束 */ }
      finally {
        if (running) { running = false; pty = null; }
      }
    })();
  } catch (err) {
    term.write('\r\n\x1b[31m打开 shell 失败：' + (err.message || err) + '\x1b[0m\r\n');
    running = false; pty = null;
  }
}

function send(str){
  if (!running || !inWriter) return;
  const bytes = new TextEncoder().encode(str);
  Promise.resolve(inWriter.write(bytes)).catch(() => { running = false; });
}

export function closeSession(){
  running = false;
  if (pty && pty.kill) { try { pty.kill(); } catch {} }
  pty = null;
  try { if (inWriter) inWriter.releaseLock(); } catch {}
  inWriter = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { if (term && openedEl && !openedEl.closest('.hidden')) fit(); });
}
