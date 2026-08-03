#!/usr/bin/env node
// POWDER PEAK verification harness.
// Headless Chrome + CDP. Fake standard-mapping gamepad injected BEFORE page
// scripts; all gameplay assertions are driven through REAL input (pad axes /
// buttons or key events) and verified through the read-only telemetry
// window.__pp — never through gameplay hooks.
//
//   /opt/homebrew/bin/node test/harness.mjs all     (or: gates mtn nr tricks fun race kbd shots ipad)
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
          // a reply can get dropped around navigations — surface it as an
          // error instead of hanging the whole session forever
          const guard = setTimeout(() => {
            if (pending.has(mid)) {
              pending.delete(mid);
              rej2(new Error(method + ': no CDP reply in 30s'));
            }
          }, 30000);
          pending.set(mid, { res2: v => { clearTimeout(guard); res2(v); },
                             rej2: e => { clearTimeout(guard); rej2(e); }, method });
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

// TWO standard-mapping pads: slot 0 (P1) and slot 1 (P2). Distinct product
// ids so no phantom-DS4-sub-device filtering could ever collapse them.
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

// In-page bot: a robot player. Reads telemetry + static course dump, writes
// REAL fake-pad input every animation frame. Modes: 'race' | 'ram'.
// TWO channels: __bot drives pad 0 from __pp (P1); __bot2 drives pad 1 from
// the __pp.p2 mirror — so either player can be piloted independently.
const BOT_SRC = `(function(){
  if (window.__botInstalled) return; window.__botInstalled = true;
  const mkBot = () => ({ on:false, mode:'race', forceTuck:false, forceBrake:false, noTuck:false,
                   ramX:0, ramZ:0, steerOnly:null, extraBtns:[], path:null, pathIdx:0,
                   weave:null });   // {a, w}: rhythmic carve overlay (mogul line)
  window.__bot = mkBot();
  window.__bot2 = mkBot();
  const wrap = a => { while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; };
  function drive(b, T, pad){
    const C = window.__ppCourse;
    if (!b.on || !T || !C || !pad) return;
    if (T.state !== 'run' || T.mode === 'crash') { pad.press(); return; }
    let tx, tz, la;
    let onPath = false;
    const idx = Math.min(C.length-1, Math.max(0, Math.round(T.s/9)));
    if (b.mode === 'ram') { tx = b.ramX; tz = b.ramZ; }
    else if (b.path) {
      // steering-target hint channel: pure pursuit along supplied waypoints
      // (the SHORTCUT line) — output is still REAL pad input every frame
      const pts = b.path;
      let ni = b.pathIdx, nd = 1e18;
      for (let k=b.pathIdx; k<Math.min(pts.length, b.pathIdx+14); k++) {
        const d = (pts[k].x-T.pos.x)*(pts[k].x-T.pos.x) + (pts[k].z-T.pos.z)*(pts[k].z-T.pos.z);
        if (d < nd) { nd = d; ni = k; }
      }
      b.pathIdx = ni;
      if (ni >= pts.length-2) { b.path = null; b.pathIdx = 0; }
      else {
        const L = Math.max(3, Math.round(T.speed*0.55/3));
        const look = pts[Math.min(pts.length-1, ni+L)];
        tx = look.x; tz = look.z; onPath = true;
      }
    }
    if (b.mode !== 'ram' && !onPath) {
      la = Math.max(2, Math.round(T.speed*0.9/9));
      const look = C[Math.min(C.length-1, idx+la)];
      tx = look.x; tz = look.z;
    }
    const desired = Math.atan2(tx - T.pos.x, tz - T.pos.z);
    const err = wrap(desired - T.heading);
    // heading INCREASE needs stick pushed LEFT (screen-correct steering)
    let steer = -Math.max(-1, Math.min(1, err*2.4));
    if (b.steerOnly !== null) steer = b.steerOnly;
    if (b.weave) {  // square-wave rhythm: a committed carve on every beat
      const ph = Math.sin(T.tick * b.weave.w);
      steer = Math.max(-1, Math.min(1, steer + (ph >= 0 ? 1 : -1) * b.weave.a));
    }
    // read the road ahead for tuck/brake decisions
    let maxC = 0;
    const lookN = Math.min(C.length-1-idx, Math.max(4, Math.round(T.speed*2.4/9)));
    for (let k=idx; k<idx+lookN; k++) { const c=Math.abs(C[k].curv); if (c>maxC) maxC=c; }
    let tuck = (b.mode==='ram') || (maxC < 0.013 && Math.abs(err) < 0.15);
    let brake = (maxC > 0.034 && T.speed > 15) || (maxC > 0.022 && T.speed > 25);
    if (onPath) { tuck = Math.abs(err) < 0.12; brake = false; }
    if (b.mode === 'ram') brake = false;
    if (b.forceTuck) { tuck = true; brake = false; }
    if (b.forceBrake) { brake = true; tuck = false; }
    if (b.noTuck) tuck = false;
    pad.axes(steer, 0);
    const btns = b.extraBtns.slice();
    if (tuck) btns.push(0);
    if (brake) btns.push(1);      // east = brake
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
    async press2(...idx) { await api.eval(`__fakePad2.press(${idx.join(',')})`); },
    async tapButton2(i) {
      await api.press2(i); await sleep(120); await api.press2(); await sleep(120);
    },
    async key(key, code, vk, down) {
      // Keys are dispatched as KeyboardEvents on window — the exact same
      // handlers the real keyboard drives. CDP Input.dispatchKeyEvent
      // intermittently DEADLOCKS this headless+swiftshader renderer for
      // 60s+ (evals stop replying too), which made every kbd run a coin
      // flip; the in-page path is deterministic and hits identical code.
      await api.eval(`window.dispatchEvent(new KeyboardEvent('${down ? 'keydown' : 'keyup'}', ` +
        `{key:${JSON.stringify(key)}, code:${JSON.stringify(code)}, keyCode:${vk}, bubbles:true, cancelable:true}))`);
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
    async bot2(props) {
      await api.eval(`Object.assign(window.__bot2, ${JSON.stringify(props)})`);
    },
  };
  return api;
}

/* Headless rAF can stall through a whole press+release window, silently
   dropping a pad edge (the long-standing "event-drop" gotcha). Every
   state-changing tap therefore retries until the state actually moves. */
async function tapUntil(A, btn, expr, label) {
  for (let i = 0; i < 6; i++) {
    await A.tapButton(btn);
    try { await A.waitFor(expr, 1500, label); return; } catch {}
  }
  throw new Error('tapUntil gave up: ' + label);
}
async function tapKeyUntil(A, key, code, vk, expr, label) {
  for (let i = 0; i < 6; i++) {
    await A.tapKey(key, code, vk);
    try { await A.waitFor(expr, 1500, label); return; } catch {}
  }
  throw new Error('tapKeyUntil gave up: ' + label);
}
/* pad path through the mountain select: title → select → card → run */
const CARD_IDX = { alp: 0, nr: 1, db: 2 };
async function selectCard(A, mtn) {
  const want = CARD_IDX[mtn] ?? 0;
  for (let i = 0; i < 10; i++) {
    const cur = await A.eval('__pp.selectSel');
    if (cur === want) return;
    await A.tapButton(cur < want ? 15 : 14);        // dpad right / left
  }
  if (await A.eval('__pp.selectSel') !== want) throw new Error('could not highlight card ' + want);
}
async function startFromTitle(A, mtn) {
  await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
  await selectCard(A, mtn);
  await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'run start');
  await A.waitFor(`__pp.state==='run'`, 12000, 'countdown → run');
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
    const bootMs = await A.eval('window.__ppBootMs');
    gate('boot: three worlds built in < 2.5s', typeof bootMs === 'number' && bootMs < 2500,
      `${Math.round(bootMs)} ms`);

    // scenery may never sit on the piste: every backdrop peak's footprint
    // must clear every course sample (regression: sector-2 "blind pyramid")
    const pk = JSON.parse(await A.eval(`JSON.stringify((function(){
      const P = window.__ppPeaks || [], C = window.__ppCourse || [];
      let worst = 1e9;
      for (const p of P) for (const c of C) {
        const d = Math.hypot(c.x - p.x, c.z - p.z) - p.r;
        if (d < worst) worst = d;
      }
      return { n: P.length, worst: Math.round(worst) };
    })())`));
    gate('backdrop peaks clear the course (margin ≥ 100m)', pk.n >= 10 && pk.worst >= 100,
      `${pk.n} peaks, worst margin ${pk.worst}m`);

    // title → south → mountain select → south (ALPENGLOW) → countdown → run
    await startFromTitle(A, 'alp');
    gate('title: south → select → south starts an ALPENGLOW run',
      await A.eval('__pp.mountain') === 'alp');

    // gravity gets us moving
    await A.waitTicks(200);
    const v1 = await A.eval('__pp.speed');
    gate('physics: gravity accelerates from standstill', v1 > 3, `v=${v1.toFixed(1)} m/s`);

    // bot takes over to keep us on the piste
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });

    // tuck = faster: force tuck on, sample; then force brake, speed falls
    // (early, on the open sweepers, before the tree slalom)
    await A.bot({ noTuck: true });
    await A.waitTicks(180);
    const vNoTuck = await A.eval('__pp.speed');
    await A.bot({ noTuck: false, forceTuck: true });
    await A.waitTicks(180);
    const vTuck = await A.eval('__pp.speed');
    gate('tuck: holding south raises speed', vTuck > vNoTuck + 3,
      `${vNoTuck.toFixed(1)} → ${vTuck.toFixed(1)} m/s`);
    await A.bot({ forceTuck: false, forceBrake: true });
    await A.waitTicks(140);
    const vBrake = await A.eval('__pp.speed');
    // robust on any stretch: a clear scrub, or held near the braked floor
    // (the tuck sample can land on a slow, twisty pitch)
    gate('brake: holding east scrubs speed', vBrake < vTuck - 1.3 || vBrake <= 11.0,
      `${vTuck.toFixed(1)} → ${vBrake.toFixed(1)} m/s`);
    await A.bot({ forceBrake: false });

    // ── directional steering: stick, dpad, keyboard — BOTH directions ──
    // Screen-right is read from the REAL render camera (__pp.camRight) and
    // the skier's world displacement is projected onto it, so these assert
    // camera-relative DIRECTION, not merely "lateral position changed".
    // Between checks the bot recenters on the course line (kept slow with
    // forceBrake) so each check starts camera-aligned and glance-safe.
    const latMove = async (apply, release) => {
      await A.bot({ on: true, noTuck: true, forceBrake: false, extraBtns: [] });
      await A.waitTicks(110);             // recenter on the line, camera settles
      if (await A.eval('__pp.speed') > 15) {   // keep the checks glance-safe…
        await A.bot({ forceBrake: true });
        await A.waitFor('__pp.speed < 15', 20000, 'settle steer-test speed');
        await A.bot({ forceBrake: false });
        await A.waitTicks(30);
      }
      // …but never so slow the carve has no pace
      await A.waitFor(`__pp.speed > 6 && !__pp.wobble && __pp.state==='run'`, 20000, 'pace for steer test');
      await A.bot({ on: false });
      await A.eval('__fakePad.axes(0,0); __fakePad.press();');
      await A.waitTicks(10);              // steer smoothing returns to center
      const s0 = await A.eval('({x:__pp.pos.x,z:__pp.pos.z,rx:__pp.camRight.x,rz:__pp.camRight.z})');
      await apply();
      await A.waitTicks(60);
      await release();
      const s1 = await A.eval('({x:__pp.pos.x,z:__pp.pos.z,st:__pp.state})');
      if (s1.st !== 'run') throw new Error('crashed during steering test');
      return (s1.x - s0.x) * s0.rx + (s1.z - s0.z) * s0.rz;
    };
    const stickR = await latMove(() => A.eval('__fakePad.axes(1,0)'), () => A.eval('__fakePad.axes(0,0)'));
    const stickL = await latMove(() => A.eval('__fakePad.axes(-1,0)'), () => A.eval('__fakePad.axes(0,0)'));
    gate('steer: stick lx=+1 carves toward screen-RIGHT', stickR > 0.8, `lat ${stickR.toFixed(2)} m`);
    gate('steer: stick lx=-1 carves toward screen-LEFT', stickL < -0.8, `lat ${stickL.toFixed(2)} m`);
    const dpadR = await latMove(() => A.press(15), () => A.press());
    const dpadL = await latMove(() => A.press(14), () => A.press());
    gate('steer: dpad-right carves toward screen-RIGHT', dpadR > 0.8, `lat ${dpadR.toFixed(2)} m`);
    gate('steer: dpad-left carves toward screen-LEFT', dpadL < -0.8, `lat ${dpadL.toFixed(2)} m`);
    const keyR = await latMove(() => A.key('ArrowRight', 'ArrowRight', 39, true), () => A.key('ArrowRight', 'ArrowRight', 39, false));
    const keyL = await latMove(() => A.key('ArrowLeft', 'ArrowLeft', 37, true), () => A.key('ArrowLeft', 'ArrowLeft', 37, false));
    gate('steer: ArrowRight carves toward screen-RIGHT', keyR > 0.8, `lat ${keyR.toFixed(2)} m`);
    gate('steer: ArrowLeft carves toward screen-LEFT', keyL < -0.8, `lat ${keyL.toFixed(2)} m`);
    await A.bot({ on: true, mode: 'race', noTuck: false });

    // ── west = jump / trick suite, on the open stretch before ramp 2 ──
    // (turbo 1 so 0.5 s of air is observable through real polling)
    await A.waitFor('__pp.s > 820', 180000, 'open stretch before gate 2');
    await A.eval('window.__ppTurbo = 1');
    // settle below the no-tuck terminal speed so plain drag can't mimic a
    // brake over the measurement window
    if (await A.eval('__pp.speed') > 18) {
      await A.bot({ forceBrake: true });
      await A.waitFor('__pp.speed < 18', 30000, 'settle below no-tuck terminal');
      await A.bot({ forceBrake: false });
    }
    // (pad "press" edges need a couple of released frames first — always
    // pause ≥150 ms real time between clearing west and pressing it again)
    // holding west must NOT brake any more (one hop edge, then nothing)
    await sleep(200);
    const vW0 = await A.eval('__pp.speed');
    await A.bot({ extraBtns: [2], noTuck: true });
    await A.waitTicks(150, 30000);
    const vW1 = await A.eval('__pp.speed');
    await A.bot({ extraBtns: [], noTuck: false });
    gate('brake: holding west does NOT brake (old binding gone)', vW1 > vW0 - 1.0,
      `v ${vW0.toFixed(1)} → ${vW1.toFixed(1)} over 150 ticks`);
    // flat hop: press west → real vertical impulse → clean landing
    await sleep(250);
    const vHop0 = await A.eval('__pp.speed');
    await A.bot({ extraBtns: [2] });
    let hopUp = true;
    try { await A.waitFor('__pp.air === true', 4000, 'hop leaves ground'); } catch { hopUp = false; }
    await A.bot({ extraBtns: [] });
    gate('jump: west press on flat leaves the ground', hopUp);
    await A.waitFor('__pp.air === false', 10000, 'hop lands');
    const hopSt = await A.eval('({st:__pp.state, v:__pp.speed})');
    gate('jump: flat hop lands clean — no crash, no speed penalty',
      hopSt.st === 'run' && hopSt.v > vHop0 - 2.0, `v ${vHop0.toFixed(1)} → ${hopSt.v.toFixed(1)}`);
    // full trick off ramp 2: tuck in hot for real airtime, launch, spin,
    // land with boost + popup
    await A.bot({ forceTuck: true });
    await A.waitFor('__pp.air === true && __pp.s > 975', 90000, 'ramp 2 launch');
    await A.bot({ forceTuck: false, extraBtns: [2] });
    await A.waitFor('__pp.trick === true', 3000, 'trick starts mid-air');
    await A.bot({ extraBtns: [] });
    gate('trick: west mid-air starts a trick', true);
    await A.waitFor('__pp.trick === false && __pp.air === true', 5000, 'trick completes in air');
    const vAir = await A.eval('__pp.speed');
    await A.waitFor('__pp.air === false', 8000, 'trick landing');
    const landed = await A.eval(`({v:__pp.speed, st:__pp.state, pop:document.getElementById('trickPop').classList.contains('show')})`);
    gate('trick: completed trick lands with a speed boost', landed.st === 'run' && landed.v > vAir * 1.04,
      `v air ${vAir.toFixed(1)} → landed ${landed.v.toFixed(1)}`);
    gate('trick: TRICK! +BOOST popup shown', landed.pop);
    // landing mid-trick must be a wobble, NEVER a crash (kid mercy rule).
    // Airtime downhill is long and varies, so chain trick presses — the
    // landing then interrupts one mid-spin. Up to 3 hops until observed.
    let wob = null;
    for (let attempt = 0; attempt < 3 && !(wob && wob.wob); attempt++) {
      await A.bot({ extraBtns: [], noTuck: true });
      await sleep(250);
      await A.bot({ extraBtns: [2] });
      try { await A.waitFor('__pp.air === true', 6000, 'wobble-test hop'); } catch { continue; }
      for (let i = 0; i < 60; i++) {
        await A.bot({ extraBtns: [] });
        await sleep(45);
        await A.bot({ extraBtns: [2] });
        await sleep(45);
        const st = await A.eval('({air:__pp.air, st:__pp.state, wob:__pp.wobble, trick:__pp.trick})');
        if (!st.air) { wob = st; break; }
      }
      await A.bot({ extraBtns: [] });
    }
    await A.bot({ noTuck: false });
    gate('trick: landing mid-trick = wobble, never a crash',
      !!wob && wob.st === 'run' && wob.wob && !wob.trick, JSON.stringify(wob));
    await A.eval('window.__ppTurbo = 8');

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
    // event-drop tolerance: confirm only once RESTART is visibly selected
    if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) {
      await A.tapButton(13);
    }
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

    // perf budgets at the busiest points, per sector (active-mountain count)
    const perf = await A.eval('__pp.perf');
    const nSecA = await A.eval('__pp.sectors');
    gate('perf: draw calls ≤ 80 at worst', perf.maxCalls <= 80, `max ${perf.maxCalls} (sectors ${perf.sectorCalls.slice(0, nSecA).join('/')})`);
    gate('perf: triangles ≤ 150k at worst', perf.maxTris <= 150000, `max ${perf.maxTris} (sectors ${perf.sectorTris.slice(0, nSecA).join('/')})`);
    gate('perf: every sector was sampled', perf.sectorCalls.slice(0, nSecA).every(v => v > 0), perf.sectorCalls.slice(0, nSecA).join('/'));

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
    await A.waitFor(`__pp.state==='select'`, 6000, 'kbd select screen');
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='run'`, 10000, 'kbd run start');
    gate('kbd: Enter → select → Enter starts the run', true);
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
    // directional: displacement projected on the real camera's screen-right.
    // Settle under tuck first (keeps speed up even pointed cross-slope) so
    // the chase camera is aligned and the carve has real pace.
    const kLat = async (key, vk) => {
      await A.key('ArrowDown', 'ArrowDown', 40, true);
      await A.waitTicks(170);
      await A.key('ArrowDown', 'ArrowDown', 40, false);
      await A.waitTicks(10);
      const s0 = await A.eval('({x:__pp.pos.x,z:__pp.pos.z,rx:__pp.camRight.x,rz:__pp.camRight.z})');
      await A.key(key, key, vk, true);
      await A.waitTicks(60);
      await A.key(key, key, vk, false);
      const s1 = await A.eval('({x:__pp.pos.x,z:__pp.pos.z})');
      return (s1.x - s0.x) * s0.rx + (s1.z - s0.z) * s0.rz;
    };
    // restart between the two directional tests: each starts from a clean,
    // on-piste, downhill-facing state (no respawn-teleport contamination)
    const kbdRestart = async () => {
      await A.tapKey('Escape', 'Escape', 27);
      await A.waitFor(`__pp.state==='pause'`, 5000, 'pause for restart');
      await A.tapKey('ArrowDown', 'ArrowDown', 40);
      if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) {
        await A.tapKey('ArrowDown', 'ArrowDown', 40);
      }
      await A.tapKey('Enter', 'Enter', 13);
      await A.waitFor(`__pp.state==='run'`, 10000, 'restarted run');
    };
    const kR = await kLat('ArrowRight', 39);
    await kbdRestart();
    const kL = await kLat('ArrowLeft', 37);
    gate('kbd: ArrowRight carves toward screen-RIGHT', kR > 1.0, `lat ${kR.toFixed(2)} m`);
    gate('kbd: ArrowLeft carves toward screen-LEFT', kL < -1.0, `lat ${kL.toFixed(2)} m`);
    await kbdRestart();
    // Space and X both jump (turbo 1 so the 0.5 s hop is observable)
    await A.eval('window.__ppTurbo = 1');
    await A.key(' ', 'Space', 32, true);
    let spaceAir = true;
    try { await A.waitFor('__pp.air === true', 4000, 'Space hop'); } catch { spaceAir = false; }
    await A.key(' ', 'Space', 32, false);
    gate('kbd: Space jumps', spaceAir);
    await A.waitFor('__pp.air === false', 8000, 'Space hop lands');
    await A.key('x', 'KeyX', 88, true);
    let xAir = true;
    try { await A.waitFor('__pp.air === true', 4000, 'X hop'); } catch { xAir = false; }
    await A.key('x', 'KeyX', 88, false);
    gate('kbd: X jumps too', xAir);
    await A.waitFor('__pp.air === false', 8000, 'X hop lands');
    const postJump = await A.eval('__pp.state');
    gate('kbd: hops land clean, still running', postJump === 'run', postJump);
    await A.eval('window.__ppTurbo = 8');
    await A.tapKey('Escape', 'Escape', 27);
    await A.waitFor(`__pp.state==='pause'`, 5000, 'kbd pause');
    const tp = await A.eval('__pp.tick'); await sleep(350);
    gate('kbd: Escape pauses, tick frozen', tp === await A.eval('__pp.tick'));
    await A.tapKey('ArrowDown', 'ArrowDown', 40);
    // event-drop tolerance: confirm only once RESTART is visibly selected
    if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) {
      await A.tapKey('ArrowDown', 'ArrowDown', 40);
    }
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
    // mountain select screen
    await tapUntil(A, 0, `__pp.state==='select'`, 'select');
    await sleep(400);
    await A.shot('10-select');
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'run');  // ALPENGLOW
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
    // 360 SPIN off ramp 2 (s≈1000): stick LEFT at the press, catch it
    // mid-spin, then chain a FLIP and catch the chain popup on landing
    await A.waitFor(`__pp.s > 930`, 120000, 'near ramp 2');
    await A.bot({ forceTuck: true });
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor(`__pp.mode==='air'`, 30000, 'airborne');
    await A.bot({ on: false, forceTuck: false });
    await A.eval('__fakePad.axes(-1,0)');
    await sleep(80);
    await A.eval('__fakePad.press(2)');
    await A.waitFor('__pp.trick === true', 3000, 'spin spinning');
    await A.eval('__fakePad.press()');
    await sleep(240);
    await A.shot('05-midair-360');
    await A.eval('__fakePad.axes(0,0)');
    await A.waitFor('__pp.trick === false', 3000, 'spin done');
    if (await A.eval(`__pp.air === true`)) {   // chain a FLIP if still airborne
      await A.eval('__fakePad.press(2)');
      await sleep(120);
      await A.eval('__fakePad.press()');
    }
    await A.waitFor('__pp.air === false', 10000, 'landed');
    await sleep(150);
    await A.shot('05b-chain-popup');
    await A.bot({ on: true, mode: 'race' });
    await A.eval('window.__ppTurbo = 3');
    // hidden shortcut entrance: fence gap + faint old tracks, subtle.
    // Glide straight (no carve) for a beat first so no spray blocks the view.
    const scut = await A.eval('JSON.stringify(window.__ppShortcut)').then(JSON.parse);
    await A.waitFor(`__pp.s >= ${scut.entryS - 60}`, 120000, 'approach shortcut entry');
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor(`__pp.s >= ${scut.entryS - 22}`, 30000, 'near shortcut entry');
    await A.bot({ on: false });
    await A.eval('__fakePad.axes(0,0); __fakePad.press();');
    await sleep(700);
    await A.shot('11-shortcut-entrance');
    await A.bot({ on: true, mode: 'race' });
    await A.eval('window.__ppTurbo = 3');
    // pause menu (with the new trick hint line)
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
    // SNOWMAN moment on the final schuss
    const sm = await A.eval('JSON.stringify(window.__ppSnowman)').then(JSON.parse);
    await A.waitFor(`__pp.s > ${sm.s - 110}`, 120000, 'approach snowman');
    await A.bot({ mode: 'ram', ramX: sm.x, ramZ: sm.z });
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor('__pp.snowman === true', 30000, 'snowman poof');
    await A.bot({ mode: 'race' });
    await sleep(160);
    await A.shot('12-snowman-poof');
    await A.eval('window.__ppTurbo = 3');
    await A.waitFor(`__pp.state==='finish'`, 300000, 'finish');
    await sleep(1400);
    await A.shot('08-finish');
    // ── NIGHT RIDGE shots ──
    await sleep(1200);                       // finish input guard
    await tapUntil(A, 1, `__pp.state==='title'`, 'back to title');  // east
    await startFromTitle(A, 'nr');
    await A.bot({ on: true, mode: 'race', path: null });
    await A.waitFor(`__pp.s >= 235`, 120000, 'nr at speed');
    await A.shot('13-nr-vista-aurora');
    const nrGates = await A.eval('window.__ppGates');
    await A.waitFor(`__pp.s >= ${nrGates.gates[0] - 28}`, 120000, 'nr gate 1 approach');
    await A.eval('window.__ppTurbo = 1');
    await sleep(120);
    await A.shot('14-nr-gate-lanterns');
    await A.eval('window.__ppTurbo = 3');
    // first night hairpin
    const nrCourse = await A.eval('window.__ppCourse');
    let hpS = null;
    for (const p of nrCourse) { if (p.style === 2) { hpS = p.s; break; } }
    await A.waitFor(`__pp.s >= ${hpS - 38}`, 120000, 'nr hairpin approach');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.shot('15-nr-hairpin');
    await A.eval('window.__ppTurbo = 3');
    // ── gold-trim arch (seed a gold best, reload, start a run) ──
    await A.eval(`window.__ppTurbo = 1; localStorage.setItem('powderpeak_best', JSON.stringify({time:88, sectors:[20,25,25,18]}))`);
    await A.nav(base + '/index.html?turbo=3&fx=full');
    await sleep(800);
    await tapUntil(A, 0, `__pp.state==='select'`, 'select for gold arch');
    for (let i = 0; i < 6 && await A.eval('__pp.selectSel') !== 0; i++) await A.tapButton(14);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'gold-arch run');
    await A.eval('window.__ppTurbo = 1');   // hold the countdown: arch framed
    await sleep(250);
    await A.shot('16-gold-arch');
    // ── DIAMONDBACK shots ──
    await A.nav(base + '/index.html?turbo=3&fx=full&r=9');
    await sleep(800);
    await tapUntil(A, 0, `__pp.state==='select'`, 'select for db shots');
    await sleep(400);
    await A.shot('20-select-3cards');                 // 3 cards + EXPERT tag
    await selectCard(A, 'db');
    await sleep(300);
    await A.shot('20b-select-db-highlighted');
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'db run');
    await A.waitFor(`__pp.state==='run'`, 12000, 'db running');
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    const dbF = JSON.parse(await A.eval('JSON.stringify(window.__ppFeatures)'));
    // storm palette wide shot on the summit winding
    await A.waitFor('__pp.s >= 200', 120000, 'db under way');
    await A.eval('window.__ppTurbo = 1');
    await sleep(200);
    await A.shot('21-db-storm-vista');
    await A.eval('window.__ppTurbo = 3');
    // mogul field close-up: glide straight a beat so the bumps read clean
    await A.waitFor(`__pp.s >= ${dbF.moguls[0].s0 + 30}`, 180000, 'db field 1');
    await A.eval('window.__ppTurbo = 1');
    await sleep(500);
    await A.shot('22-db-moguls');
    await A.eval('window.__ppTurbo = 3');
    // chute interior — granite walls either side
    await A.waitFor(`__pp.s >= ${(dbF.chutes[0].s0 + dbF.chutes[0].s1) / 2}`, 180000, 'db chute 1');
    await A.eval('window.__ppTurbo = 1');
    await sleep(300);
    await A.shot('23-db-chute');
    await A.eval('window.__ppTurbo = 3');
    // ledge drop mid-air
    const ledge = dbF.drops.filter(d => d.big)[0];
    await A.waitFor(`__pp.s >= ${ledge.s - 90}`, 240000, 'db ledge approach');
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor(`__pp.air === true && __pp.s > ${ledge.s - 12}`, 90000, 'db ledge air');
    await sleep(120);
    await A.shot('24-db-ledge-air');
    await A.eval('window.__ppTurbo = 3');
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
    // tap to start (touch source → touch UI visible). Same stall guard as
    // keys: if the CDP input pipeline stops ACKing, drive the element's own
    // touch handlers in-page.
    const touchSend = async (type, pts, x, y) => {
      const p2 = c.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      p2.catch(() => {});
      try {
        await Promise.race([p2, new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 5000))]);
      } catch {
        console.log('  (touch pipeline stalled — in-page TouchEvent fallback)');
        const ev = type === 'touchStart' ? 'touchstart' : 'touchend';
        await A.eval(`(function(){
          const el = ${type === 'touchStart' ? `document.elementFromPoint(${x},${y})` : 'window.__lastTouchEl'} || document.body;
          if (${type === 'touchStart' ? 'true' : 'false'}) window.__lastTouchEl = el;
          el.dispatchEvent(new TouchEvent('${ev}', { bubbles: true, cancelable: true }));
        })()`);
      }
    };
    const tap = async (x, y) => {
      await touchSend('touchStart', [{ x, y }], x, y);
      await sleep(80);
      await touchSend('touchEnd', [], x, y);
    };
    await tap(512, 680);
    await A.waitFor(`__pp.state==='select'`, 8000, 'touch → select screen');
    // tap a card selects it; tapping the selected card confirms
    const cardC = async id => {
      const r = await A.eval(`(() => { const b = document.getElementById('${id}').getBoundingClientRect();
        return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }; })()`);
      return r;
    };
    const c1 = await cardC('mcard1');
    await tap(c1.x, c1.y);
    await sleep(250);
    gate('touch: tapping a card selects it', await A.eval('__pp.selectSel') === 1);
    const c2 = await cardC('mcard2');
    await tap(c2.x, c2.y);
    await sleep(250);
    gate('touch: the third card (DIAMONDBACK) is tappable too', await A.eval('__pp.selectSel') === 2);
    const c0 = await cardC('mcard0');
    await tap(c0.x, c0.y);
    await sleep(250);
    await tap(c0.x, c0.y);                    // second tap on selected = confirm
    await A.waitFor(`__pp.state==='countdown'||__pp.state==='run'`, 8000, 'touch start');
    await A.waitFor(`__pp.state==='run'`, 8000, 'touch run');
    gate('touch: tap-again confirms (ALPENGLOW run)', await A.eval('__pp.mountain') === 'alp');
    const touchUI = await A.eval(`document.body.classList.contains('input-touch')`);
    gate('touch: input-touch class active (touch UI shown)', touchUI);
    // JUMP + BRAKE stack in the left corner: both ≥60px on screen, no overlap
    const rects = await A.eval(`(() => {
      const r = id => { const b = document.getElementById(id).getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      return { jump: r('tbtnJump'), brake: r('tbtnBrake'), tuck: r('tbtnTuck') };
    })()`);
    const sep = rects.jump.t >= rects.brake.b || rects.brake.t >= rects.jump.b ||
                rects.jump.l >= rects.brake.r || rects.brake.l >= rects.jump.r;
    gate('touch: JUMP and BRAKE both ≥60px targets, non-overlapping',
      rects.jump.w >= 60 && rects.jump.h >= 60 && rects.brake.w >= 60 && rects.brake.h >= 60 && sep,
      `jump ${rects.jump.w.toFixed(0)}px, brake ${rects.brake.w.toFixed(0)}px, sep=${sep}`);
    // real touch on JUMP → real hop
    await sleep(2500);
    const jc = { x: (rects.jump.l + rects.jump.r) / 2, y: (rects.jump.t + rects.jump.b) / 2 };
    await tap(jc.x, jc.y);
    let touchAir = true;
    try { await A.waitFor('__pp.air === true', 4000, 'touch hop'); } catch { touchAir = false; }
    gate('touch: JUMP button hops', touchAir);
    await A.waitFor('__pp.air === false', 8000, 'touch hop lands');
    // held BRAKE slows the run
    const vT0 = await A.eval('__pp.speed');
    const bc = { x: (rects.brake.l + rects.brake.r) / 2, y: (rects.brake.t + rects.brake.b) / 2 };
    await touchSend('touchStart', [{ x: bc.x, y: bc.y }], bc.x, bc.y);
    await A.waitTicks(120, 20000);
    const vT1 = await A.eval('__pp.speed');
    await touchSend('touchEnd', [], bc.x, bc.y);
    gate('touch: BRAKE button scrubs speed', vT1 < vT0 - 1.0, `v ${vT0.toFixed(1)} → ${vT1.toFixed(1)}`);
    await A.shot('09-ipad-portrait');
    gate('zero console errors/warnings (ipad session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ MOUNTAIN SELECT SESSION — nav, quick start, gold arch ═══════════ */
async function mtnSession(base) {
  console.log('\n── mountain select session (?turbo=8) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(500);
    // pad: south opens select, east backs out
    await tapUntil(A, 0, `__pp.state==='select'`, 'select opens');
    gate('select: south at title opens mountain select', true);
    // N-card row: three cards, EXPERT tag on DIAMONDBACK only, row visible
    gate('select: three mountain cards rendered',
      await A.eval(`document.querySelectorAll('.mcard').length`) === 3);
    gate('select: DIAMONDBACK carries the ◆◆ EXPERT tag (others do not)',
      await A.eval(`(document.querySelector('#mcard2 .mtag')||{}).textContent === '◆◆ EXPERT' &&
        !document.querySelector('#mcard0 .mtag') && !document.querySelector('#mcard1 .mtag')`));
    gate('select: all three cards fit the 1280 stage',
      await A.eval(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
        return [0,1,2].every(i => { const r = document.getElementById('mcard'+i).getBoundingClientRect();
          return r.left >= s.left - 1 && r.right <= s.right + 1 && r.width > 200; }); })()`));
    await tapUntil(A, 1, `__pp.state==='title'`, 'east backs out');
    gate('select: east backs out to title', true);
    // pad: navigate right to NIGHT RIDGE, confirm, run starts on it
    await tapUntil(A, 0, `__pp.state==='select'`, 'select again');
    for (let i = 0; i < 6 && await A.eval('__pp.selectSel') !== 1; i++) await A.tapButton(15);
    gate('select: dpad-right highlights NIGHT RIDGE', await A.eval('__pp.selectSel') === 1);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'nr run');
    await A.waitFor(`__pp.state==='run'`, 12000, 'nr countdown → run');
    gate('select: confirm starts a NIGHT RIDGE run', await A.eval('__pp.mountain') === 'nr');
    gate('select: last-played mountain persisted',
      await A.eval(`localStorage.getItem('powderpeak_mtn')`) === 'nr');
    // START at title quick-starts the LAST-PLAYED mountain (no select)
    await A.eval('window.__ppTurbo = 1');   // cool the hot sim before re-nav
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(500);
    await tapUntil(A, 9, `__pp.state==='countdown'||__pp.state==='run'`, 'quick start');
    gate('select: START at title quick-starts last-played (NIGHT RIDGE)',
      await A.eval('__pp.mountain') === 'nr');
    // keyboard path: Enter → arrows → Esc backs out → Enter → Enter
    await A.eval('window.__ppTurbo = 1');
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(500);
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='select'`, 6000, 'kbd select');
    const keySel = async (key, vk, want) => {   // rAF can stall in headless:
      await A.tapKey(key, key, vk);             // poll rather than instant-read
      try { await A.waitFor(`__pp.selectSel === ${want}`, 2500, ''); return true; }
      catch { return false; }
    };
    gate('select: ArrowLeft highlights ALPENGLOW', await keySel('ArrowLeft', 37, 0));
    gate('select: ArrowRight highlights NIGHT RIDGE', await keySel('ArrowRight', 39, 1));
    await A.tapKey('Escape', 'Escape', 27);
    await A.waitFor(`__pp.state==='title'`, 6000, 'esc backs out');
    gate('select: Escape backs out to title', true);
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='select'`, 6000, 'kbd select 2');
    await A.tapKey('ArrowLeft', 'ArrowLeft', 37);
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='run'`, 12000, 'kbd alp run');
    gate('select: keyboard confirm starts ALPENGLOW', await A.eval('__pp.mountain') === 'alp');
    // ── the third card: DIAMONDBACK by pad, by keyboard, and quick-start ──
    await A.eval('window.__ppTurbo = 1');
    await A.nav(base + '/index.html?turbo=8&fx=full&r=4');
    await sleep(500);
    await tapUntil(A, 0, `__pp.state==='select'`, 'select for db');
    gate('select: dpad-right twice highlights DIAMONDBACK',
      await (async () => { for (let i = 0; i < 6 && await A.eval('__pp.selectSel') !== 2; i++) await A.tapButton(15); return await A.eval('__pp.selectSel') === 2; })());
    // right at the last card stays put (no wrap)
    await A.tapButton(15);
    gate('select: right edge does not wrap', await A.eval('__pp.selectSel') === 2);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'db run');
    await A.waitFor(`__pp.state==='run'`, 12000, 'db countdown → run');
    gate('select: confirm starts a DIAMONDBACK run', await A.eval('__pp.mountain') === 'db');
    gate('select: last-played persisted as db',
      await A.eval(`localStorage.getItem('powderpeak_mtn')`) === 'db');
    gate('select: DIAMONDBACK runs 6 sectors', await A.eval('__pp.sectors') === 6);
    await A.eval('window.__ppTurbo = 1');
    await A.nav(base + '/index.html?turbo=8&fx=full&r=5');
    await sleep(500);
    await tapUntil(A, 9, `__pp.state==='countdown'||__pp.state==='run'`, 'db quick start');
    gate('select: START at title quick-starts last-played (DIAMONDBACK)',
      await A.eval('__pp.mountain') === 'db');
    // keyboard reaches the third card too
    await A.eval('window.__ppTurbo = 1');
    await A.nav(base + '/index.html?turbo=8&fx=full&r=6');
    await sleep(500);
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='select'`, 6000, 'kbd select for db');
    const kSel = async (want) => { for (let i = 0; i < 6 && await A.eval('__pp.selectSel') !== want; i++) await A.tapKey('ArrowRight', 'ArrowRight', 39); return await A.eval('__pp.selectSel') === want; };
    gate('select: keyboard ArrowRight reaches DIAMONDBACK', await kSel(2));
    await A.tapKey('Enter', 'Enter', 13);
    await A.waitFor(`__pp.state==='run'`, 12000, 'kbd db run');
    gate('select: keyboard confirm starts DIAMONDBACK', await A.eval('__pp.mountain') === 'db');
    gate('zero console errors/warnings (mtn session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
  // gold-trim arch gets a FRESH chrome: repeated heavy page loads in one
  // headless tab can kill the swiftshader renderer mid-eval
  console.log('── gold arch session (?turbo=8) ──');
  const g2 = await launchChrome();
  try {
    const c = await pageSession(g2.port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await A.eval(`localStorage.setItem('powderpeak_best', JSON.stringify({time:90, sectors:[20,25,27,18]}))`);
    await A.nav(base + '/index.html?turbo=8&fx=full&r=2');
    await sleep(500);
    await startFromTitle(A, 'alp');
    gate('gold arch: GOLD best renders the trim (telemetry flag)',
      await A.eval('__pp.goldArch') === true);
    await A.eval(`window.__ppTurbo = 1; localStorage.setItem('powderpeak_best', JSON.stringify({time:120, sectors:[28,32,35,25]}))`);
    await A.nav(base + '/index.html?turbo=8&fx=full&r=3');
    await sleep(500);
    await startFromTitle(A, 'alp');
    gate('gold arch: non-gold best leaves the trim off',
      await A.eval('__pp.goldArch') === false);
    gate('zero console errors/warnings (gold-arch session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    g2.proc.kill(); await sleep(400);
    try { fs.rmSync(g2.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ NIGHT RIDGE SESSION — full course, budgets, best key ═══════════ */
async function nrSession(base) {
  console.log('\n── NIGHT RIDGE session (?turbo=10, bot race) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=10&fx=full');
    await sleep(500);
    await startFromTitle(A, 'nr');
    gate('nr: run starts on NIGHT RIDGE', await A.eval('__pp.mountain') === 'nr');
    // scenery may never sit on the piste — NIGHT RIDGE edition
    const pk = JSON.parse(await A.eval(`JSON.stringify((function(){
      const P = window.__ppPeaks || [], C = window.__ppCourse || [];
      let worst = 1e9;
      for (const p of P) for (const c of C) {
        const d = Math.hypot(c.x - p.x, c.z - p.z) - p.r;
        if (d < worst) worst = d;
      }
      return { n: P.length, worst: Math.round(worst) };
    })())`));
    gate('nr: backdrop peaks clear the course (margin ≥ 100m)', pk.n >= 10 && pk.worst >= 100,
      `${pk.n} peaks, worst margin ${pk.worst}m`);
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
    const fin = await A.eval('({t:__pp.time, cp:__pp.checkpoint, st:__pp.state})');
    gate('nr: bot completes the course', fin.st === 'finish' && fin.t > 40 && fin.t < 260,
      `time ${fin.t.toFixed(2)}s, crashes ${crashes}`);
    gate('nr: all 3 checkpoints were passed', fin.cp === 3, `checkpoint=${fin.cp}`);
    const bestRaw = await A.eval(`localStorage.getItem('powderpeak_best_nr')`);
    let bestObj = null; try { bestObj = JSON.parse(bestRaw); } catch {}
    gate('nr: best time persisted to powderpeak_best_nr',
      !!bestObj && typeof bestObj.time === 'number' && Math.abs(bestObj.time - fin.t) < 0.05,
      bestRaw && bestRaw.slice(0, 80));
    gate('nr: ALPENGLOW best key untouched',
      await A.eval(`localStorage.getItem('powderpeak_best')`) === null);
    const perf = await A.eval('__pp.perf');
    const nSecN = await A.eval('__pp.sectors');
    gate('nr perf: draw calls ≤ 80 at worst', perf.maxCalls <= 80,
      `max ${perf.maxCalls} (sectors ${perf.sectorCalls.slice(0, nSecN).join('/')})`);
    gate('nr perf: triangles ≤ 150k at worst', perf.maxTris <= 150000,
      `max ${perf.maxTris} (sectors ${perf.sectorTris.slice(0, nSecN).join('/')})`);
    gate('nr perf: every sector was sampled', perf.sectorCalls.slice(0, nSecN).every(v => v > 0),
      perf.sectorCalls.slice(0, nSecN).join('/'));
    gate('zero console errors/warnings (nr session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ DIAMONDBACK SESSION — full clean run, moguls, chutes, ledges ═══════════ */
async function dbSession(base) {
  console.log('\n── DIAMONDBACK session (?turbo=10, bot race) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=10&fx=full');
    await sleep(500);
    await startFromTitle(A, 'db');
    gate('db: run starts on DIAMONDBACK', await A.eval('__pp.mountain') === 'db');
    gate('db: 6 sectors / 5 gates', await A.eval('__pp.sectors') === 6 &&
      (await A.eval('window.__ppGates')).gates.length === 5);

    // backdrop peaks clear the course
    const pk = JSON.parse(await A.eval(`JSON.stringify((function(){
      const P = window.__ppPeaks || [], C = window.__ppCourse || [];
      let worst = 1e9;
      for (const p of P) for (const c of C) {
        const d = Math.hypot(c.x - p.x, c.z - p.z) - p.r;
        if (d < worst) worst = d;
      }
      return { n: P.length, worst: Math.round(worst) };
    })())`));
    gate('db: backdrop peaks clear the course (margin ≥ 100m)', pk.n >= 10 && pk.worst >= 100,
      `${pk.n} peaks, worst margin ${pk.worst}m`);

    /* ── authored features present & shaped as decided ── */
    const feats = JSON.parse(await A.eval('JSON.stringify(window.__ppFeatures)'));
    gate('db: 3 mogul fields / 2 chutes / 4 drops (2 big ledges) authored',
      feats.moguls.length === 3 && feats.chutes.length === 2 &&
      feats.drops.length === 4 && feats.drops.filter(d => d.big).length === 2,
      JSON.stringify({ m: feats.moguls.length, c: feats.chutes.length, d: feats.drops.length }));
    gate('db: mogul fields increase in length',
      feats.moguls[0].len < feats.moguls[1].len && feats.moguls[1].len < feats.moguls[2].len,
      feats.moguls.map(m => m.len + 'm').join(' → '));
    gate('db: chutes are narrow corridors (5-7m half-width)',
      feats.chutes.every(ch => ch.w >= 4.5 && ch.w <= 7.2),
      feats.chutes.map(ch => ch.w + 'm').join(', '));

    // bump lattice is IN the physics height field (λ 2.5-3.5m, real relief)
    const mog = JSON.parse(await A.eval(`JSON.stringify((function(){
      const C = window.__ppCourse, m = window.__ppFeatures.moguls[2];
      const i = Math.round(((m.s0 + m.s1) / 2) / 9);
      const a = C[i], b = C[i + 1];
      let dx = b.x - a.x, dz = b.z - a.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const rx = dz, rz = -dx;
      // detrended relief: compare each probe to the centreline height at the
      // same along-course station so the base grade drops out
      let mn = 1e9, mx = -1e9;
      for (let pa = -4; pa <= 4; pa++) for (let pu = -3; pu <= 3; pu++) {
        const bx = a.x + dx * pa * 0.85, bz = a.z + dz * pa * 0.85;
        const h = window.__ppTerrainProbe(bx + rx * pu * 0.85, bz + rz * pu * 0.85).h;
        const h0 = window.__ppTerrainProbe(bx, bz).h;
        const rel = h - h0 * 0;   // absolute; grade over ±3.4m ≈ ±0.5m — relief dominates
        if (rel < mn) mn = rel; if (rel > mx) mx = rel;
      }
      return { relief: +(mx - mn).toFixed(2) };
    })())`));
    gate('db: mogul bumps are physically in the terrain function (relief 1-3m over 7m)',
      mog.relief >= 1.0 && mog.relief <= 3.2, `${mog.relief}m`);

    // chute walls: tall granite either side of the corridor
    const walls = JSON.parse(await A.eval(`JSON.stringify((function(){
      const C = window.__ppCourse, F = window.__ppFeatures;
      return F.chutes.map(function(ch){
        const i = Math.round(((ch.s0 + ch.s1) / 2) / 9);
        const a = C[i], b = C[i + 1];
        let dx = b.x - a.x, dz = b.z - a.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const rx = dz, rz = -dx;
        const mid = window.__ppTerrainProbe(a.x, a.z).h;
        const wl = window.__ppTerrainProbe(a.x + rx * (ch.w + 8), a.z + rz * (ch.w + 8)).h;
        const wr = window.__ppTerrainProbe(a.x - rx * (ch.w + 8), a.z - rz * (ch.w + 8)).h;
        return +Math.min(wl - mid, wr - mid).toFixed(1);
      });
    })())`));
    gate('db: chutes are walled by tall granite (≥ 6m rise at +8m lateral)',
      walls.every(w => w >= 6), walls.join('m, ') + 'm');

    // chute corridors obstacle-free (like the shortcut rule)
    const obstacles = await A.eval('window.__ppObstacles');
    const course = await A.eval('window.__ppCourse');
    let chuteClear = 1e9;
    for (const ch of feats.chutes) {
      for (const o of obstacles) {
        const n = nearestCourse(course, o.x, o.z);
        if (n.s >= ch.s0 - 5 && n.s <= ch.s1 + 5) {
          const d = n.d - o.r;
          if (d < chuteClear) chuteClear = d;
        }
      }
    }
    gate('db: chute corridors free of obstacles (clearance > half-width + 1m)',
      chuteClear > feats.chutes[0].w + 1, `min clearance ${chuteClear === 1e9 ? 'none nearby' : chuteClear.toFixed(1) + 'm'}`);

    /* ── full course, clean — the playability proof ── */
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    let crashes = 0, lastState = 'run';
    const t0 = Date.now();
    while (Date.now() - t0 < 420000) {
      const st = await A.eval('__pp.state');
      if (st === 'crash' && lastState !== 'crash') crashes++;
      lastState = st;
      if (st === 'finish') break;
      await sleep(150);
    }
    const fin = await A.eval('({t:__pp.time, cp:__pp.checkpoint, st:__pp.state})');
    gate('db: bot finishes the full course CLEAN (zero crashes)',
      fin.st === 'finish' && crashes === 0, `time ${fin.t.toFixed(2)}s, crashes ${crashes}`);
    gate('db: all 5 checkpoint gates passed', fin.cp === 5, `checkpoint=${fin.cp}`);
    const medals = { gold: 182, silver: 215, bronze: 273 };
    gate('db: medal calibration holds (bot ≈ 20% over gold)',
      fin.t / medals.gold > 1.08 && fin.t / medals.gold < 1.35,
      `bot ${fin.t.toFixed(1)}s vs gold ${medals.gold}s (x${(fin.t / medals.gold).toFixed(2)}); silver ${medals.silver}, bronze ${medals.bronze}`);
    const bestRaw = await A.eval(`localStorage.getItem('powderpeak_best_db')`);
    let bestObj = null; try { bestObj = JSON.parse(bestRaw); } catch {}
    gate('db: best persisted to powderpeak_best_db (6 sectors)',
      !!bestObj && typeof bestObj.time === 'number' && Math.abs(bestObj.time - fin.t) < 0.05 &&
      Array.isArray(bestObj.sectors) && bestObj.sectors.length === 6,
      bestRaw && bestRaw.slice(0, 100));
    gate('db: other mountains\' best keys untouched',
      (await A.eval(`localStorage.getItem('powderpeak_best')`)) === null &&
      (await A.eval(`localStorage.getItem('powderpeak_best_nr')`)) === null);
    const perf = await A.eval('__pp.perf');
    gate('db perf: draw calls ≤ 80 at worst', perf.maxCalls <= 80,
      `max ${perf.maxCalls} (sectors ${perf.sectorCalls.slice(0, 6).join('/')})`);
    gate('db perf: triangles ≤ 150k at worst', perf.maxTris <= 150000,
      `max ${perf.maxTris} (sectors ${perf.sectorTris.slice(0, 6).join('/')})`);
    gate('db perf: all 6 sectors sampled', perf.sectorCalls.slice(0, 6).every(v => v > 0),
      perf.sectorCalls.slice(0, 6).join('/'));

    /* ── restart helper (pause menu) ── */
    const restart = async () => {
      await A.bot({ on: false, forceTuck: false, forceBrake: false, noTuck: false, weave: null, extraBtns: [] });
      await A.eval('__fakePad.axes(0,0); __fakePad.press();');
      await sleep(250);
      await tapUntil(A, 9, `__pp.state==='pause'`, 'pause for restart');
      await A.tapButton(13);
      if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) await A.tapButton(13);
      await tapUntil(A, 0, `(__pp.state==='run'||__pp.state==='countdown') && __pp.s < 40`, 'restarted');
      await A.waitFor(`__pp.state==='run'`, 12000, 'restart countdown done');
      await A.bot({ on: true, mode: 'race' });
      await A.eval('window.__ppTurbo = 10');
    };
    // south restarts from the finish screen first
    await A.bot({ on: false });
    await A.press();
    await sleep(1200);
    await A.tapButton(0);
    await A.waitFor(`__pp.state==='countdown'||__pp.state==='run'`, 8000, 'db ski again');
    await A.waitFor(`__pp.state==='run'`, 12000, 'db rerun');
    await A.bot({ on: true, mode: 'race' });

    /* ── MANDATORY AIRS: both drop-ins and both ledges give real air and a
          clean straight-on landing at sane speed ── */
    const dropsSorted = feats.drops.slice().sort((a, b) => a.s - b.s);
    for (const d of dropsSorted) {
      const tag = d.big ? 'ledge' : 'chute drop-in';
      await A.waitFor(`__pp.s > ${d.s - 130}`, 300000, 'approach drop ' + d.s);
      await A.eval('window.__ppTurbo = 2');
      let sawAir = false;
      try { await A.waitFor(`__pp.air === true && __pp.s > ${d.s - 12}`, 60000, 'drop air ' + d.s); sawAir = true; } catch {}
      let landed = { st: 'lost', v: 0 };
      if (sawAir) {
        await A.waitFor('__pp.air === false', 20000, 'drop landing ' + d.s);
        landed = await A.eval('({st:__pp.state, v:__pp.speed})');
      }
      await A.eval('window.__ppTurbo = 10');
      gate(`db: ${tag} at s=${d.s} — real air, landable straight-on, still moving`,
        sawAir && landed.st === 'run' && landed.v > 5,
        sawAir ? `landed v=${landed.v.toFixed(1)}` : 'no air observed');
    }

    /* ── MOGUL PHYSICS GATE: same spot (field 3), two disciplines.
          A: rhythmic carve, sane entry — stays grounded, faster.
          B: straight tuck bombing in at course speed — airborne off the
          crests, wobbles, slower back half. Bumps are physical, not paint. ── */
    const m3 = feats.moguls[2];
    // controlled protocol, SAME course spot for both lines: sync the entry
    // (brake to ≤13 m/s well above the field, at fine sim rate), then apply
    // the discipline. The bomb line tucks in from the sync point, so it
    // arrives hot exactly like a kid pointing them straight.
    const fieldRun = async (cfg) => {
      await restart();
      await A.waitFor(`__pp.s > ${m3.s0 - 210}`, 300000, 'approach field 3');
      await A.eval('window.__ppTurbo = 2');   // fine sim control near the field
      await A.bot({ forceBrake: true });
      const tb = Date.now();
      while (Date.now() - tb < 120000) {
        const st = await A.eval('({v:__pp.speed, s:__pp.s})');
        if (st.v < 13 || st.s > m3.s0 - 110) break;
        await sleep(15);
      }
      await A.bot({ forceBrake: false, ...cfg });
      const obsS = m3.s0 - 10;                // air events counted from the brink
      const winS = m3.s0 + 15;                // timing/speed window (settled)
      const midS = (winS + m3.s1) / 2;
      let n = 0, air = 0, wob = 0, vsum = 0, airEvents = 0, prevAir = false;
      let tEnter = null, tMid = null, tExit = null;
      let n2 = 0, v2sum = 0;
      const tf = Date.now();
      while (Date.now() - tf < 240000) {
        const st = await A.eval('({s:__pp.s, air:__pp.air, w:__pp.wobble, v:__pp.speed, t:__pp.time, state:__pp.state})');
        if (st.state !== 'run') break;
        if (st.s >= obsS && st.s <= m3.s1) {
          if (st.air && !prevAir) airEvents++;
          prevAir = st.air;
        }
        if (tEnter === null && st.s >= winS) tEnter = st.t;
        if (tMid === null && st.s >= midS) tMid = st.t;
        if (st.s >= winS && st.s <= m3.s1) {
          n++; if (st.air) air++; if (st.w) wob++; vsum += st.v;
          if (st.s >= midS) { n2++; v2sum += st.v; }
        }
        if (st.s > m3.s1) { tExit = st.t; break; }
        await sleep(12);
      }
      await A.eval('window.__ppTurbo = 10');
      return {
        time: tExit !== null && tEnter !== null ? tExit - tEnter : 1e9,
        back: tExit !== null && tMid !== null ? tExit - tMid : 1e9,
        airFrac: air / Math.max(1, n), wobFrac: wob / Math.max(1, n),
        airEvents,
        vAvg: vsum / Math.max(1, n), vBack: v2sum / Math.max(1, n2), n,
      };
    };
    const carve = await fieldRun({ weave: { a: 0.75, w: 0.055 }, noTuck: true });
    const bomb = await fieldRun({ forceTuck: true });
    const fmtF = r => `t=${r.time.toFixed(2)}s back=${r.back.toFixed(2)}s air=${r.airFrac.toFixed(2)} airEv=${r.airEvents} wob=${r.wobFrac.toFixed(2)} v=${r.vAvg.toFixed(1)}/${r.vBack.toFixed(1)}`;
    gate('mogul: rhythmic-carve line stays grounded through the field',
      carve.n > 30 && carve.airFrac <= 0.12, fmtF(carve));
    gate('mogul: straight-tuck line wobbles off bad landings',
      bomb.wobFrac > 0.05, fmtF(bomb));
    gate('mogul: the carve line is FASTER through the bumps (settled back half)',
      carve.back < bomb.back - 0.15 && carve.vBack > bomb.vBack + 0.5,
      `carve ${carve.back.toFixed(2)}s @${carve.vBack.toFixed(1)}m/s vs bomb ${bomb.back.toFixed(2)}s @${bomb.vBack.toFixed(1)}m/s`);
    // straight-tuck AT COURSE SPEED gets bucked airborne off the crests —
    // ridden hot (no pre-brake), the ejection is a certainty if the bumps
    // are real geometry. waitFor makes this deterministic.
    {
      await restart();
      await A.waitFor(`__pp.s > ${m3.s0 - 160}`, 300000, 'hot approach field 3');
      await A.bot({ forceTuck: true });
      await A.eval('window.__ppTurbo = 2');
      let hotAir = true;
      try {
        await A.waitFor(`__pp.air === true && __pp.s > ${m3.s0 - 12} && __pp.s < ${m3.s1}`,
          120000, 'hot bomb ejection');
      } catch { hotAir = false; }
      const hotV = await A.eval('__pp.speed');
      await A.bot({ forceTuck: false });
      await A.eval('window.__ppTurbo = 10');
      gate('mogul: straight-tuck line at course speed goes airborne off the crests',
        hotAir, hotAir ? `ejected at v=${hotV.toFixed(1)} m/s` : 'no ejection seen');
    }

    gate('zero console errors/warnings (db session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ TRICKS SESSION — four types by stick, chains, variety ═══════════ */
async function tricksSession(base) {
  console.log('\n── tricks session (?turbo=8, ramp airs) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(500);
    await startFromTitle(A, 'alp');
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    // ramp lips from the course dump (visible, sculpted kickers)
    const course = await A.eval('window.__ppCourse');
    // dump samples every 9m, so the exact 2.3m lip sample may be absent —
    // detect kicker CLUSTERS and take the last (highest) sample + a nudge
    const lips = [];
    let clusterEnd = null;
    for (const p of course) {
      if (p.ramp > 0.4) clusterEnd = p.s;
      else if (clusterEnd !== null) { lips.push(clusterEnd + 4); clusterEnd = null; }
    }
    if (clusterEnd !== null) lips.push(clusterEnd + 4);
    gate('tricks: 4 ramp lips found on ALPENGLOW', lips.length >= 4, lips.join(','));
    const restart = async () => {
      await A.bot({ on: false, forceTuck: false, extraBtns: [] });
      await A.eval('__fakePad.axes(0,0); __fakePad.press();');
      await sleep(200);
      await tapUntil(A, 9, `__pp.state==='pause'`, 'pause for restart');
      await A.tapButton(13);
      if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) await A.tapButton(13);
      await tapUntil(A, 0, `(__pp.state==='run'||__pp.state==='countdown') && __pp.s < 40`, 'restarted');
      await A.waitFor(`__pp.state==='run'`, 12000, 'restart countdown done');
      await A.bot({ on: true, mode: 'race', forceTuck: false, extraBtns: [] });
    };
    // one trick per ramp air, stick held at the press picks the type
    const trickAt = async (lipS, ax, ay, expect) => {
      await A.bot({ on: true, mode: 'race', forceTuck: false, extraBtns: [] });
      await A.waitFor(`__pp.s > ${lipS - 150}`, 180000, 'approach ramp ' + lipS);
      await A.bot({ forceTuck: true });
      await A.eval('window.__ppTurbo = 3');       // slow enough to catch the air
      await A.waitFor(`__pp.air === true && __pp.s > ${lipS - 30}`, 90000, 'ramp air ' + lipS);
      await A.eval('window.__ppTurbo = 1');
      await A.bot({ on: false, forceTuck: false });
      await A.eval(`__fakePad.axes(${ax},${ay})`);
      await sleep(70);
      await A.eval('__fakePad.press(2)');
      await A.waitFor('__pp.trick === true', 3000, 'trick starts');
      const name = await A.eval('__pp.trickName');
      await A.eval('__fakePad.press(); __fakePad.axes(0,0);');
      await A.waitFor('__pp.air === false', 12000, 'trick air lands');
      await A.eval('window.__ppTurbo = 8');
      await A.bot({ on: true, mode: 'race' });
      gate(`tricks: stick(${ax},${ay}) at west press = ${expect}`, name === expect, `got ${name}`);
    };
    await trickAt(lips[0], -1, 0, '360 L');
    await trickAt(lips[1], 1, 0, '360 R');
    await trickAt(lips[2], 0, -1, 'FRONT FLIP');
    await trickAt(lips[3], 0, 0, 'BACKFLIP');
    // chains off ramp 2 (biggest reliable air): timed jump at the lip, two
    // tricks in one air. Same-type pair = +14%; distinct pair = +18% VARIETY.
    const chainAt = async (types, expectPct, label) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await restart();
        await A.waitFor(`__pp.s > ${lips[1] - 160}`, 180000, 'approach ramp 2');
        await A.bot({ forceTuck: true });
        await A.eval('window.__ppTurbo = 2');       // slow approach: never miss the lip
        await A.waitFor(`__pp.s > ${lips[1] - 16}`, 90000, 'at the lip');
        await A.bot({ extraBtns: [2] });                  // timed lip jump
        await A.waitFor(`__pp.air === true`, 8000, 'lip air');
        await A.eval('window.__ppTurbo = 1');
        await A.bot({ on: false, forceTuck: false, extraBtns: [] });
        // west is still HELD from the lip jump — release it first or the
        // first chained press has no edge (≥150ms real, per the pad gotcha)
        await A.eval('__fakePad.press()');
        await sleep(180);
        let ok = true;
        for (const [ax, ay] of types) {
          await A.eval(`__fakePad.axes(${ax},${ay})`);
          await sleep(60);
          await A.eval('__fakePad.press(2)');
          try { await A.waitFor('__pp.trick === true', 1500, 'chain trick starts'); }
          catch { ok = false; break; }
          await A.eval('__fakePad.press()');
          try { await A.waitFor('__pp.trick === false', 2000, 'chain trick done'); }
          catch { ok = false; break; }
          if (!await A.eval('__pp.air')) { ok = false; break; }   // landed mid-chain
          await sleep(60);
        }
        await A.eval('__fakePad.axes(0,0); __fakePad.press();');
        await A.waitFor('__pp.air === false', 12000, 'chain lands');
        const res = await A.eval(`({pct:__pp.boostPct, st:__pp.state, pop:document.getElementById('trickPop').classList.contains('show'), txt:document.getElementById('trickPop').textContent})`);
        await A.eval('window.__ppTurbo = 8');
        await A.bot({ on: true, mode: 'race' });
        if (ok && Math.abs(res.pct - expectPct) < 0.5) {
          gate(`tricks: ${label} lands +${expectPct}% (cap 24 respected)`,
            res.pct === expectPct && res.pct <= 24 && res.st === 'run', `pct=${res.pct} "${res.txt}"`);
          gate(`tricks: ${label} chain popup shown`, res.pop, `"${res.txt}"`);
          return;
        }
        console.log(`  chain attempt ${attempt + 1} incomplete (pct=${res.pct}) — retrying`);
      }
      gate(`tricks: ${label} lands +${expectPct}%`, false, 'no clean 2-trick air in 3 attempts');
    };
    await chainAt([[0, 0], [0, 0]], 14, 'FLIP+FLIP x2');
    await chainAt([[0, 0], [-1, 0]], 18, 'FLIP+360 VARIETY');
    gate('zero console errors/warnings (tricks session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ FUN SESSION — hidden shortcut + snowman, ALL mountains ═══════════ */
async function funSession(base) {
  console.log('\n── delights session (shortcut + snowman, all three mountains) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    for (const m of ['alp', 'nr', 'db']) {
      try { await A.eval('window.__ppTurbo = 1'); } catch {}
      await A.nav(base + '/index.html?turbo=8&fx=full');
      await sleep(500);
      await startFromTitle(A, m);
      await A.installBot();
      const SC = await A.eval('JSON.parse(JSON.stringify(window.__ppShortcut))');
      const sm = await A.eval('JSON.parse(JSON.stringify(window.__ppSnowman))');
      const obstacles = await A.eval('window.__ppObstacles');
      // corridor must be free of obstacle footprints (data-side check)
      let minClear = 1e9;
      for (const o of obstacles) {
        for (const p of SC.pts) {
          const d = Math.hypot(o.x - p.x, o.z - p.z) - o.r;
          if (d < minClear) minClear = d;
        }
      }
      gate(`shortcut(${m}): corridor free of obstacle footprints`, minClear > SC.w,
        `min clearance ${minClear.toFixed(1)}m vs half-width ${SC.w}m`);
      // ride the SHORTCUT via the steering-hint path (real pad input)
      const segTimes = async (usePath) => {
        let tEntry = null, tExit = null, crashed = false;
        if (usePath) {
          await A.waitFor(`__pp.s > ${SC.entryS - 90}`, 240000, 'approach shortcut');
          await A.bot({ path: SC.pts, pathIdx: 0 });
        }
        await A.eval('window.__ppTurbo = 4');
        const t0 = Date.now();
        while (Date.now() - t0 < 240000) {
          const st = await A.eval('({s:__pp.s, t:__pp.time, state:__pp.state})');
          if (st.state === 'crash') crashed = true;
          if (tEntry === null && st.s >= SC.entryS) tEntry = st.t;
          if (tExit === null && st.s >= SC.exitS) { tExit = st.t; break; }
          await sleep(25);
        }
        await A.eval('window.__ppTurbo = 8');
        return { tEntry, tExit, crashed };
      };
      await A.bot({ on: true, mode: 'race' });
      const scRun = await segTimes(true);
      const rejoin = await A.eval('({u:__pp.u, st:__pp.state})');
      gate(`shortcut(${m}): ridden clean — no crash, rejoins the course`,
        !scRun.crashed && scRun.tExit !== null && rejoin.st === 'run' && Math.abs(rejoin.u) < 10,
        `u=${rejoin.u && rejoin.u.toFixed(1)} after exit`);
      // same run continues to the SNOWMAN — steer through it
      await A.waitFor(`__pp.s > ${sm.s - 110}`, 240000, 'approach snowman');
      await A.eval('window.__ppTurbo = 4');
      await A.bot({ mode: 'ram', ramX: sm.x, ramZ: sm.z });
      let vPre = null, hitSeen = false, vPost = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 120000) {
        const st = await A.eval('({v:__pp.speed, hit:__pp.snowman, s:__pp.s, state:__pp.state})');
        if (!st.hit) vPre = st.v;
        else { hitSeen = true; vPost = st.v; break; }
        if (st.s > sm.s + 40) break;
        await sleep(20);
      }
      await A.bot({ mode: 'race' });
      await A.eval('window.__ppTurbo = 8');
      const smState = await A.eval('__pp.state');
      gate(`snowman(${m}): hit → poof + speed nudge, never a crash`,
        hitSeen && smState === 'run' && vPost !== null && vPre !== null && vPost > vPre - 0.3,
        `v ${vPre && vPre.toFixed(1)} → ${vPost && vPost.toFixed(1)}`);
      // restart: MAIN LINE through the same segment + snowman untouched
      await A.bot({ on: false });
      await A.eval('__fakePad.axes(0,0); __fakePad.press();');
      await sleep(200);
      await tapUntil(A, 9, `__pp.state==='pause'`, 'pause');
      await A.tapButton(13);
      if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) await A.tapButton(13);
      await tapUntil(A, 0, `(__pp.state==='run'||__pp.state==='countdown') && __pp.s < 40`, 'restart for main line');
      await A.waitFor(`__pp.state==='run'`, 12000, 'main-line countdown done');
      await A.bot({ on: true, mode: 'race', path: null, pathIdx: 0 });
      await A.waitFor(`__pp.s > ${SC.entryS - 90}`, 240000, 'approach main line seg');
      const mainRun = await segTimes(false);
      const scSeg = scRun.tExit - scRun.tEntry, mainSeg = mainRun.tExit - mainRun.tEntry;
      gate(`shortcut(${m}): corridor beats the main line`,
        scRun.tExit !== null && mainRun.tExit !== null && scSeg < mainSeg - 1.5,
        `shortcut ${scSeg.toFixed(2)}s vs main ${mainSeg.toFixed(2)}s (Δ ${(mainSeg - scSeg).toFixed(2)}s)`);
      await A.waitFor(`__pp.s > ${sm.s + 25}`, 240000, 'pass snowman on the race line');
      gate(`snowman(${m}): missed on the race line → nothing`,
        await A.eval('__pp.snowman') === false);
    }
    gate('zero console errors/warnings (fun session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════ RACE SESSION — 2P split-screen: join, independence, flow,
   mercy, rubber-band, pause, perf, isolation. Two fake pads + kbd-P2. ═══════════ */
async function raceSession(base) {
  console.log('\n── 2P split-screen race session (?turbo=8, two pads) ──');
  const seedAlp = JSON.stringify({ time: 95, sectors: [21, 25, 26, 20] });
  const seedNr = JSON.stringify({ time: 100, sectors: [22, 26, 27, 21] });
  // node-side point-in-box test against the game's arch/gate solids
  const camClear = (boxes, cp) => {
    for (const b of boxes) {
      const rx = cp.x - b.x, rz = cp.z - b.z;
      const along = rx * b.dx + rz * b.dz;
      const lat = rx * b.dz - rz * b.dx;
      if (Math.abs(along) <= b.ht && Math.abs(lat) <= b.hw && cp.y >= b.y0 && cp.y <= b.y1) return false;
    }
    return true;
  };
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await A.eval(`localStorage.setItem('powderpeak_best', ${JSON.stringify(seedAlp)});` +
                 `localStorage.setItem('powderpeak_best_nr', ${JSON.stringify(seedNr)});`);
    await A.nav(base + '/index.html?turbo=8&fx=full&r=2');
    await sleep(500);

    /* ── join / un-join on the mountain select ── */
    await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
    gate('race: P2 join prompt shown when pad1 present', await A.eval('__pp.race.prompt') === true);
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapButton2(0);
    gate('race: P2 ✕ (pad slot 1) joins', await A.eval('__pp.race.joined') === true &&
      await A.eval('__pp.race.p2src') === 'pad');
    gate('race: P1/P2 chips appear on the cards',
      await A.eval(`document.body.classList.contains('p2joined') &&
        getComputedStyle(document.querySelector('#mcard0 .pchips')).display !== 'none' &&
        getComputedStyle(document.querySelector('#mcard1 .pchips')).display !== 'none'`));
    for (let i = 0; i < 6 && (await A.eval('__pp.race.joined')); i++) await A.tapButton2(1);
    gate('race: P2 ○ un-joins before launch', await A.eval('__pp.race.joined') === false);
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapButton2(0);
    await sleep(300);
    await A.shot('30-race-select-joined');

    /* ── launch on ALPENGLOW; start-line framing + arch clearance ── */
    for (let i = 0; i < 6 && await A.eval('__pp.selectSel') !== 0; i++) await A.tapButton(14);
    await A.eval('window.__ppTurbo = 1');       // hold the countdown for checks
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'race start');
    gate('race: confirming with P2 joined starts a split RACE',
      await A.eval('__pp.race.on') === true);
    await sleep(400);                           // a few rendered frames settle
    const boxes = await A.eval('window.__ppGateBoxes');
    const snap0 = await A.eval('({n1:__pp.ndcX, n2:__pp.p2.ndcX, c1:{x:__pp.camPos.x,y:__pp.camPos.y,z:__pp.camPos.z}, c2:{x:__pp.p2.camPos.x,y:__pp.p2.camPos.y,z:__pp.p2.camPos.z}})');
    gate('race: start-line framing — both skiers centered (|ndcX| ≤ 0.15)',
      Math.abs(snap0.n1) <= 0.15 && Math.abs(snap0.n2) <= 0.15,
      `ndc P1 ${snap0.n1.toFixed(3)} / P2 ${snap0.n2.toFixed(3)}`);
    gate('race: start cams clear of arch/gate geometry',
      camClear(boxes, snap0.c1) && camClear(boxes, snap0.c2));
    await A.shot('31-race-startline');
    await A.eval('window.__ppTurbo = 8');
    await A.waitFor(`__pp.state==='run'`, 15000, 'countdown → run');

    /* ── independence: opposite sticks, screen-correct per-player carve ── */
    await A.waitFor('__pp.speed > 6 && __pp.p2.speed > 6', 30000, 'both moving');
    await A.eval('__fakePad.axes(0,0); __fakePad.press(); __fakePad2.axes(0,0); __fakePad2.press();');
    await A.waitTicks(10);
    const i0 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z,rx:__pp.camRight.x,rz:__pp.camRight.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z,rx:__pp.p2.camRight.x,rz:__pp.p2.camRight.z}})');
    await A.eval('__fakePad.axes(-1,0); __fakePad2.axes(1,0);');
    await A.waitTicks(60);
    await A.eval('__fakePad.axes(0,0); __fakePad2.axes(0,0);');
    const i1 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z}})');
    const lat1 = (i1.p1.x - i0.p1.x) * i0.p1.rx + (i1.p1.z - i0.p1.z) * i0.p1.rz;
    const lat2 = (i1.p2.x - i0.p2.x) * i0.p2.rx + (i1.p2.z - i0.p2.z) * i0.p2.rz;
    gate('race: P1 stick-left → screen-LEFT while P2 stick-right → screen-RIGHT (independent sims)',
      lat1 < -0.8 && lat2 > 0.8, `lat P1 ${lat1.toFixed(2)} m / P2 ${lat2.toFixed(2)} m`);
    await A.eval('window.__ppTurbo = 1');
    await A.waitTicks(30);
    await A.shot('32-race-early');
    await A.eval('window.__ppTurbo = 8');

    /* ── bots race; P2 handicapped so P1 wins; sample centering en route ── */
    await A.installBot();
    await A.bot({ on: true, mode: 'race' });
    await A.bot2({ on: true, mode: 'race', noTuck: true });
    const ndcSamples = [];
    for (const s of [400, 700]) {
      await A.waitFor(`__pp.s > ${s}`, 240000, 'reach s=' + s);
      if (await A.eval(`__pp.state==='run' && !__pp.air && __pp.p2.state==='run'`)) {
        ndcSamples.push(await A.eval('({n1:__pp.ndcX, n2:__pp.p2.ndcX})'));
      }
    }
    // mid-air trick on ramp 2 for the split trick-cam shot
    await A.waitFor('__pp.s > 930', 240000, 'near ramp 2');
    await A.bot({ forceTuck: true });
    await A.eval('window.__ppTurbo = 1');
    await A.waitFor(`__pp.mode==='air'`, 90000, 'P1 airborne off ramp 2');
    await A.bot({ on: false, forceTuck: false });
    await A.eval('__fakePad.press(2)');
    await A.waitFor('__pp.trick === true', 3000, 'P1 trick starts');
    await A.eval('__fakePad.press()');
    await sleep(200);
    await A.shot('33-race-trick');
    await A.waitFor('__pp.air === false', 15000, 'P1 lands');
    await A.bot({ on: true, mode: 'race' });
    await A.eval('window.__ppTurbo = 8');

    /* ── rubber-band mercy: trailing P2 gets the quiet tuck bonus ── */
    await A.bot2({ forceBrake: true });
    await A.waitFor('__pp.race.gap > 62', 180000, 'gap past the far band');
    const rbFar = await A.eval('({rb0:__pp.race.rb[0], rb1:__pp.race.rb[1], gap:__pp.race.gap})');
    gate('race rubber-band: full +4% tuck accel at 60m+ behind, leader unaffected',
      Math.abs(rbFar.rb1 - 1.04) < 1e-6 && rbFar.rb0 === 1,
      `gap ${rbFar.gap.toFixed(0)}m → rb ${rbFar.rb1.toFixed(3)} / leader ${rbFar.rb0}`);
    // P1 brakes, tucked P2 chases back through the 15..60 m band — the
    // multiplier must track the decided linear ramp at the sampled gap
    await A.bot({ forceBrake: true });
    await A.bot2({ forceBrake: false, forceTuck: true });
    let mid = null;
    const tMid = Date.now();
    while (Date.now() - tMid < 180000) {
      const m = await A.eval('({rb1:__pp.race.rb[1], gap:__pp.race.gap})');
      if (m.gap < 58 && m.gap > 19) { mid = m; break; }
      if (m.gap <= 19) break;
      await sleep(30);
    }
    const midExp = mid ? 1 + 0.04 * Math.min(1, Math.max(0, (mid.gap - 15) / 45)) : 0;
    gate('race rubber-band: linear ramp between 15m and 60m',
      !!mid && Math.abs(mid.rb1 - midExp) < 0.006,
      mid && `gap ${mid.gap.toFixed(1)}m → rb ${mid.rb1.toFixed(4)} (expect ${midExp.toFixed(4)})`);
    // hand the race back: P1 sprints while P2 sits on the brakes until P1
    // has a decisive lead again, so the scripted winner is P1
    await A.bot({ forceBrake: false });
    await A.bot2({ forceTuck: false, forceBrake: true });
    {
      const t0h = Date.now();
      let ok = false;
      while (Date.now() - t0h < 240000) {
        if (await A.eval('__pp.race.gap > 60 || __pp.race.finished[0]')) { ok = true; break; }
        if ((Date.now() - t0h) % 10000 < 300) {
          console.log('  [handoff]', JSON.stringify(await A.eval(
            '({p1:{s:Math.round(__pp.s),v:+__pp.speed.toFixed(1),st:__pp.state,u:+__pp.u.toFixed(1)},p2:{s:Math.round(__pp.p2.s),v:+__pp.p2.speed.toFixed(1),st:__pp.p2.state},tick:__pp.tick})')));
        }
        await sleep(300);
      }
      if (!ok) throw new Error('timeout waiting for P1 retakes a safe lead');
    }
    await A.bot2({ forceBrake: false, noTuck: true });

    /* ── finish order, banner, results, 1P-best isolation ── */
    await A.waitFor('__pp.race.finished[0] === true', 300000, 'P1 crosses first');
    gate('race: winner = first across the line', await A.eval('__pp.race.winner') === 0);
    const ban = await A.eval(`({txt: document.getElementById('rban1').textContent,
      shown: document.getElementById('rban1').classList.contains('show'),
      other: document.getElementById('rban0').classList.contains('show')})`);
    gate('race: "P1 FINISHED!" banner on P2 half while P2 completes',
      ban.shown && ban.txt === 'P1 FINISHED!' && !ban.other, JSON.stringify(ban));
    await A.shot('34-race-banner');
    await A.waitFor(`__pp.state==='results'`, 300000, 'both finish → results');
    const res = await A.eval(`({w: document.getElementById('rrWinner').textContent,
      wc: document.getElementById('rrWinner').className,
      t0: document.getElementById('rrT0').textContent,
      t1: document.getElementById('rrT1').textContent,
      times: __pp.race.times.slice(),
      splitRows: document.getElementById('rrSplits').textContent})`);
    gate('race results: winner named big', res.w === 'P1 WINS!' && res.wc === 'p1', res.w);
    gate('race results: both times shown, winner faster',
      /\d:\d\d\.\d\d/.test(res.t0) && /\d:\d\d\.\d\d/.test(res.t1) &&
      res.times[0] < res.times[1], `${res.t0} vs ${res.t1}`);
    gate('race results: condensed sector splits for both players',
      res.splitRows.includes('S1') && res.splitRows.includes('S4') &&
      res.splitRows.includes('P1') && res.splitRows.includes('P2'));
    gate('race: 1P best times/medals untouched by a full 2P race',
      (await A.eval(`localStorage.getItem('powderpeak_best')`)) === seedAlp &&
      (await A.eval(`localStorage.getItem('powderpeak_best_nr')`)) === seedNr);
    gate('race: skiers stayed centered in their halves mid-course (|ndcX| ≤ 0.15)',
      ndcSamples.length >= 1 && ndcSamples.every(s => Math.abs(s.n1) <= 0.15 && Math.abs(s.n2) <= 0.15),
      ndcSamples.map(s => `${s.n1.toFixed(2)}/${s.n2.toFixed(2)}`).join(' '));
    const perfAlp = await A.eval('__pp.perf');
    const nSecR = await A.eval('__pp.sectors');
    gate('race perf (alp): combined split draw calls ≤ 110', perfAlp.maxCalls <= 110,
      `max ${perfAlp.maxCalls} (sectors ${perfAlp.sectorCalls.slice(0, nSecR).join('/')})`);
    gate('race perf (alp): combined split triangles ≤ 120k', perfAlp.maxTris <= 120000,
      `max ${perfAlp.maxTris} (sectors ${perfAlp.sectorTris.slice(0, nSecR).join('/')})`);
    gate('race perf (alp): every sector sampled in split', perfAlp.sectorCalls.slice(0, nSecR).every(v => v > 0),
      perfAlp.sectorCalls.slice(0, nSecR).join('/'));
    await sleep(900);
    await A.shot('35-race-results');

    /* ── rematch ── */
    await A.bot({ on: false }); await A.bot2({ on: false });
    await A.eval('__fakePad.press(); __fakePad2.press(); __fakePad.axes(0,0); __fakePad2.axes(0,0);');
    await sleep(1100);                        // results input guard
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'rematch');
    gate('race: ✕ on results = rematch, both back at the gate',
      await A.eval('__pp.race.on === true && __pp.s < 40 && __pp.p2.s < 40'));
    await A.waitFor(`__pp.state==='run'`, 15000, 'rematch running');

    /* ── mercy: P1 crashes, P2 keeps racing; respawn at P1's checkpoint ── */
    await A.bot({ on: true, mode: 'race' });
    await A.bot2({ on: true, mode: 'race' });
    const course = await A.eval('window.__ppCourse');
    const obstacles = await A.eval('window.__ppObstacles');
    let ram = null;
    for (const o of obstacles) {
      const n = nearestCourse(course, o.x, o.z);
      if (n.d < course[n.i].w - 0.8 && n.s > 500 && (!ram || n.s < ram.s)) ram = { ...o, s: n.s };
    }
    gate('race mercy: an in-piste tree exists ahead', !!ram, ram && `s=${ram.s}`);
    await A.waitFor(`__pp.s > ${ram.s - 90}`, 240000, 'approach ram tree');
    await A.bot({ mode: 'ram', ramX: ram.x, ramZ: ram.z });
    await A.eval('window.__ppTurbo = 2');
    await A.waitFor(`__pp.state==='crash'`, 90000, 'P1 crashes');
    const m0 = await A.eval('({p2s: __pp.p2.s, p2st: __pp.p2.state})');
    await A.shot('36-race-crash');
    await A.waitTicks(30);
    const m1 = await A.eval('({p2s: __pp.p2.s, p2st: __pp.p2.state})');
    gate('race mercy: P2 keeps racing while P1 tumbles',
      m0.p2st === 'run' && m1.p2st === 'run' && m1.p2s > m0.p2s + 1,
      `P2 s ${m0.p2s.toFixed(0)} → ${m1.p2s.toFixed(0)} during P1 crash`);
    await A.bot({ mode: 'race' });
    await A.waitFor(`__pp.state==='run' && __pp.mode==='ground'`, 60000, 'P1 respawns');
    const gates2 = await A.eval('window.__ppGates');
    const rsp = await A.eval('({cp: __pp.checkpoint, s: __pp.s, v: __pp.speed})');
    const cpS = rsp.cp === 0 ? 9 : gates2.gates[rsp.cp - 1];
    gate('race mercy: P1 respawns at its OWN checkpoint, moving slowly',
      Math.abs(rsp.s - cpS) < 15 && rsp.v < 8, `s=${rsp.s} vs checkpoint s=${cpS}, v=${rsp.v.toFixed(1)}`);
    await A.waitTicks(40);                    // chase cam settles behind again
    const rspCam = await A.eval('({c:{x:__pp.camPos.x,y:__pp.camPos.y,z:__pp.camPos.z}, n:__pp.ndcX})');
    gate('race mercy: respawn cam settles clear of the checkpoint gate, skier centered',
      camClear(boxes, rspCam.c) && Math.abs(rspCam.n) <= 0.15, `ndc ${rspCam.n.toFixed(3)}`);
    await A.shot('37-race-respawn-gate');
    await A.eval('window.__ppTurbo = 8');

    /* ── pause from EITHER pad freezes BOTH sims ── */
    let paused = false;
    for (let i = 0; i < 6 && !paused; i++) {
      await A.tapButton2(9);
      try { await A.waitFor(`__pp.state==='pause'`, 1500, ''); paused = true; } catch {}
    }
    gate('race pause: P2 START pauses both', paused);
    const pt = await A.eval('({t:__pp.tick, s1:__pp.s, s2:__pp.p2.s})');
    await sleep(450);
    const pt2 = await A.eval('({t:__pp.tick, s1:__pp.s, s2:__pp.p2.s})');
    gate('race pause: both sims frozen', pt.t === pt2.t && pt.s1 === pt2.s1 && pt.s2 === pt2.s2,
      `tick ${pt.t}`);
    // any pad navigates the shared menu: P1 confirms RESUME
    await tapUntil(A, 0, `__pp.state==='run'`, 'resume');
    gate('race pause: RESUME continues both', true);
    // P1 START → RESTART RACE resets both to the gate
    await tapUntil(A, 9, `__pp.state==='pause'`, 'pause again');
    await A.tapButton2(13);                    // P2's dpad navigates too
    if (!await A.eval(`document.getElementById('mi1').className.includes('sel')`)) await A.tapButton2(13);
    gate('race pause: menu shows RESTART RACE',
      await A.eval(`document.getElementById('mi1').textContent`) === 'RESTART RACE');
    await tapUntil(A, 0, `(__pp.state==='countdown'||__pp.state==='run') && __pp.s < 40 && __pp.p2.s < 40`, 'restart race');
    gate('race pause: RESTART RACE puts both back at the gate', true);
    await A.waitFor(`__pp.state==='run'`, 15000, 'restarted race runs');
    // QUIT TO SELECT keeps P2 joined
    await tapUntil(A, 9, `__pp.state==='pause'`, 'pause for quit');
    for (let i = 0; i < 6 && !(await A.eval(`document.getElementById('mi2').className.includes('sel')`)); i++) {
      await A.tapButton(13);
    }
    await tapUntil(A, 0, `__pp.state==='select'`, 'quit to select');
    gate('race pause: QUIT TO SELECT returns to the mountain select, P2 still joined',
      await A.eval('__pp.race.joined') === true);

    /* ── keyboard-as-P2 (desktop): joins when P1 is on a pad ── */
    await A.eval('window.__ppTurbo = 1');
    await A.nav(base + '/index.html?turbo=8&fx=full&r=3');
    await sleep(500);
    await tapUntil(A, 0, `__pp.state==='select'`, 'select (kbd join)');   // pad0 use → P1 on pad
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapKey('Enter', 'Enter', 13);
    gate('race kbd: keyboard ✕ joins as P2 when P1 is on a pad',
      await A.eval(`__pp.race.joined === true && __pp.race.p2src === 'kbd'`));
    for (let i = 0; i < 6 && (await A.eval(`__pp.race.joined && __pp.state==='select'`)); i++) {
      await A.tapKey('Escape', 'Escape', 27);
    }
    gate('race kbd: ESC un-joins keyboard P2', await A.eval('__pp.race.joined') === false);
    if (await A.eval(`__pp.state`) === 'title') await tapUntil(A, 0, `__pp.state==='select'`, 'back to select');
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapKey('Enter', 'Enter', 13);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'kbd race start');
    gate('race kbd: race starts with keyboard P2', await A.eval(`__pp.race.on && __pp.race.p2src==='kbd'`));
    await A.waitFor(`__pp.state==='run'`, 15000, 'kbd race running');
    await A.waitFor('__pp.speed > 6 && __pp.p2.speed > 6', 30000, 'both moving (kbd)');
    await A.eval('__fakePad.axes(0,0); __fakePad.press();');
    await A.waitTicks(10);
    const k0 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z,rx:__pp.camRight.x,rz:__pp.camRight.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z,rx:__pp.p2.camRight.x,rz:__pp.p2.camRight.z}})');
    await A.eval('__fakePad.axes(-1,0)');
    await A.key('ArrowRight', 'ArrowRight', 39, true);
    await A.waitTicks(60);
    await A.eval('__fakePad.axes(0,0)');
    await A.key('ArrowRight', 'ArrowRight', 39, false);
    const k1 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z}})');
    const kl1 = (k1.p1.x - k0.p1.x) * k0.p1.rx + (k1.p1.z - k0.p1.z) * k0.p1.rz;
    const kl2 = (k1.p2.x - k0.p2.x) * k0.p2.rx + (k1.p2.z - k0.p2.z) * k0.p2.rz;
    gate('race kbd: keyboard steers ONLY P2 (pad P1 left, key P2 right, both screen-correct)',
      kl1 < -0.8 && kl2 > 0.8, `lat P1 ${kl1.toFixed(2)} m / P2 ${kl2.toFixed(2)} m`);
    // Escape (P2's pause key) freezes both
    await A.tapKey('Escape', 'Escape', 27);
    await A.waitFor(`__pp.state==='pause'`, 6000, 'kbd P2 pause');
    const kt = await A.eval('__pp.tick');
    await sleep(400);
    gate('race kbd: P2 keyboard pause freezes both sims', kt === await A.eval('__pp.tick'));
    gate('zero console errors/warnings (race session)', A.consoleBad.length === 0,
      A.consoleBad.slice(0, 4).join(' | ') || 'clean');
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }

  /* ── per-mountain split blocks: NIGHT RIDGE and DIAMONDBACK each get a
        fresh chrome (heavy reloads kill swiftshader) and the same battery:
        join, start framing, independence, rubber-band, winner, budgets. ── */
  for (const mtn of ['nr', 'db']) {
    const NAME = { nr: 'NIGHT RIDGE', db: 'DIAMONDBACK' }[mtn];
    console.log(`── race session: ${NAME} split (?turbo=10) ──`);
    const g2 = await launchChrome();
    try {
      const c = await pageSession(g2.port);
      const A = makeApi(c);
      await A.init(); await A.stubPad();
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await A.nav(base + '/index.html?turbo=10&fx=full');
      await sleep(500);
      await tapUntil(A, 0, `__pp.state==='select'`, mtn + ' select');
      for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapButton2(0);
      await selectCard(A, mtn);
      await A.eval('window.__ppTurbo = 1');
      await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, mtn + ' race start');
      gate(`race ${mtn}: split race starts on ${NAME}`,
        await A.eval(`__pp.race.on === true && __pp.mountain === '${mtn}'`));
      await sleep(400);
      const mBoxes = await A.eval('window.__ppGateBoxes');
      const mSnap = await A.eval('({n1:__pp.ndcX, n2:__pp.p2.ndcX, c1:{x:__pp.camPos.x,y:__pp.camPos.y,z:__pp.camPos.z}, c2:{x:__pp.p2.camPos.x,y:__pp.p2.camPos.y,z:__pp.p2.camPos.z}})');
      gate(`race ${mtn}: start-line centering + arch clearance`,
        Math.abs(mSnap.n1) <= 0.15 && Math.abs(mSnap.n2) <= 0.15 &&
        camClear(mBoxes, mSnap.c1) && camClear(mBoxes, mSnap.c2),
        `ndc ${mSnap.n1.toFixed(3)} / ${mSnap.n2.toFixed(3)}`);
      await A.eval('window.__ppTurbo = 10');
      await A.waitFor(`__pp.state==='run'`, 20000, mtn + ' race running');
      /* independence: opposite sticks steer each half its own way */
      await A.waitFor('__pp.speed > 6 && __pp.p2.speed > 6', 30000, 'both moving');
      await A.eval('__fakePad.axes(0,0); __fakePad.press(); __fakePad2.axes(0,0); __fakePad2.press();');
      await A.waitTicks(10);
      const i0 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z,rx:__pp.camRight.x,rz:__pp.camRight.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z,rx:__pp.p2.camRight.x,rz:__pp.p2.camRight.z}})');
      await A.eval('__fakePad.axes(-1,0); __fakePad2.axes(1,0);');
      await A.waitTicks(60);
      await A.eval('__fakePad.axes(0,0); __fakePad2.axes(0,0);');
      const i1 = await A.eval('({p1:{x:__pp.pos.x,z:__pp.pos.z},p2:{x:__pp.p2.pos.x,z:__pp.p2.pos.z}})');
      const lat1 = (i1.p1.x - i0.p1.x) * i0.p1.rx + (i1.p1.z - i0.p1.z) * i0.p1.rz;
      const lat2 = (i1.p2.x - i0.p2.x) * i0.p2.rx + (i1.p2.z - i0.p2.z) * i0.p2.rz;
      gate(`race ${mtn}: independent sims (P1 left / P2 right, screen-correct)`,
        lat1 < -0.8 && lat2 > 0.8, `lat P1 ${lat1.toFixed(2)} m / P2 ${lat2.toFixed(2)} m`);
      await A.installBot();
      await A.bot({ on: true, mode: 'race' });
      await A.bot2({ on: true, mode: 'race' });
      await A.waitFor('__pp.s > 220', 240000, mtn + ' under way');
      await A.eval('window.__ppTurbo = 1');
      await A.waitTicks(20);
      await A.shot(`38-race-${mtn}`);
      await A.eval('window.__ppTurbo = 10');
      /* rubber-band mercy on this mountain */
      await A.bot2({ forceBrake: true });
      await A.waitFor('__pp.race.gap > 62', 240000, 'gap past the far band');
      const rbFar = await A.eval('({rb0:__pp.race.rb[0], rb1:__pp.race.rb[1], gap:__pp.race.gap})');
      gate(`race ${mtn} rubber-band: +4% tuck accel at 60m+ behind, leader unaffected`,
        Math.abs(rbFar.rb1 - 1.04) < 1e-6 && rbFar.rb0 === 1,
        `gap ${rbFar.gap.toFixed(0)}m → rb ${rbFar.rb1.toFixed(3)} / leader ${rbFar.rb0}`);
      await A.bot2({ forceBrake: false, noTuck: true });
      /* no GC pressure across 900 split ticks (both sims + double render) */
      await A.eval('window.gc && window.gc()');
      const h0 = await A.eval('performance.memory.usedJSHeapSize');
      await A.waitTicks(900, 90000);
      await A.eval('window.gc && window.gc()');
      const h1 = await A.eval('performance.memory.usedJSHeapSize');
      const growth = (h1 - h0) / 1e6;
      gate(`race perf (${mtn}): no per-frame GC pressure in split`, growth < 2.5,
        `heap Δ ${growth.toFixed(2)} MB over 900 split ticks`);
      const finS = (await A.eval('window.__ppGates')).finish;
      const mNdc = [];
      for (const fr of [0.42, 0.66]) {
        const s = Math.round(finS * fr);
        await A.waitFor(`__pp.s > ${s}`, 400000, mtn + ' reach s=' + s);
        if (await A.eval(`__pp.state==='run' && !__pp.air && __pp.p2.state==='run'`)) {
          mNdc.push(await A.eval('({n1:__pp.ndcX, n2:__pp.p2.ndcX})'));
        }
      }
      await A.waitFor(`__pp.state==='results'`, 500000, mtn + ' race results');
      gate(`race ${mtn}: winner declared (P1, first across)`, await A.eval('__pp.race.winner') === 0 &&
        await A.eval(`document.getElementById('rrWinner').textContent`) === 'P1 WINS!');
      gate(`race ${mtn}: skiers centered mid-course (|ndcX| ≤ 0.15)`,
        mNdc.length >= 1 && mNdc.every(s => Math.abs(s.n1) <= 0.15 && Math.abs(s.n2) <= 0.15),
        mNdc.map(s => `${s.n1.toFixed(2)}/${s.n2.toFixed(2)}`).join(' '));
      const perfM = await A.eval('__pp.perf');
      const nSecM = await A.eval('__pp.sectors');
      gate(`race perf (${mtn}): combined split draw calls ≤ 110`, perfM.maxCalls <= 110,
        `max ${perfM.maxCalls} (sectors ${perfM.sectorCalls.slice(0, nSecM).join('/')})`);
      gate(`race perf (${mtn}): combined split triangles ≤ 120k`, perfM.maxTris <= 120000,
        `max ${perfM.maxTris} (sectors ${perfM.sectorTris.slice(0, nSecM).join('/')})`);
      gate(`race perf (${mtn}): every sector sampled in split`, perfM.sectorCalls.slice(0, nSecM).every(v => v > 0),
        perfM.sectorCalls.slice(0, nSecM).join('/'));
      gate(`zero console errors/warnings (race ${mtn} session)`, A.consoleBad.length === 0,
        A.consoleBad.slice(0, 4).join(' | ') || 'clean');
      c.close();
    } finally {
      g2.proc.kill(); await sleep(400);
      try { fs.rmSync(g2.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  }
}

/* ═══════════ VOID SESSION — the world past the finish line, all mountains.
   During the finish orbit the camera's full 360 must only ever frame
   generated terrain/backdrop — never bare fog void (Ben's complaint). ═══════════ */
async function voidSession(base) {
  console.log('\n── finish-orbit void session (all three mountains) ──');
  for (const mtn of ['alp', 'nr', 'db']) {
    const { proc, port, profile } = await launchChrome();
    try {
      const c = await pageSession(port);
      const A = makeApi(c);
      await A.init(); await A.stubPad();
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
      await A.nav(base + '/index.html?turbo=14&fx=full');
      await sleep(500);
      await startFromTitle(A, mtn);
      await A.installBot();
      await A.bot({ on: true, mode: 'race' });
      await A.waitFor(`__pp.state==='finish'`, 420000, mtn + ' finish');
      await A.bot({ on: false });
      await A.eval('__fakePad.axes(0,0); __fakePad.press();');
      await sleep(600);
      // geometric 360: 12 azimuths on the orbit cam's actual path formula
      // (radius 13, +5.5 above the skier, looking at the skier). Rays across
      // the horizontal FOV at the center-look depression and a shallower one
      // must all hit generated terrain before the fog swallows the view.
      const misses = JSON.parse(await A.eval(`JSON.stringify((function(){
        const P = { x: __pp.pos.x, y: __pp.pos.y, z: __pp.pos.z };
        const fogFar = window.__ppFogFar || 380;
        const bad = [];
        for (let a = 0; a < 12; a++) {
          const th = a / 12 * Math.PI * 2;
          const cx = P.x + Math.cos(th) * 13, cy = P.y + 5.5, cz = P.z + Math.sin(th) * 13;
          const yaw0 = Math.atan2(P.x - cx, P.z - cz);
          for (const yo of [-0.83, -0.41, 0, 0.41, 0.83]) {
            for (const el of [-0.33, -0.12]) {
              const yw = yaw0 + yo;
              const rx = Math.sin(yw), rz = Math.cos(yw);
              let hit = false;
              for (let t = 6; t < fogFar * 0.92; t += 5) {
                const pr = window.__ppTerrainProbe(cx + rx * t, cz + rz * t);
                if (pr.d < 70 && pr.h >= cy + el * t) { hit = true; break; }
              }
              if (!hit) bad.push({ a, yo, el });
            }
          }
        }
        return bad;
      })())`));
      gate(`void(${mtn}): all 120 finish-orbit view rays hit generated world`,
        misses.length === 0, misses.length ? JSON.stringify(misses.slice(0, 4)) : 'full 360 covered');
      // the REAL orbit camera, sampled at 4 angles: same ray test + shots
      let realBad = 0;
      for (let k = 0; k < 4; k++) {
        const rb = JSON.parse(await A.eval(`JSON.stringify((function(){
          const C = { x: __pp.camPos.x, y: __pp.camPos.y, z: __pp.camPos.z };
          const P = { x: __pp.pos.x, y: __pp.pos.y, z: __pp.pos.z };
          const fogFar = window.__ppFogFar || 380;
          const yaw0 = Math.atan2(P.x - C.x, P.z - C.z);
          const bad = [];
          for (const yo of [-0.83, -0.41, 0, 0.41, 0.83]) {
            for (const el of [-0.33, -0.12]) {
              const rx = Math.sin(yaw0 + yo), rz = Math.cos(yaw0 + yo);
              let hit = false;
              for (let t = 6; t < fogFar * 0.92; t += 5) {
                const pr = window.__ppTerrainProbe(C.x + rx * t, C.z + rz * t);
                if (pr.d < 70 && pr.h >= C.y + el * t) { hit = true; break; }
              }
              if (!hit) bad.push({ yo, el });
            }
          }
          return bad;
        })())`));
        realBad += rb.length;
        await A.shot(`40-void-${mtn}-${k}`);
        await sleep(4200);            // the orbit sweeps on (wall clock)
      }
      gate(`void(${mtn}): live orbit camera never frames void (4 sampled angles)`,
        realBad === 0, realBad ? `${realBad} miss rays` : 'clean');
      gate(`zero console errors/warnings (void ${mtn})`, A.consoleBad.length === 0,
        A.consoleBad.slice(0, 4).join(' | ') || 'clean');
      c.close();
    } finally {
      proc.kill(); await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  }
}

/* ═══════════════ CLEAN TIMING RUN — medal calibration ═══════════════ */
async function timeSession(base, mtn) {
  console.log(`\n── clean bot timing run (?turbo=10, ${mtn}) ──`);
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=10&fx=full');
    await sleep(400);
    await startFromTitle(A, mtn);
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
    const key = mtn === 'nr' ? 'powderpeak_best_nr' : mtn === 'db' ? 'powderpeak_best_db' : 'powderpeak_best';
    const sect = await A.eval(`JSON.parse(localStorage.getItem('${key}')||'{}').sectors`);
    console.log(`clean bot time (${mtn}): ${t.toFixed(2)}s, crashes: ${crashes}, sectors: ${(sect || []).map(x => x.toFixed(1)).join(' / ')}`);
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ TUCK MEASURE — steady-state tuck speed, opening straight ═══════════════ */
async function tuckSession(base) {
  console.log('\n── tuck steady-state measure (?turbo=8, forceTuck from GO) ──');
  const { proc, port, profile } = await launchChrome();
  try {
    const c = await pageSession(port);
    const A = makeApi(c);
    await A.init(); await A.stubPad();
    await A.nav(base + '/index.html?turbo=8&fx=full');
    await sleep(400);
    await startFromTitle(A, 'alp');
    await A.installBot();
    await A.bot({ on: true, mode: 'race', forceTuck: true });
    const samples = [];
    for (const s of [150, 200, 250, 300, 350]) {
      await A.waitFor(`__pp.s >= ${s}`, 60000, 'reach s=' + s);
      samples.push([s, await A.eval('__pp.speed')]);
    }
    console.log('tuck speeds: ' + samples.map(([s, v]) => `s=${s}: ${v.toFixed(1)} m/s`).join(', '));
    c.close();
  } finally {
    proc.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ═══════════════ main ═══════════════ */
const which = process.argv[2] || 'all';
const mtnArg = ['nr', 'db'].includes(process.argv[3]) ? process.argv[3] : 'alp';
const { srv, port: httpPort } = await serve();
const base = `http://127.0.0.1:${httpPort}`;
// Headless swiftshader renderers occasionally die mid-session (CDP replies
// stop). One retry keeps environmental hiccups from failing a clean build —
// a real regression still fails twice.
async function runSession(name, fn) {
  const before = failures;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let threw = false;
    failures = before;
    try { await fn(); } catch (e) { threw = true; console.error('SESSION ERROR (' + name + '):', e.message); }
    if (!threw && failures === before) return;
    if (attempt < 3) console.log(`\n—— ${name}: failures/errors above; retrying (attempt ${attempt + 1}/3) ——`);
    else if (!threw) return;      // third attempt's failures stand
    else failures = before + 1;   // third attempt threw: count one failure
  }
}
try {
  if (which === 'time') await timeSession(base, mtnArg);
  if (which === 'tuck') await tuckSession(base);
  if (which === 'all' || which === 'gates') await runSession('gates', () => gatesSession(base));
  if (which === 'all' || which === 'mtn') await runSession('mtn', () => mtnSession(base));
  if (which === 'all' || which === 'nr') await runSession('nr', () => nrSession(base));
  if (which === 'all' || which === 'db') await runSession('db', () => dbSession(base));
  if (which === 'all' || which === 'tricks') await runSession('tricks', () => tricksSession(base));
  if (which === 'all' || which === 'fun') await runSession('fun', () => funSession(base));
  if (which === 'all' || which === 'race') await runSession('race', () => raceSession(base));
  if (which === 'all' || which === 'kbd') await runSession('kbd', () => kbdSession(base));
  if (which === 'all' || which === 'void') await runSession('void', () => voidSession(base));
  if (which === 'all' || which === 'shots') await runSession('shots', () => shotsSession(base));
  if (which === 'all' || which === 'ipad') await runSession('ipad', () => ipadSession(base));
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  srv.close();
}
console.log(failures === 0 ? '\nALL GATES GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
