#!/usr/bin/env node
// ?look=1 LOOK-PASS verification (companion to harness.mjs, same plumbing).
// Flag-OFF regression is covered by the main harness ("all" must stay green);
// this script proves the flag-ON path: boots every mountain, drives real
// bot gameplay, asserts zero console errors + op budgets (≤110 calls /
// ≤150k tris via __pp.perf), checks the 2P split + ?fx=low combos, and
// captures flag-OFF vs flag-ON comparison shots into test/shots-look/.
//
//   /opt/homebrew/bin/node test/look-verify.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(DIR, 'test', 'shots-look');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
function gate(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ═══════════════ tiny PNG reader → frame colour statistics ═══════════════
   The look pass exists to make the game RICHER. "Washed out" is not a taste
   call, it is measurable, so the OFF/ON pairs get compared numerically and
   the comparison is a rule, not an eyeball: see the LOOK_RULE gates below.
   Chrome's screenshots are 8-bit non-interlaced RGB/RGBA — decode inline
   rather than take a dependency.                                          */
function pngPixels(file) {
  const buf = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); bd = buf[o + 16]; ct = buf[o + 17]; }
    else if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported png (bd=${bd} ct=${ct})`);
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prv = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prv ? prv[x] : 0;
      const c = (prv && x >= ch) ? prv[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
// stats over the PLAY AREA only — the HUD bands are DOM and identical in
// both passes, so including them would dilute every measurement.
const HUD_TOP = 130, HUD_BOT = 90;
function frameStats(file) {
  const { w, h, ch, data } = pngPixels(file);
  const stride = w * ch;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0, satSum = 0, lumSum = 0;
  for (let y = HUD_TOP; y < h - HUD_BOT; y++) for (let x = 0; x < w; x++) {
    const i = y * stride + x * ch;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx ? (mx - mn) / mx : 0;
    lumSum += 0.299 * r + 0.587 * g + 0.114 * b;
    n++;
  }
  const pct = (hh, q) => { let acc = 0; const t = n * q; for (let v = 0; v < 256; v++) { acc += hh[v]; if (acc >= t) return v; } return 255; };
  return {
    lum: +(lumSum / n).toFixed(1),
    sat: +(satSum / n * 100).toFixed(1),
    black: +((pct(hist[0], 0.01) + pct(hist[1], 0.01) + pct(hist[2], 0.01)) / 3).toFixed(1),
  };
}
// pixels differing by more than `tol` inside a box — used to PROVE the
// skier's shadow is actually drawn (shot with the rig casting vs not).
function boxDiff(fileA, fileB, x0, y0, x1, y1, tol = 8) {
  const A = pngPixels(fileA), B = pngPixels(fileB);
  const sa = A.w * A.ch, sb = B.w * B.ch;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * sa + x * A.ch, j = y * sb + x * B.ch;
    if (Math.abs(A.data[i] - B.data[j]) > tol || Math.abs(A.data[i + 1] - B.data[j + 1]) > tol
      || Math.abs(A.data[i + 2] - B.data[j + 2]) > tol) n++;
  }
  return n;
}

function serve() {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const f = path.join(DIR, p === '/' ? 'index.html' : p);
    if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(DIR, 'test', '.chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--mute-audio', '--remote-debugging-port=0',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=1280,720', '--force-device-scale-factor=1',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', d => { buf += d.toString(); if (/DevTools listening on ws:/.test(buf)) resolve(); });
    proc.on('exit', () => reject(new Error('chrome exited early\n' + buf)));
    setTimeout(() => reject(new Error('no devtools ws\n' + buf)), 15000);
  });
  // recover the port from the DevToolsActivePort file
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 40 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  return { proc, port, profile };
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2, method });
          setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej2(new Error(method + ': reply dropped')); } }, 30000);
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch {} },
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2, method } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej2(new Error(method + ': ' + JSON.stringify(msg.error))) : res2(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params);
      }
    };
  });
}

async function pageSession(port) {
  // the /json/list fetch itself can fail while Chrome is still opening its
  // socket — that is what the retry loop is FOR, so it must not escape it.
  let last = 'no page target';
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return connect(page.webSocketDebuggerUrl);
    } catch (e) { last = 'devtools /json/list: ' + e.message; }
    await sleep(250);
  }
  throw new Error(last);
}

const PAD_STUB = `(function(){
  const mk=()=>({pressed:false,touched:false,value:0});
  const mkPad=(i,id)=>({id,
    index:i,connected:true,mapping:'standard',timestamp:0,
    axes:[0,0,0,0],buttons:Array.from({length:17},mk),
    vibrationActuator:{playEffect:()=>Promise.resolve('complete')}});
  const pad=mkPad(0,'Fake DualShock 4 (STANDARD GAMEPAD Vendor: 054c Product: 09cc)');
  const pad2=mkPad(1,'Fake Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)');
  const api=p=>({
    axes(lx,ly){p.axes[0]=lx||0;p.axes[1]=ly||0;p.timestamp=performance.now();},
    press(){const idx=Array.prototype.slice.call(arguments);
      for(let i=0;i<17;i++){const on=idx.indexOf(i)>=0;p.buttons[i].pressed=on;p.buttons[i].value=on?1:0;}
      p.timestamp=performance.now();},
  });
  window.__fakePad=api(pad);
  window.__fakePad2=api(pad2);
  Object.defineProperty(navigator,'getGamepads',{value:function(){return [pad,pad2,null,null];},configurable:true});
})();`;

const BOT_SRC = `(function(){
  if (window.__botInstalled) return; window.__botInstalled = true;
  const mkBot = () => ({ on:false, mode:'race' });
  window.__bot = mkBot(); window.__bot2 = mkBot();
  const wrap = a => { while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; };
  function drive(b, T, pad){
    const C = window.__ppCourse;
    if (!b.on || !T || !C || !pad) return;
    if (T.state !== 'run' || T.mode === 'crash') { pad.press(); return; }
    const idx = Math.min(C.length-1, Math.max(0, Math.round(T.s/9)));
    const la = Math.max(2, Math.round(T.speed*0.9/9));
    const look = C[Math.min(C.length-1, idx+la)];
    const desired = Math.atan2(look.x - T.pos.x, look.z - T.pos.z);
    const err = wrap(desired - T.heading);
    const steer = -Math.max(-1, Math.min(1, err*2.4));
    let maxC = 0;
    const lookN = Math.min(C.length-1-idx, Math.max(4, Math.round(T.speed*2.4/9)));
    for (let k=idx; k<idx+lookN; k++) { const c=Math.abs(C[k].curv); if (c>maxC) maxC=c; }
    const tuck = maxC < 0.013 && Math.abs(err) < 0.15;
    const brake = (maxC > 0.034 && T.speed > 15) || (maxC > 0.022 && T.speed > 25);
    pad.axes(steer, 0);
    const btns = [];
    if (tuck) btns.push(0);
    if (brake) btns.push(1);
    pad.press.apply(null, btns);
  }
  function step(){
    requestAnimationFrame(step);
    const T = window.__pp;
    if (!T) return;
    drive(window.__bot, T, window.__fakePad);
    if (T.p2 && window.__fakePad2) drive(window.__bot2, T.p2, window.__fakePad2);
  }
  requestAnimationFrame(step);
})();`;

function makeApi(c) {
  const consoleBad = [];
  c.on((method, params) => {
    if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
      consoleBad.push(params.type + ': ' + params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (method === 'Runtime.exceptionThrown') {
      consoleBad.push('exception: ' + (params.exceptionDetails.exception?.description || params.exceptionDetails.text));
    }
    if (method === 'Log.entryAdded' && (params.entry.level === 'error' || params.entry.level === 'warning')) {
      if (/GL Driver Message|GPU stall|ReadPixels/.test(params.entry.text)) return;
      if (/AudioContext was not allowed to start/.test(params.entry.text)) return;
      consoleBad.push('log-' + params.entry.level + ': ' + params.entry.text + ' ' + (params.entry.url || ''));
    }
  });
  const api = {
    consoleBad,
    async init() {
      await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAD_STUB });
    },
    async nav(url) {
      await c.send('Page.navigate', { url });
      await api.waitFor('!!window.__pp', 20000, 'page telemetry');
    },
    async eval(expr) {
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result.value;
    },
    async waitFor(expr, timeout = 15000, label = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await api.eval(expr)) return true;
        await sleep(40);
      }
      throw new Error('timeout waiting for ' + label);
    },
    async press(...idx) { await api.eval(`__fakePad.press(${idx.join(',')})`); },
    async tapButton(i) { await api.press(i); await sleep(120); await api.press(); await sleep(120); },
    async press2(...idx) { await api.eval(`__fakePad2.press(${idx.join(',')})`); },
    async tapButton2(i) { await api.press2(i); await sleep(120); await api.press2(); await sleep(120); },
    async shot(name) {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(SHOTS, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  shot →', f);
      return f;
    },
    async installBot() { await api.eval(BOT_SRC); },
    async bot(props) { await api.eval(`Object.assign(window.__bot, ${JSON.stringify(props)})`); },
    async bot2(props) { await api.eval(`Object.assign(window.__bot2, ${JSON.stringify(props)})`); },
    async installGlProbe() { await api.eval(GL_PROBE_SRC); },
    async glProbe() { return api.eval('({ c: __glProbe.maxCalls, t: __glProbe.maxTris })'); },
  };
  return api;
}

/* ═══════════ TRUE per-frame draw-call probe (?look=1 budgets) ═══════════
   MEASURED, not assumed: three.js calls info.reset() AFTER the shadow-map
   pass, so renderer.info.render.calls — and therefore __pp.perf — reports
   the colour pass ONLY. Under ?look=1 the shadow pass is real work (one
   pass per viewport, every caster a call), so the game's own telemetry
   UNDER-counts the flag-ON frame. Wrap the GL context instead and count
   every draw between rAFs: this is the number the ≤110 budget is about.
   Installed from the harness, never shipped.                             */
const GL_PROBE_SRC = `(function(){
  if (window.__glProbe) return;
  var gl = window.__ppLook.renderer.getContext();
  var cur = 0, curTri = 0, maxCalls = 0, maxTris = 0;
  ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced'].forEach(function(k){
    if (typeof gl[k] !== 'function') return;
    var orig = gl[k].bind(gl);
    gl[k] = function(){
      cur++;
      var n = (k.indexOf('Elements') >= 0) ? arguments[1] : arguments[2];
      curTri += (n || 0) / 3;
      return orig.apply(null, arguments);
    };
  });
  // registered AFTER the game's own rAF loop, so each tick closes the frame
  // the game just rendered.
  function tick(){
    if (cur > maxCalls) maxCalls = cur;
    if (curTri > maxTris) maxTris = curTri;
    cur = 0; curTri = 0;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__glProbe = { get maxCalls(){ return maxCalls; },
                       get maxTris(){ return Math.round(maxTris); },
                       reset: function(){ maxCalls = 0; maxTris = 0; } };
})();`;

async function tapUntil(A, btn, expr, label) {
  for (let i = 0; i < 6; i++) {
    await A.tapButton(btn);
    try { await A.waitFor(expr, 1500, label); return; } catch {}
  }
  throw new Error('tapUntil gave up: ' + label);
}
const CARD_IDX = { alp: 0, nr: 1, db: 2 };
async function selectCard(A, mtn) {
  const want = CARD_IDX[mtn] ?? 0;
  for (let i = 0; i < 10; i++) {
    const cur = await A.eval('__pp.selectSel');
    if (cur === want) return;
    await A.tapButton(cur < want ? 15 : 14);
  }
  if (await A.eval('__pp.selectSel') !== want) throw new Error('could not highlight card ' + want);
}
async function startFromTitle(A, mtn) {
  await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
  await selectCard(A, mtn);
  await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'run start');
  await A.waitFor(`__pp.state==='run'`, 12000, 'countdown → run');
}

const { srv, port: httpPort } = await serve();
const base = `http://127.0.0.1:${httpPort}`;
const MTNS = ['alp', 'nr', 'db'];          // === MTN_ORDER, the whole game
// same course station for the OFF/ON pair of each mountain: mid-run, treed
const SHOT_S = { alp: 460, nr: 460, db: 520 };

async function withPage(fn) {
  const l = await launchChrome();
  const c = await pageSession(l.port);
  const A = makeApi(c);
  await A.init();
  try { await fn(A); }
  finally {
    c.close();
    l.proc.kill();
    await sleep(300);
    fs.rmSync(l.profile, { recursive: true, force: true });
  }
}

// `node test/look-verify.mjs quick <mtn> [s]` → just that mountain's flag-ON
// shot at station s (fast tuning loop). Default: the full suite.
const MODE = process.argv[2] || 'all';
if (MODE === 'quick' || MODE === 'quickoff') {
  const mtn = MTNS.includes(process.argv[3]) ? process.argv[3] : 'alp';
  const st = parseInt(process.argv[4] || '0', 10) || SHOT_S[mtn];
  const look = MODE === 'quick';
  try {
    await withPage(async A => {
      await A.nav(`${base}/index.html?turbo=8&fx=full${look ? '&look=1' : '&look=0'}`);
      await A.installBot();
      await startFromTitle(A, mtn);
      await A.bot({ on: true, mode: 'race' });
      await A.waitFor(`__pp.s >= ${st}`, 90000, `quick ${mtn} s=${st}`);
      await A.eval('window.__ppTurbo = 1');
      await sleep(400);
      await A.shot(`quick-${mtn}${look ? '' : '-off'}`);
      gate(`quick${look ? '' : 'off'} ${mtn}: zero console errors`, A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
    });
  } catch (e) { console.error('QUICK ERROR:', e.message); failures++; }
  srv.close();
  console.log(failures === 0 ? 'QUICK OK' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

// `all` (default) runs everything; a section name runs just that block, so a
// full pass fits inside one foreground window on a slow machine:
//   mtns | action | 2p | lowfx
const RUN = s => MODE === 'all' || MODE === s;

try {
  /* ── per-mountain: flag OFF shot, then flag ON shot + budget + errors ── */
  const stats = {};
  for (const mtn of (RUN('mtns') ? MTNS : [])) {
    for (const look of [false, true]) {
      await withPage(async A => {
        const tag = `${mtn}-${look ? 'on' : 'off'}`;
        await A.nav(`${base}/index.html?turbo=8&fx=full${look ? '&look=1' : '&look=0'}`);
        await A.installBot();
        await startFromTitle(A, mtn);
        await A.bot({ on: true, mode: 'race' });
        await A.waitFor(`__pp.s >= ${SHOT_S[mtn]}`, 90000, `${tag} reaches s=${SHOT_S[mtn]}`);
        await A.eval('window.__ppTurbo = 1');
        await sleep(400);
        stats[tag] = frameStats(await A.shot(tag));
        if (look) {
          await A.installGlProbe();
          await A.eval('window.__ppTurbo = 8');
          // play deep into the course for honest worst-vista numbers
          await A.waitFor(`__pp.s >= 1400 || __pp.state === 'finish'`, 120000, `${tag} deep run`);
          const perf = await A.eval('({ c: __pp.perf.maxCalls, t: __pp.perf.tris, mt: __pp.perf.maxTris })');
          const gl = await A.glProbe();
          gate(`${tag}: draw calls ≤ 110`, gl.c <= 110, `max ${gl.c} true GL (colour pass alone reports ${perf.c})`);
          gate(`${tag}: triangles ≤ 150k`, Math.max(gl.t, perf.mt) <= 150000, `max ${gl.t} true GL / ${perf.mt} colour pass`);
          gate(`${tag}: zero console errors`, A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
        } else {
          gate(`${tag}: zero console errors`, A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
        }
      });
    }
  }

  /* ── LOOK RULE: flag-ON is RICHER than flag-OFF, never paler ──────────
     The first cut of this retrofit double-encoded sRGB and shipped a milky,
     black-lifted, pastel frame that still passed every functional gate. So
     "not washed out" gets measured, per mountain, from the OFF/ON pair:
       · saturation must go UP (the whole point of the grade),
       · mean luminance must not drift more than 10% either way (ON must
         read as the SAME scene — neither paler nor a murky re-lighting),
       · the 1st-percentile black must not LIFT (blacks stay black).       */
  for (const mtn of (RUN('mtns') ? MTNS : [])) {
    const off = stats[`${mtn}-off`], on = stats[`${mtn}-on`];
    if (!off || !on) { gate(`${mtn}: look-rule stats captured`, false); continue; }
    const d = `off lum ${off.lum} sat ${off.sat} black ${off.black} → on lum ${on.lum} sat ${on.sat} black ${on.black}`;
    gate(`${mtn} look-rule: saturation richer than OFF`, on.sat > off.sat, d);
    gate(`${mtn} look-rule: luminance within 10% of OFF`, Math.abs(on.lum - off.lum) <= off.lum * 0.10, d);
    gate(`${mtn} look-rule: blacks not lifted`, on.black <= off.black + 2, d);
  }

  /* ── action shot: shadow anchoring the skier through the ALPENGLOW woods ──
     …and the SHADOW RULE. The blob shadow is switched off under ?look=1, so
     if the 1024 map ever stops drawing the skier the game silently loses its
     ground contact. Prove it the real way: shoot the frame, then strip
     castShadow off the rig ONLY (tree casters left alone) and shoot again —
     the pixels under the skier must change.                               */
  if (RUN('action')) await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=full&look=1`);
    await A.installBot();
    await startFromTitle(A, 'alp');
    await A.bot({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 560', 90000, 'action spot');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.eval('Object.assign(window.__bot, { on: false }); __fakePad.press()');
    await A.tapButton(9);                                   // START → pause
    await A.eval(`document.getElementById('pauseMenu').style.display = 'none'`);
    await sleep(500);                                       // camera settles
    const withShadow = await A.shot('action-shadow');
    gate('look pipeline: shadow map on + blob off',
      await A.eval(`(function(){var L=window.__ppLook;return L.renderer.shadowMap.enabled
        && L.sunLight.castShadow && !L.rigs[0].blobShadow.visible;})()`) === true);
    await A.eval(`window.__ppLook.rigs[0].group.traverse(function(o){ if (o.isMesh) o.castShadow = false; })`);
    await sleep(400);
    const noShadow = await A.shot('action-noskiershadow');
    const px = boxDiff(withShadow, noShadow, 420, 340, 880, 620);
    gate('shadow rule: the skier casts a visible shadow', px >= 400, `${px} px change under the skier`);
    gate('action shot: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });

  /* ── 2P split with look=1: full-frame post, budget, errors ── */
  if (RUN('2p')) await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=full&look=1`);
    await A.installBot();
    await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapButton2(0);
    gate('2p look: P2 joined', await A.eval('__pp.race.joined') === true);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, '2P run start');
    await A.waitFor(`__pp.state==='run'`, 12000, '2P countdown → run');
    await A.bot({ on: true, mode: 'race' });
    await A.bot2({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 420', 90000, '2P mid-run');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.shot('2p-on');
    await A.installGlProbe();
    await A.eval('window.__ppTurbo = 8');
    await A.waitFor(`__pp.s >= 1200 || __pp.state === 'results'`, 120000, '2P deep run');
    const perf = await A.eval('({ c: __pp.perf.maxCalls, mt: __pp.perf.maxTris })');
    const gl = await A.glProbe();
    gate('2p look: draw calls ≤ 110', gl.c <= 110, `max ${gl.c} true GL (colour pass alone reports ${perf.c}) — TWO shadow passes`);
    gate('2p look: triangles ≤ 150k', Math.max(gl.t, perf.mt) <= 150000, `max ${gl.t} true GL / ${perf.mt} colour pass`);
    gate('2p look: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });

  /* ── the console combo: ?look=1&fx=low boots and plays clean ── */
  if (RUN('lowfx')) await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=low&look=1`);
    await A.installBot();
    await startFromTitle(A, 'alp');
    await A.bot({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 300', 90000, 'lowfx+look mid-run');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.shot('alp-on-lowfx');
    await A.installGlProbe();
    await A.eval('window.__ppTurbo = 8');
    await A.waitFor(`__pp.s >= 1400 || __pp.state === 'finish'`, 120000, 'lowfx+look deep run');
    const perf = await A.eval('({ c: __pp.perf.maxCalls, mt: __pp.perf.maxTris })');
    const gl = await A.glProbe();
    gate('look+lowfx: draw calls ≤ 110', gl.c <= 110, `max ${gl.c} true GL (colour pass alone reports ${perf.c})`);
    gate('look+lowfx: triangles ≤ 150k', Math.max(gl.t, perf.mt) <= 150000, `max ${gl.t} true GL / ${perf.mt} colour pass`);
    gate('look+lowfx: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });
} catch (e) {
  console.error('LOOK-VERIFY ERROR:', e.message);
  failures++;
} finally {
  srv.close();
}
console.log(failures === 0 ? '\nLOOK PASS GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
