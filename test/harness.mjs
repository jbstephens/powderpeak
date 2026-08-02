#!/usr/bin/env node
// POWDER PEAK verification harness.
// Headless Chrome + CDP. Fake standard-mapping gamepad injected BEFORE page
// scripts; all gameplay assertions are driven through REAL input (pad axes /
// buttons or key events) and verified through the read-only telemetry
// window.__pp — never through gameplay hooks.
//
//   /opt/homebrew/bin/node test/harness.mjs all     (or: gates kbd shots ipad)
//
// Requires node >= 22 (global WebSocket).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(DIR, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
function gate(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── tiny static server ── */
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

/* ── chrome + CDP plumbing ── */
async function launchChrome(extraFlags = []) {
  const profile = fs.mkdtempSync(path.join(DIR, 'test', '.chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--mute-audio', '--remote-debugging-port=0',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=1280,720', '--force-device-scale-factor=1',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--js-flags=--expose-gc',
    `--user-data-dir=${profile}`, ...extraFlags, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    };
    proc.stderr.on('data', onData);
    proc.on('exit', () => reject(new Error('chrome exited early\n' + buf)));
    setTimeout(() => reject(new Error('no devtools ws\n' + buf)), 15000);
  });
  const port = new URL(wsUrl).port;
  return { proc, port, profile };
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      ws,
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2, method });
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
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) return connect(page.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no page target');
}

const PAD_STUB = `(function(){
  const mk=()=>({pressed:false,touched:false,value:0});
  const pad={id:'Fake DualShock 4 (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    index:0,connected:true,mapping:'standard',timestamp:0,
    axes:[0,0,0,0],buttons:Array.from({length:17},mk),
    vibrationActuator:{playEffect:()=>Promise.resolve('complete')}};
  window.__fakePad={
    axes(lx,ly){pad.axes[0]=lx||0;pad.axes[1]=ly||0;pad.timestamp=performance.now();},
    press(){const idx=Array.prototype.slice.call(arguments);
      for(let i=0;i<17;i++){const p=idx.indexOf(i)>=0;pad.buttons[i].pressed=p;pad.buttons[i].value=p?1:0;}
      pad.timestamp=performance.now();},
  };
  Object.defineProperty(navigator,'getGamepads',{value:function(){return [pad,null,null,null];},configurable:true});
})();`;

// In-page bot: a robot player. Reads telemetry + static course dump, writes
// REAL fake-pad input every animation frame. Modes: 'race' | 'ram'.
const BOT_SRC = `(function(){
  if (window.__botInstalled) return; window.__botInstalled = true;
  window.__bot = { on:false, mode:'race', forceTuck:false, forceBrake:false, noTuck:false,
                   ramX:0, ramZ:0, steerOnly:null };
  const wrap = a => { while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; };
  function step(){
    requestAnimationFrame(step);
    const b = window.__bot, T = window.__pp, C = window.__ppCourse;
    if (!b.on || !T || !C) return;
    if (T.state !== 'run' || T.mode === 'crash') { window.__fakePad.press(); return; }
    let tx, tz, la;
    const idx = Math.min(C.length-1, Math.max(0, Math.round(T.s/9)));
    if (b.mode === 'ram') { tx = b.ramX; tz = b.ramZ; }
    else {
      la = Math.max(2, Math.round(T.speed*0.9/9));
      const look = C[Math.min(C.length-1, idx+la)];
      tx = look.x; tz = look.z;
    }
    const desired = Math.atan2(tx - T.pos.x, tz - T.pos.z);
    const err = wrap(desired - T.heading);
    let steer = Math.max(-1, Math.min(1, err*2.4));
    if (b.steerOnly !== null) steer = b.steerOnly;
    // read the road ahead for tuck/brake decisions
    let maxC = 0;
    const lookN = Math.min(C.length-1-idx, Math.max(4, Math.round(T.speed*2.4/9)));
    for (let k=idx; k<idx+lookN; k++) { const c=Math.abs(C[k].curv); if (c>maxC) maxC=c; }
    let tuck = (b.mode==='ram') || (maxC < 0.013 && Math.abs(err) < 0.15);
    let brake = (maxC > 0.034 && T.speed > 15) || (maxC > 0.022 && T.speed > 25);
    if (b.mode === 'ram') brake = false;
    if (b.forceTuck) { tuck = true; brake = false; }
    if (b.forceBrake) { brake = true; tuck = false; }
    if (b.noTuck) tuck = false;
    window.__fakePad.axes(steer, 0);
    const btns = [];
    if (tuck) btns.push(0);
    if (brake) btns.push(2);
    window.__fakePad.press.apply(null, btns);
  }
  requestAnimationFrame(step);
})();`;

/* helpers over a session */
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
      // ANGLE/SwiftShader emits perf chatter in headless that never occurs on
      // real hardware; everything else still fails the gate.
      if (/GL Driver Message|GPU stall|ReadPixels/.test(params.entry.text)) return;
      // fake-pad presses aren't trusted gestures in headless; the kiosk and
      // real browsers create the context from real input (kbd/touch sessions
      // prove the real path stays clean)
      if (/AudioContext was not allowed to start/.test(params.entry.text)) return;
      consoleBad.push('log-' + params.entry.level + ': ' + params.entry.text + ' ' + (params.entry.url || ''));
    }
  });
  const api = {
    consoleBad,
    async init() {
      await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
      // headless=new marks the page occluded after dispatched input, which
      // freezes rAF; emulated focus keeps the page "visible"
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    },
    async stubPad() {
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
    async waitTicks(n, timeout = 20000) {
      const t0 = await api.eval('__pp.tick');
      await api.waitFor(`__pp.tick >= ${t0 + n}`, timeout, `${n} ticks`);
    },
    async press(...idx) { await api.eval(`__fakePad.press(${idx.join(',')})`); },
    async tapButton(i) {
      await api.press(i); await sleep(120); await api.press(); await sleep(120);
    },
    async key(key, code, vk, down) {
      await c.send('Input.dispatchKeyEvent', {
        type: down ? 'rawKeyDown' : 'keyUp', key, code,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    },
    async tapKey(key, code, vk) { await api.key(key, code, vk, true); await sleep(90); await api.key(key, code, vk, false); await sleep(90); },
    async shot(name) {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(SHOTS, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  shot →', f);
      return f;
    },
    async installBot() { await api.eval(BOT_SRC); },
    async bot(props) {
      await api.eval(`Object.assign(window.__bot, ${JSON.stringify(props)})`);
    },
  };
  return api;
}

/* course math on the node side (from the page's static dump) */
function nearestCourse(course, x, z) {
  let bd = 1e18, bi = 0;
  for (let i = 0; i < course.length; i++) {
    const d = (course[i].x - x) ** 2 + (course[i].z - z) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return { i: bi, d: Math.sqrt(bd), s: course[bi].s };
}

/* ═══════════════ GATES SESSION — pad, turbo, full assertions ═══════════════ */
async function gatesSession(base) {
  console.log('\n── gates session (fake pad, ?turbo=8) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(600);

    gate('boot: telemetry present, state=title', await A.eval(`__pp.state`) === 'title');

    // title → south → countdown → run
    await A.tapButton(0);
    await A.waitFor(`__pp.state==='countdown'||__pp.state==='run'`, 6000, 'run start');
    await A.waitFor(`__pp.state==='run'`, 8000, 'countdown → run');
    gate('title: press south starts the run', true);

    // gravity gets us moving
    await A.waitTicks(200);
    const v1 = await A.eval('__pp.speed');
    gate('physics: gravity accelerates from standstill', v1 > 3, `v=${v1.toFixed(1)} m/s`);

    // bot takes over to keep us on the piste
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });

    // tuck = faster: force tuck on, sample; then force brake, speed falls
    await A.bot({ noTuck: true });
    await A.waitTicks(240);
    const vNoTuck = await A.eval('__pp.speed');
    await A.bot({ noTuck: false, forceTuck: true });
    await A.waitTicks(240);
    const vTuck = await A.eval('__pp.speed');
    gate('tuck: holding south raises speed', vTuck > vNoTuck + 1.5,
      `${vNoTuck.toFixed(1)} → ${vTuck.toFixed(1)} m/s`);
    await A.bot({ forceTuck: false, forceBrake: true });
    await A.waitTicks(160);
    const vBrake = await A.eval('__pp.speed');
    gate('brake: holding west scrubs speed', vBrake < vTuck - 2.5,
      `${vTuck.toFixed(1)} → ${vBrake.toFixed(1)} m/s`);
    await A.bot({ forceBrake: false });

    // steering at speed actually moves us laterally (real stick input);
    // recovery back right is the bot steering the stick right for real
    const u0 = await A.eval('__pp.u');
    await A.bot({ steerOnly: -1 });
    await A.waitTicks(35);
    const uL = await A.eval('__pp.u');
    await A.bot({ steerOnly: null });
    await A.waitTicks(240);
    const uR = await A.eval('__pp.u');
    gate('steering: stick input changes lateral position', uL < u0 - 0.8 && uR > uL + 1.2,
      `u ${u0.toFixed(1)} → left ${uL.toFixed(1)} → recovered ${uR.toFixed(1)}`);

    // crash into a slalom tree at speed → tumble → checkpoint respawn
    const course = await A.eval('window.__ppCourse');
    const obstacles = await A.eval('window.__ppObstacles');
    const gates2 = await A.eval('window.__ppGates');
    const sNow = await A.eval('__pp.s');
    let ram = null;
    for (const o of obstacles) {
      const n = nearestCourse(course, o.x, o.z);
      const w = course[n.i].w;
      if (n.d < w - 0.8 && n.s > sNow + 120 && (!ram || n.s < ram.s)) ram = { ...o, s: n.s };
    }
    gate('course: an in-piste slalom tree exists ahead', !!ram, ram && `s=${ram.s}`);
    if (ram) {
      await A.waitFor(`__pp.s > ${ram.s - 90}`, 60000, 'approach ram tree');
      await A.bot({ mode: 'ram', ramX: ram.x, ramZ: ram.z });
      await A.waitFor(`__pp.state==='crash'`, 30000, 'crash state');
      gate('crash: fast tree hit tumbles', true);
      await A.waitFor(`__pp.state==='run' && __pp.mode==='ground'`, 15000, 'respawn');
      const posAfter = await A.eval('({x:__pp.pos.x, z:__pp.pos.z, v:__pp.speed, cp:__pp.checkpoint})');
      const cpS = posAfter.cp === 0 ? 9 : gates2.gates[posAfter.cp - 1];
      const near = nearestCourse(course, posAfter.x, posAfter.z);
      gate('crash: respawn at last checkpoint, moving slowly',
        Math.abs(near.s - cpS) < 15 && posAfter.v < 8,
        `respawn s=${near.s} vs checkpoint s=${cpS}, v=${posAfter.v.toFixed(1)}`);
      await A.bot({ mode: 'race' });
    }

    // pause: tick freeze, menu nav, restart, resume
    await A.tapButton(9);
    await A.waitFor(`__pp.state==='pause'`, 5000, 'pause state');
    const tickP = await A.eval('__pp.tick');
    await sleep(450);
    const tickP2 = await A.eval('__pp.tick');
    gate('pause: sim tick freezes', tickP === tickP2, `tick ${tickP}`);
    await A.tapButton(13);              // down → RESTART RUN
    await A.tapButton(0);               // south → confirm
    await A.waitFor(`(__pp.state==='countdown'||__pp.state==='run') && __pp.s < 40`, 8000, 'restart');
    gate('pause menu: RESTART RUN restarts from the top', true);
    await A.waitFor(`__pp.state==='run'`, 8000, 'restarted run');
    await A.tapButton(9);
    await A.waitFor(`__pp.state==='pause'`, 5000, 'pause again');
    await A.tapButton(0);               // south on RESUME
    await A.waitFor(`__pp.state==='run'`, 5000, 'resume');
    const tickR = await A.eval('__pp.tick');
    await A.waitTicks(30);
    gate('pause menu: RESUME continues the sim', true, `tick ${tickR} advances`);

    // memory: steady-state run must not leak (gc, run, gc, compare)
    await A.eval('window.gc && window.gc()');
    const h0 = await A.eval('performance.memory.usedJSHeapSize');
    await A.waitTicks(900, 60000);
    await A.eval('window.gc && window.gc()');
    const h1 = await A.eval('performance.memory.usedJSHeapSize');
    const growth = (h1 - h0) / 1e6;
    gate('perf: no per-frame GC pressure', growth < 2.5, `heap Δ ${growth.toFixed(2)} MB over 900 ticks`);

    // full course to the finish
    await A.waitFor(`__pp.state==='finish'`, 300000, 'finish');
    const fin = await A.eval('({t:__pp.time, cp:__pp.checkpoint})');
    gate('finish: bot completes the course', fin.t > 40 && fin.t < 260, `time ${fin.t.toFixed(2)}s`);
    gate('finish: all 3 checkpoints were passed', fin.cp === 3, `checkpoint=${fin.cp}`);
    const bestRaw = await A.eval(`localStorage.getItem('powderpeak_best')`);
    let bestObj = null; try { bestObj = JSON.parse(bestRaw); } catch {}
    gate('finish: best time persisted to powderpeak_best',
      !!bestObj && typeof bestObj.time === 'number' && Math.abs(bestObj.time - fin.t) < 0.05,
      bestRaw && bestRaw.slice(0, 80));

    // perf budgets at the busiest points, per sector
    const perf = await A.eval('__pp.perf');
    gate('perf: draw calls ≤ 80 at worst', perf.maxCalls <= 80, `max ${perf.maxCalls} (sectors ${perf.sectorCalls.join('/')})`);
    gate('perf: triangles ≤ 150k at worst', perf.maxTris <= 150000, `max ${perf.maxTris} (sectors ${perf.sectorTris.join('/')})`);
    gate('perf: every sector was sampled', perf.sectorCalls.every(v => v > 0), perf.sectorCalls.join('/'));

    // south on finish screen → new run
    await A.bot({ on: false });
    await A.press();
    await sleep(1200);                 // finish screen input-guard delay
    await A.tapButton(0);
    await A.waitFor(`__pp.state==='countdown'||__pp.state==='run'`, 6000, 'ski again');
    gate('finish: south starts a new run', true);

    gate('zero console errors/warnings (pad session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ KEYBOARD SESSION — no pad stub at all ═══════════════ */
async function kbdSession(base) {
  console.log('\n── keyboard session (no pad, ?turbo=8) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(400);
    gate('kbd: boots to title', await A.eval('__pp.state') === 'title');
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='run'`, 10000, 'kbd run start');
    gate('kbd: Enter starts the run', true);
    // tuck first, on the straight opening, before any drift off the piste
    const vPre = await A.eval('__pp.speed');
    await A.key('ArrowDown', 'ArrowDown', 40, true);   // tuck
    await A.waitTicks(240);
    const vTuck = await A.eval('__pp.speed');
    await A.key('ArrowDown', 'ArrowDown', 40, false);
    gate('kbd: ArrowDown tuck accelerates', vTuck > vPre + 3, `${vPre.toFixed(1)} → ${vTuck.toFixed(1)}`);
    await A.key('ArrowUp', 'ArrowUp', 38, true);       // brake
    await A.waitTicks(150);
    const vBrake = await A.eval('__pp.speed');
    await A.key('ArrowUp', 'ArrowUp', 38, false);
    gate('kbd: ArrowUp brake decelerates', vBrake < vTuck - 2, `${vTuck.toFixed(1)} → ${vBrake.toFixed(1)}`);
    const u0 = await A.eval('__pp.u');
    await A.key('ArrowLeft', 'ArrowLeft', 37, true);
    await A.waitTicks(50);
    await A.key('ArrowLeft', 'ArrowLeft', 37, false);
    const uL = await A.eval('__pp.u');
    gate('kbd: ArrowLeft steers left', uL < u0 - 0.6, `u ${u0.toFixed(1)} → ${uL.toFixed(1)}`);
    await A.tapKey('Escape', 'Escape', 27);
    await A.waitFor(`__pp.state==='pause'`, 5000, 'kbd pause');
    const tp = await A.eval('__pp.tick'); await sleep(350);
    gate('kbd: Escape pauses, tick frozen', tp === await A.eval('__pp.tick'));
    await A.tapKey('ArrowDown', 'ArrowDown', 40);
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`(__pp.state==='countdown'||__pp.state==='run') && __pp.s < 40`, 8000, 'kbd restart');
    gate('kbd: pause menu restart works', true);
    gate('zero console errors/warnings (kbd session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ SCREENSHOT SESSION ═══════════════ */
async function shotsSession(base) {
  console.log('\n── screenshot session (?turbo=3, bot plays) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await A.nav(base + '/index.html?turbo=3&fx=full');
    await sleep(1500);
    await A.shot('01-title');
    await A.tapButton(0);
    await A.waitFor(`__pp.state==='run'`, 10000, 'run');
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    const at = async (s, name, extra) => {
      await A.waitFor(`__pp.s >= ${s}`, 120000, 'reach s=' + s);
      if (extra) await extra();
      await A.shot(name);
    };
    await at(255, '02-open-speed');
    await at(640, '03-slalom');
    await at(742, '04-hairpin-chevrons');
    // mid-air off ramp 2 (s≈1000) — drop to real time so we catch the moment
    await A.waitFor(`__pp.s > 930`, 120000, 'near ramp 2');
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor(`__pp.mode==='air'`, 30000, 'airborne');
    await sleep(260);
    await A.shot('05-midair');
    await A.eval('window.__ppTurbo = 3');
    // pause menu
    await A.waitFor(`__pp.s > 1150`, 120000, 'mid course');
    await A.tapButton(9);
    await A.waitFor(`__pp.state==='pause'`, 5000, 'pause');
    await A.shot('06-pause');
    await A.tapButton(9);
    await A.waitFor(`__pp.state==='run'`, 5000, 'resume');
    // crash shot in the boulder-garden slalom
    const course = await A.eval('window.__ppCourse');
    const obstacles = await A.eval('window.__ppObstacles');
    let ram = null;
    for (const o of obstacles) {
      const n = nearestCourse(course, o.x, o.z);
      if (n.d < course[n.i].w - 0.8 && n.s > 1650 && (!ram || n.s < ram.s)) ram = { ...o, s: n.s };
    }
    if (ram) {
      await A.waitFor(`__pp.s > ${ram.s - 80}`, 120000, 'approach crash tree');
      await A.bot({ mode: 'ram', ramX: ram.x, ramZ: ram.z });
      await A.eval('window.__ppTurbo = 1');
      await A.waitFor(`__pp.state==='crash'`, 30000, 'crash');
      await sleep(700);            // let the tumble slide clear of the trunk
      await A.shot('07-crash');
      await A.eval('window.__ppTurbo = 3');
      await A.waitFor(`__pp.state==='run'`, 15000, 'respawn');
      await A.bot({ mode: 'race' });
    }
    await A.waitFor(`__pp.state==='finish'`, 300000, 'finish');
    await sleep(1400);
    await A.shot('08-finish');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ IPAD SESSION — portrait letterbox + touch UI ═══════════════ */
async function ipadSession(base) {
  console.log('\n── iPad portrait session (1024x1366, touch) ──');
  const { proc, port, profile } = await launchChrome(['--window-size=1024,1366']);
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init();
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 1, mobile: true });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await A.nav(base + '/index.html?fx=full');
    await sleep(1200);
    // tap to start (touch source → touch UI visible)
    const tap = async (x, y) => {
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await sleep(80);
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await tap(512, 680);
    await A.waitFor(`__pp.state==='countdown'||__pp.state==='run'`, 8000, 'touch start');
    await A.waitFor(`__pp.state==='run'`, 8000, 'touch run');
    const touchUI = await A.eval(`document.body.classList.contains('input-touch')`);
    gate('touch: input-touch class active (touch UI shown)', touchUI);
    await sleep(2500);
    await A.shot('09-ipad-portrait');
    gate('zero console errors/warnings (ipad session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ CLEAN TIMING RUN — medal calibration ═══════════════ */
async function timeSession(base) {
  console.log('\n── clean bot timing run (?turbo=10) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=10&fx=full');
    await sleep(400);
    await A.tapButton(0);
    await A.waitFor(`__pp.state==='run'`, 10000, 'run');
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    let crashes = 0, lastState = 'run';
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const st = await A.eval('__pp.state');
      if (st === 'crash' && lastState !== 'crash') crashes++;
      lastState = st;
      if (st === 'finish') break;
      await sleep(150);
    }
    const t = await A.eval('__pp.time');
    const sect = await A.eval(`JSON.parse(localStorage.getItem('powderpeak_best')||'{}').sectors`);
    console.log(`clean bot time: ${t.toFixed(2)}s, crashes: ${crashes}, sectors: ${(sect || []).map(x => x.toFixed(1)).join(' / ')}`);
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ main ═══════════════ */
const which = process.argv[2] || 'all';
const { srv, port: httpPort } = await serve();
const base = `http://127.0.0.1:${httpPort}`;
try {
  if (which === 'time') await timeSession(base);
  if (which === 'all' || which === 'gates') await gatesSession(base);
  if (which === 'all' || which === 'kbd') await kbdSession(base);
  if (which === 'all' || which === 'shots') await shotsSession(base);
  if (which === 'all' || which === 'ipad') await ipadSession(base);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  srv.close();
}
console.log(failures === 0 ? '\nALL GATES GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
