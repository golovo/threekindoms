// Diagnostic record for freeze reports: game.log, beside startup.log (desktop/main.js writes both).
//
// Two records, one file. The page keeps a cheap timeline of what it is showing (screen, year and month, whose
// turn, the command books, the windows open) and flags a frame loop that has stopped; the desktop shell probes
// `window.__diag.snapshot()` every two seconds, so a page whose main thread is blocked is written down by the
// shell even when the page itself can no longer speak. A canvas that freezes while the page still runs (a GPU
// stall) shows as `frames` standing still with `sinceFrame` growing; a page frozen in JS shows as the probe not
// answering at all. Either way the lines before it say what was on screen.
//
// Nothing here is game logic: it must not throw, block for long or change what the player sees.
const FLUSH_MS = 700, BATCH = 24, MAX_QUEUE = 600, MAX_TEXT = 1500;

let frames = 0, drawn = 0, lastFrame = 0, lastDrawn = 0;
let queue = [], timer = null, dropped = 0;
let ctxLost = false, started = false;
let lastStateKey = '', lastStallAt = 0;

const iso = (t = Date.now()) => new Date(t).toISOString();
const clip = (s, n = MAX_TEXT) => {
  const text = s == null ? '' : String(s);
  return text.length > n ? `${text.slice(0, n)}…(+${text.length - n})` : text;
};
const heapMB = () => {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : 0;
};

function flush() {
  clearTimeout(timer); timer = null;
  if (!queue.length) return;
  const lines = queue.splice(0, queue.length);
  try { window.desktop?.diag?.(lines); } catch { /* a browser, or a window without the preload: nowhere to write */ }
}
function push(kind, data) {
  if (!started) return;
  if (queue.length >= MAX_QUEUE) { dropped++; return; }
  queue.push({ t: Date.now(), k: kind, d: data });
  if (queue.length >= BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}
function pushDropNote() {
  if (!dropped) return;
  const n = dropped; dropped = 0;
  push('dropped', { lines: n });
}

// What the shell asks for every two seconds: small, synchronous and unable to throw.
export function snapshot() {
  let g = null, war = false;
  try { g = window.__game?.g ?? null; war = !!window.__game?.war; } catch { /* still booting */ }
  const dialogs = [];
  try {
    for (const d of document.querySelectorAll('[role=dialog]')) {
      dialogs.push(clip(d.getAttribute('aria-label') || d.querySelector('h3,h4')?.textContent || d.className, 60));
    }
  } catch { /* a page being torn down */ }
  return {
    at: iso(),
    screen: document.body?.dataset?.screen || '',
    season: document.body?.dataset?.season || '',
    frames, drawn,
    sinceFrame: lastFrame ? Math.round(performance.now() - lastFrame) : -1,
    sinceDraw: lastDrawn ? Math.round(performance.now() - lastDrawn) : -1,
    hidden: !!document.hidden, focus: document.hasFocus(),
    aiTurn: !!document.querySelector('.aiturn'), fade: !!document.querySelector('#fade.on'),
    size: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    memMB: heapMB(), ctxLost,
    g: g ? { year: g.year, month: (g.month ?? 0) + 1, turn: g.current, player: g.player, books: g.books, over: g.over?.type || null, war } : null,
    dialogs,
  };
}

// Called by the frame loop before it decides whether this frame is due: a callback that never comes is the
// difference between "the map is not drawing" and "the page is not running".
export function frame(t = performance.now()) {
  if (lastFrame) {
    const gap = t - lastFrame;
    // A window in the background may stop asking for frames altogether: that is the compositor's doing, not a
    // freeze, and it would fill the file with gaps. Only a frame missed while the player is looking counts.
    const s = gap > 300 ? snapshot() : null;
    if (s?.focus && !s.hidden) push('gap', { ms: Math.round(gap), ...s });
  }
  lastFrame = t; frames++;
}
export function drawnFrame() { lastDrawn = performance.now(); drawn++; }

// A one-off line (a frame that threw, a scene switch a caller wants marked). The error hook below catches
// uncaught exceptions anyway; this is for the game's own frame loop, which catches its own.
export function event(kind, data) { push(kind, data); }

let stateSince = Date.now(), lastSoft = 0;
function poll() {
  try {
    const s = snapshot();
    const key = JSON.stringify([s.screen, s.g?.year, s.g?.month, s.g?.turn, s.g?.books, s.g?.over, s.dialogs, s.hidden, s.focus]);
    if (key !== lastStateKey) { lastStateKey = key; stateSince = Date.now(); push('state', s); }
    // A screen that does not move while a step is up is the other kind of freeze: the page still draws (frames
    // go on), but the game is waiting on something that never finishes. Only a transient step counts — the map
    // itself may sit still for minutes while the player thinks.
    const held = Date.now() - stateSince;
    if ((s.aiTurn && held > 45000) || (s.fade && held > 10000)) {
      if (Date.now() - lastSoft > 30000) { lastSoft = Date.now(); push('softlock', { held: Math.round(held / 1000), ...s }); }
    }
    // The page can still log when only its drawing has stopped (the GPU or the frame loop); say so, once per 5 s.
    if (s.sinceFrame > 3000 && s.focus && !s.hidden && Date.now() - lastStallAt > 5000) {
      lastStallAt = Date.now();
      push('stall', s);
    }
  } catch (err) { push('poll-error', { message: clip(err?.message || err) }); }
}

function wire() {
  if (started) return;
  started = true;
  try { window.__diag = { snapshot, frame, event }; } catch { /* a locked-down page */ }
  push('start', { href: `${location.pathname}${location.search}`, ua: navigator.userAgent, screen: document.body?.dataset?.screen || '' });

  addEventListener('error', (e) => push('error', {
    message: clip(e.message), source: `${e.filename}:${e.lineno}:${e.colno}`, stack: clip(e.error?.stack),
  }));
  addEventListener('unhandledrejection', (e) => push('reject', {
    reason: clip(e.reason?.stack || e.reason?.message || e.reason),
  }));
  addEventListener('visibilitychange', () => push('visibility', { state: document.visibilityState, hidden: document.hidden }));
  addEventListener('focus', () => push('focus', {}));
  addEventListener('blur', () => push('blur', {}));
  // Lost without the page saying so is a different report from lost and restored; the game's own handler
  // (src/app.js) tells the player, this only records it.
  addEventListener('webglcontextlost', () => { ctxLost = true; push('gl-loss', snapshot()); }, true);
  addEventListener('webglcontextrestored', () => { ctxLost = false; push('gl-restored', snapshot()); }, true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 250) push('longtask', { ms: Math.round(e.duration), name: e.name });
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask entries in this browser */ }
  setInterval(poll, 1000);
  // A heartbeat keeps the file useful even when nothing happens: a freeze after twenty quiet minutes still has
  // a last line to place it against.
  setInterval(() => { pushDropNote(); push('beat', snapshot()); }, 15000);
}

export function startDiag() { try { wire(); } catch { /* diagnostics must never stop the game */ } }
