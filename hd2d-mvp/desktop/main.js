// Electron shell for the playtest build: serves desktop/app/ (made by build-app.mjs) from app://game/.
// A fixed custom origin lets ES modules and fetch() work (file:// would not) and keeps localStorage saves
// in the user's profile across reinstalls. F11 toggles fullscreen, Alt+Enter too, and so does 系统 → 全屏 in the game,
// which also has 退出游戏: preload.js is what the page may ask of the window.
//   --smoke=<dir>  load, screenshot, log console errors and missing files to <dir>, then quit (for CI / checks)
const { app, BrowserWindow, Menu, crashReporter, dialog, ipcMain, net, powerMonitor, protocol, screen, shell } = require('electron');
const { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, 'app');
const ORIGIN = 'app://game';
const smokeDir = (process.argv.find((a) => a.startsWith('--smoke=')) || '').slice(8) || null;
const devTools = !app.isPackaged || process.argv.includes('--devtools');
const BOOT_LIMIT = 90; // seconds to the title before the player is told; a slow disk with software GL takes long, not this long

// One process per profile, taken before anything below touches it. Two would share Local Storage/leveldb: the one that
// finds it locked has Chromium destroy the database, which succeeds if the holder exits within seconds, and every save
// is gone (a double double-click on Windows, 2026-11-06). Past the deletion window it runs on an empty in-memory store.
if (!app.requestSingleInstanceLock()) {
  if (smokeDir) console.error('another instance holds this profile; smoke did not run');
  app.exit(smokeDir ? 1 : 0);
  return; // app.exit does not stop this script
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]; // none yet while starting up: the window on its way is the answer
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// The startup record: a player whose game does not start has only this file and the crash dumps to send (devblog #100,
// 2026-11-03: Win10, double-click, nothing). The previous run's is kept beside it. No file at all means the process never
// got as far as this line, which points away from the game (the system, a security tool, the unpacked files).
const logFile = (() => {
  for (const dir of [path.join(app.getPath('userData'), 'logs'), path.join(os.tmpdir(), 'Three Kingdoms HD-2D')]) {
    try {
      mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'startup.log');
      if (existsSync(f)) renameSync(f, path.join(dir, 'startup.prev.log'));
      writeFileSync(f, '');
      return f;
    } catch { /* a profile that cannot be written: the next place */ }
  }
  return null;
})();
let logLines = 0;
const log = (line) => {
  if (!logFile || logLines > 500) return; // a page that repeats an error must not fill the disk
  try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); logLines++; } catch { /* nothing more can be done */ }
};

// The diagnostic record for freeze reports (src/diag.js in the page, through preload.js): game.log beside
// startup.log, appended across runs so a freeze survives the restart it forces, and rotated only past 8 MB.
// The page's own timeline says what was on screen when its frames stopped; the shell's watchdog below says
// when the page stopped answering at all.
const logDir = logFile ? path.dirname(logFile) : null;
const diagFile = logDir ? path.join(logDir, 'game.log') : null;
let diagBytes = 0;
function rotateDiag() {
  if (!diagFile) return;
  try {
    if (existsSync(diagFile) && statSync(diagFile).size > 8 * 2 ** 20) {
      const old = path.join(logDir, 'game.prev.log');
      if (existsSync(old)) unlinkSync(old);
      renameSync(diagFile, old);
    }
  } catch { /* the next line can still be written */ }
  try { diagBytes = existsSync(diagFile) ? statSync(diagFile).size : 0; } catch { diagBytes = 0; }
}
function diagLine(text) {
  if (!diagFile) return;
  try {
    const line = `${text}\n`;
    appendFileSync(diagFile, line);
    diagBytes += Buffer.byteLength(line);
    if (diagBytes > 8 * 2 ** 20) rotateDiag();
  } catch { /* a profile that cannot be written is already reported by startup.log */ }
}
const diag = (text) => diagLine(`${new Date().toISOString()} ${text}`);
rotateDiag();
// The page sends { t, k, d } lines in batches (src/diag.js). One bad line must not cost the rest.
ipcMain.on('diag:log', (_e, lines) => {
  if (!Array.isArray(lines)) return;
  for (const l of lines.slice(0, 200)) {
    const at = Number.isFinite(l?.t) ? new Date(l.t).toISOString() : new Date().toISOString();
    let body = '';
    try { body = l?.d == null ? '' : (typeof l.d === 'string' ? l.d : JSON.stringify(l.d)); } catch { body = '<unserialisable>'; }
    diagLine(`${at} [page] ${String(l?.k || '?')} ${body.length > 3000 ? `${body.slice(0, 3000)}…` : body}`);
  }
});
ipcMain.on('desktop:logs', () => { if (logDir) shell.openPath(logDir); });
// Tells the player once what failed and where the record is (AGENTS.md: never a silent black window), and opens its folder.
let told = false;
function fail(what, detail = '') {
  log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  if (smokeDir || told) return;
  told = true;
  dialog.showErrorBox('三国 HD-2D 未能正常运行', `${what}${detail ? `\n\n${detail}` : ''}\n\n${logFile ? `详细记录在：\n${logFile}\n反馈问题时请附上这个文件。` : '无法写入日志文件。'}`);
  if (logFile) shell.showItemInFolder(logFile);
}
process.on('uncaughtException', (err) => {
  fail('程序内部错误', err?.stack || String(err));
  if (!app.isReady() || !BrowserWindow.getAllWindows().length) app.exit(1); // no window to fall back on: a process left running shows nothing
});
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

let buildCommit = 'unknown';
try { buildCommit = JSON.parse(readFileSync(path.join(ROOT, 'build.json'), 'utf8')).commit; } catch { /* reported below by the missing files */ }
diag(`[session] start ${app.getVersion()} (${buildCommit}) electron ${process.versions.electron} chrome ${process.versions.chrome} ${process.platform} ${process.arch} ${os.release()}`);
log(`start ${app.getVersion()} (${buildCommit}) electron ${process.versions.electron} chrome ${process.versions.chrome} ${process.platform} ${process.arch} ${os.release()} packaged=${app.isPackaged}`);
log(`exe ${process.execPath}`);
log(`cpu ${os.cpus()[0]?.model} x${os.cpus().length}, memory ${Math.round(os.totalmem() / 2 ** 20)} MB`);
try { crashReporter.start({ uploadToServer: false }); log(`crash dumps ${app.getPath('crashDumps')}`); } catch (err) { log(`crash reporter: ${err}`); } // kept on this machine, sent nowhere

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force_high_performance_gpu');
// After a GPU process crash Chromium may refuse WebGL to the page it blames, so the context never comes back and the
// game stays white (a Windows AMD player, 2026-11-08: two crashes two minutes apart, white after the second). The game
// is the only page here and recovers its context itself (src/app.js), so it is never blocked.
app.disableDomainBlockingFor3DAPIs();
if (smokeDir) app.commandLine.appendSwitch('mute-audio'); // checks run silent (AGENTS.md)

const EXPECTED_MISS = /^assets\/audio\/(original|remix)\/|^assets\/audio\/(sfx|bgm|cue)-[\w-]+\.mp3$/; // manifest fallbacks probed in order
const missing = [];
let bootError = null, bootErrorAt = 0; // the first thing that stops the game reaching its title
const noteBootError = (msg) => { if (!bootError) { bootError = msg; bootErrorAt = Date.now(); } };
// The player's own data packs (docs/战略地图数据包扩展设计_2026-11-17.md §5.6): folders under 文稿/Three Kingdoms HD-2D/mods, served
// at mods/<id>/ beside the shipped ones, which win on a clash. Only a pack's fixed JSON files (src/core/pack.js PACK_FILES) are
// read, never through a link; mods/index.json is the shipped list plus every folder here with a readable pack.json.
const USER_MODS = path.join(app.getPath('documents'), 'Three Kingdoms HD-2D', 'mods');
const PACK_FILE = /^mods\/([a-z0-9][a-z0-9-]{0,39})\/(pack|cities|roads|factions|officers)\.json$/;
const plainFile = (f) => { try { return lstatSync(f).isFile(); } catch { return false; } };
function packIndex() {
  let list = [];
  try { list = JSON.parse(readFileSync(path.join(ROOT, 'mods', 'index.json'), 'utf8')); } catch {}
  const have = new Set(list.map((p) => p.id));
  let dirs = [];
  try { dirs = readdirSync(USER_MODS); } catch {}
  for (const id of dirs.sort()) {
    const f = path.join(USER_MODS, id, 'pack.json');
    if (have.has(id) || !PACK_FILE.test(`mods/${id}/pack.json`) || !plainFile(f)) continue;
    try { const m = JSON.parse(readFileSync(f, 'utf8')); list.push({ id, name: String(m.name ?? id).slice(0, 24), version: String(m.version ?? ''), author: String(m.author ?? '').slice(0, 24), local: true }); }
    catch { list.push({ id, name: id, version: '', author: '', local: true }); } // listed, so choosing it says what is wrong
  }
  return new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } });
}
function serve(request) {
  const url = new URL(request.url);
  if (url.host !== 'game') return new Response('not found', { status: 404 });
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel === 'mods/index.json') return packIndex();
  const own = PACK_FILE.exec(rel);
  if (own && !existsSync(path.join(ROOT, 'mods', own[1]))) {
    const f = path.join(USER_MODS, own[1], `${own[2]}.json`);
    return plainFile(f) ? net.fetch(pathToFileURL(f).toString()) : new Response('not found', { status: 404 });
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !existsSync(file)) {
    missing.push(rel);
    if (!EXPECTED_MISS.test(rel)) log(`missing file ${rel}`);
    if (rel.endsWith('.js')) noteBootError(`缺少游戏文件 ${rel}。请重新完整解压压缩包。`); // every module is a static import: the game cannot come up without it
    return new Response('not found', { status: 404 });
  }
  return net.fetch(pathToFileURL(file).toString());
}

// What the page does on the way to the title goes in the record, and a page that never gets there says so: a game
// that cannot start WebGL or load a module otherwise leaves a black window and no word.
function watchPage(win) {
  const wc = win.webContents, t0 = Date.now(), secs = () => (Date.now() - t0) / 1000;
  let up = false;
  win.once('ready-to-show', () => log(`window ready after ${secs()}s`));
  win.on('unresponsive', () => { log('window unresponsive'); diag('[window] unresponsive (Chromium: no answer for 30 s)'); });
  win.on('responsive', () => { log('window responsive again'); diag('[window] responsive again'); });
  wc.on('did-finish-load', () => log(`page loaded after ${secs()}s`));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    log(`load failed ${code} ${desc} ${url}`);
    if (isMain) fail('游戏页面加载失败', `${desc} (${code})`);
  });
  wc.on('render-process-gone', (_e, d) => { diag(`[window] renderer gone ${d.reason} exit=${d.exitCode}`); if (d.reason !== 'clean-exit') fail('游戏页面进程意外退出', `${d.reason} (退出码 ${d.exitCode})`); });
  wc.on('console-message', (e) => {
    if (e.level !== 'error' && e.level !== 'warning') return;
    log(`page ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    if (!up && /Uncaught|module script/i.test(e.message)) noteBootError(e.message);
  });
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);
    wc.executeJavaScript('document.body?.dataset.screen || ""').then((screen) => {
      if (screen && !up) { up = true; clearInterval(timer); log(`game up after ${secs()}s (${screen}), features ${JSON.stringify(app.getGPUFeatureStatus())}`); }
    }, () => {});
    if (up) return;
    if (bootError && Date.now() >= bootErrorAt + 10000) { clearInterval(timer); fail('游戏未能启动', bootError); } // a moment's grace: the title may still come
    else if (secs() >= BOOT_LIMIT) { clearInterval(timer); fail(`${BOOT_LIMIT} 秒后游戏仍未进入标题画面`, '若画面随后正常出现，可以继续游玩。'); }
  }, 1000);
}

// Where the window stood last time (its place, maximized, fullscreen), kept beside the saves. The first run asks for
// 1600x900 and gets no more than the screen has: on a 1920x1080 laptop at 150% the work area is 1280x680, and a window
// made larger than that has its title bar and ✕ off the top and the game's bottom row under the taskbar. A place that
// is on no screen any more (an unplugged monitor) is moved onto the nearest one.
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const SIZE = [1600, 900], MIN = [1024, 600]; // MIN: the smallest window the game's layout is checked at (tests/sysmenu.test.mjs)
function windowPlace() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* the first run, or a file that cannot be read */ }
  const b = saved?.bounds;
  if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)) {
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, area.width), height = Math.min(b.height, area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width), y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    return { bounds: { x, y, width, height }, area, maximized: !!saved.maximized, fullscreen: !!saved.fullscreen };
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(SIZE[0], area.width), height = Math.min(SIZE[1], area.height);
  return { bounds: { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height },
    area, maximized: width < SIZE[0] || height < SIZE[1], fullscreen: false }; // a screen too small for it: every pixel there is
}

function createWindow() {
  const place = smokeDir ? null : windowPlace(); // a check always runs in the same window and leaves no state behind
  const win = new BrowserWindow({
    ...(place ? place.bounds : { width: SIZE[0], height: SIZE[1] }), backgroundColor: '#000000',
    minWidth: Math.min(MIN[0], place?.area.width ?? MIN[0]), minHeight: Math.min(MIN[1], place?.area.height ?? MIN[1]),
    title: '三国 HD-2D', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, devTools, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
  });
  const wc = win.webContents;
  if (place?.maximized) win.maximize();
  if (place?.fullscreen) win.setFullScreen(true);
  const saveState = () => {
    if (!place) return;
    try { writeFileSync(STATE_FILE, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() })); }
    catch (err) { log(`window state not saved: ${err}`); }
  };
  // Fullscreen has no title bar and the game has no menu bar, so the way back must be in the game too: F11, Alt+Enter
  // and 系统 → 全屏 are one switch, and the page is told of every change to keep its row and its hint right.
  const toggleFullscreen = () => win.setFullScreen(!win.isFullScreen());
  ipcMain.on('desktop:fullscreen', (e) => { if (e.sender === wc) toggleFullscreen(); });
  ipcMain.handle('desktop:is-fullscreen', (e) => e.sender === wc && win.isFullScreen());
  win.on('enter-full-screen', () => wc.send('desktop:fullscreen', true));
  win.on('leave-full-screen', () => wc.send('desktop:fullscreen', false));
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) { toggleFullscreen(); e.preventDefault(); }
    if (devTools && input.key === 'F12') { wc.toggleDevTools(); e.preventDefault(); }
  });
  // Closing the window (✕, Alt+F4, ⌘Q) with a game on asks first: nothing is saved automatically, and players lost
  // hours to a stray click (feedback F03, 2026-11-02). The page says when a game is on (setUnsaved); a page that has
  // gone, or a new one, has nothing to lose. The dialog is the system's, so it also shows over a page that is stuck.
  // 退出游戏 in the game has asked already, in its own dialog (which can record first), and closes at once.
  let unsaved = false, closing = false, asking = false;
  ipcMain.on('desktop:unsaved', (e, on) => { if (e.sender === wc) unsaved = !!on; });
  ipcMain.on('desktop:quit', (e) => { if (e.sender === wc) { closing = true; win.close(); } });
  wc.on('did-navigate', () => { unsaved = false; });
  wc.on('render-process-gone', () => { unsaved = false; });
  win.on('session-end', () => { closing = true; }); // Windows is shutting down or logging off: it must not wait on a question
  win.on('close', (e) => {
    if (closing || !unsaved || smokeDir) return saveState();
    e.preventDefault();
    if (asking) return;
    asking = true;
    dialog.showMessageBox(win, { type: 'warning', title: '退出游戏', message: '未记录的进度会丢失。确定退出游戏吗？',
      detail: '要先记录，请选「取消」，再用「☰ 系统 → 记录进度」；战争中用「☰ 系统 → 中断战斗」。', buttons: ['取消', '不记录，退出'], defaultId: 0, cancelId: 0, noLink: true })
      .then(({ response }) => { asking = false; if (response === 1 && !win.isDestroyed()) { closing = true; win.close(); } }, () => { asking = false; });
  });
  // 记录编辑 holds the window open while changes are unwritten (its beforeunload). Electron then cancels the close without
  // a word, so ✕ and Alt+F4 seemed dead there: ask, and close only on the player's word.
  wc.on('will-prevent-unload', (e) => {
    const leave = dialog.showMessageBoxSync(win, { type: 'warning', title: '记录编辑', message: '还有未写回的改动，关闭后会丢失。仍要关闭吗？',
      buttons: ['取消', '放弃改动并关闭'], defaultId: 0, cancelId: 0, noLink: true }) === 1;
    if (leave) e.preventDefault(); // preventDefault here lets the page unload
  });
  // Stay on the game origin; anything else opens in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // No back or forward in a game window: a mouse's side button, a swipe or Alt+← would otherwise leave an unsaved
  // game for the page before it (the save editor). The pages swallow the side buttons too (src/ui.js).
  win.webContents.on('did-navigate', () => win.webContents.navigationHistory?.clear());
  // Window state is half of a freeze report: a game left running behind another window, or a window hidden by
  // the compositor, behaves differently from one in front. Both records go to game.log.
  for (const [ev, text] of [['focus', 'focus'], ['blur', 'blur'], ['minimize', 'minimize'], ['restore', 'restore'], ['show', 'show'], ['hide', 'hide']]) {
    win.on(ev, () => diag(`[window] ${text}`));
  }
  watchPage(win);
  watchDiag(win);
  win.loadURL(`${ORIGIN}/index.html`).catch(() => {}); // did-fail-load has already told it
  return win;
}

// The shell's half of the record. Every two seconds the page is asked for its snapshot through the preload's
// `window.__diag`. No answer inside four seconds is a page whose main thread is blocked; an answer whose frame
// count has stopped moving is a page that still runs but no longer draws (the GPU, or a frame loop that died).
// Both are written with the last snapshot known, which is what the player saw when it happened.
function watchDiag(win) {
  const wc = win.webContents;
  let last = null, lastKey = '', lastStall = 0, lastBeat = 0, lastGpu = '', misses = 0;
  const timer = setInterval(async () => {
    if (win.isDestroyed() || wc.isDestroyed()) return clearInterval(timer);
    const t0 = Date.now();
    let s;
    try {
      s = await Promise.race([
        wc.executeJavaScript('window.__diag && window.__diag.snapshot()'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 8000)),
      ]);
    } catch {
      // One missed probe can be a long frame on a slow or software-rendered machine (a frame here may take
      // seconds); two in a row, with the page still not answering, is a main thread that has stopped.
      misses++;
      if (misses >= 2 && Date.now() - lastStall > 10000) {
        lastStall = Date.now();
        diag(`[stall] renderer missed ${misses} probes of 8 s; last ${JSON.stringify(last)}`);
      }
      return;
    }
    misses = 0;
    if (!s) return;
    const key = JSON.stringify([s.screen, s.g?.year, s.g?.month, s.g?.turn, s.g?.books, s.g?.over, s.dialogs, s.hidden, s.focus, s.vig, s.shade]);
    if (key !== lastKey) { lastKey = key; diag(`[state] ${key}`); }
    // Only while the player has the window in front: a background window may stop drawing by design.
    if (s.sinceFrame > 5000 && s.focus && !s.hidden && Date.now() - lastStall > 5000) {
      lastStall = Date.now();
      diag(`[stall] no frame for ${s.sinceFrame} ms; ${JSON.stringify(s)}`);
    }
    last = s;
    if (Date.now() - lastBeat > 30000) {
      lastBeat = Date.now();
      let mem = '';
      try { mem = app.getAppMetrics().map((m) => `${m.type}:${Math.round((m.memory?.workingSetSize || 0) / 1024)}MB`).join(' '); } catch { /* older Electron */ }
      diag(`[beat] screen=${s.screen} frames=${s.frames} drawn=${s.drawn} memMB=${s.memMB} rss ${mem}`);
      try {
        const gpu = JSON.stringify(app.getGPUFeatureStatus());
        if (gpu !== lastGpu) { lastGpu = gpu; diag(`[gpu] ${gpu}`); }
      } catch { /* no GPU info */ }
    }
  }, 2000);
}

async function smoke(win) {
  const log = [];
  win.webContents.on('console-message', (e) => log.push(`[${e.level}] ${e.message}`));
  win.webContents.on('render-process-gone', (_e, d) => log.push(`[crash] ${d.reason}`));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const shot = async (name, wait) => {
    await new Promise((r) => setTimeout(r, wait));
    writeFileSync(path.join(smokeDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Real mouse input at the centre of the first element matching selector (and text, if given).
  const click = async (selector, text = '') => {
    const r = await js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.textContent.includes(${JSON.stringify(text)}) && e.getClientRects().length)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0]; // innermost match
      if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!r) throw new Error(`no ${selector} ${text}`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await wait(700);
  };
  const probe = () => js(`({
    screen: document.body.dataset.screen,
    fonts: ['112px "Ma Shan Zheng"', '20px "Noto Serif SC"'].map((f) => document.fonts.check(f, '三国')),
    webgl: !!document.querySelector('#stage canvas'),
    sfx: Object.fromEntries(Object.entries(window.__game?.audio?.files || {}).filter(([k]) => k.startsWith('sfx-')).map(([k, v]) => [k, v.split('/').slice(-2).join('/')])),
    bgm: (() => { const a = window.__game?.audio, b = a?.bgm; return a?.bgmKey ? { src: a.url(a.bgmKey), state: a.bgmState(), at: a.bgmTime(), loop: b?.buf ? [b.buf.start, b.buf.end] : null } : null; })(),
  })`);
  const steps = {};
  const step = async (name, fn) => {
    try { await fn(); steps[name] = await probe(); } catch (err) { steps[name] = { error: String(err) }; }
    await shot(`${Object.keys(steps).length}-${name}.png`, 0);
  };
  await step('title', () => wait(10000));
  await step('strategy', async () => {
    // A click during the title animation only skips it, so retry until the ruler picker opens.
    for (let i = 0; i < 8 && !(await js('!!document.querySelector(".ruler")')); i++) await click('*', '新的征程').catch(() => wait(700));
    await click('.ruler', '曹操'); await click('.ruler', '曹操');
    for (let i = 0; i < 40 && (await js('document.body.dataset.screen')) !== 'strategy'; i++) await wait(250);
    await wait(2500);
    const { width, height } = win.getContentBounds();
    for (let i = 0; i < 4; i++) { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: width / 2, y: height - 120, button: 'left', clickCount: 1 }); await wait(600); }
  });
  await step('tactical', async () => {
    await js('window.__run = window.__game.debug.quickTactical(38, 51, 2); 0');
    for (let i = 0; i < 40 && !(await js('!!document.querySelector(".tq-form")')); i++) await wait(250);
    await click('.tq-form'); await wait(400); await click('.tq-deploy'); await wait(5000); // picked, then deployed (D32 phase 2)
  });
  const miss = [...new Set(missing)];
  writeFileSync(path.join(smokeDir, 'report.json'), JSON.stringify({
    steps, missing: miss.filter((m) => !EXPECTED_MISS.test(m)), fallbackProbes: miss.filter((m) => EXPECTED_MISS.test(m)).length,
    console: log.filter((l) => !l.includes('Electron Security Warning')),
  }, null, 1));
  app.quit();
}

// No menu bar. On a Mac that would also take ⌘Q away, so the application menu keeps the one item.
const appMenu = () => (process.platform === 'darwin' ? Menu.buildFromTemplate([{ label: app.name, submenu: [{ role: 'quit', label: '退出游戏' }] }]) : null);
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
app.on('child-process-gone', (_e, d) => { log(`child process gone: ${d.type} ${d.reason} (exit ${d.exitCode})`); diag(`[window] child process gone ${d.type} ${d.reason} exit=${d.exitCode}`); }); // the GPU process among them
app.whenReady().then(() => {
  log('app ready');
  if (!existsSync(path.join(ROOT, 'index.html'))) { fail('游戏文件不完整', '找不到游戏页面。请把压缩包完整解压后，再运行解压目录里的程序。'); return app.exit(1); }
  app.getGPUInfo('basic').then((info) => log(`gpu ${JSON.stringify(info.gpuDevice)} features ${JSON.stringify(app.getGPUFeatureStatus())}`), (err) => log(`gpu info: ${err}`));
  protocol.handle('app', serve);
  if (process.platform === 'darwin') Menu.setApplicationMenu(appMenu());
  // Sleep, screen lock and display changes are the moments a GPU surface can come back lost: the freeze report
  // needs to know which of them came before it.
  for (const [ev, text] of [['suspend', 'suspend'], ['resume', 'resume'], ['lock-screen', 'lock-screen'], ['unlock-screen', 'unlock-screen']]) {
    try { powerMonitor.on(ev, () => diag(`[system] ${text}`)); } catch { /* not on this platform */ }
  }
  try { screen.on('display-metrics-changed', () => diag('[system] display metrics changed')); } catch { /* no screens yet */ }
  const win = createWindow();
  log('window created');
  if (smokeDir) { mkdirSync(smokeDir, { recursive: true }); smoke(win); }
});
app.on('before-quit', () => diag('[session] quit'));
app.on('window-all-closed', () => app.quit());
