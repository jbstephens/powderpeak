#!/usr/bin/env node
// Skier-model screenshot session (PP-SKIER rig rebuild). Reuses the
// look-verify plumbing; writes into test/shots-skier/. NOT a gate suite —
// this exists so the new rig can be LOOKED at and iterated:
//   idle at the start gate, mid-carve, full tuck, airborne trick,
//   2P split (both jacket colours), and one ?look=0 legacy-pipeline shot.
//   /opt/homebrew/bin/node --experimental-websocket test/shots-skier.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(DIR, 'test', 'shots-skier');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function gate(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
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
  // profile OUTSIDE the repo (a prior suite once committed one from test/)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shots-'));
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
    async shot(name, clip) {
      const params = { format: 'png' };
      if (clip) params.clip = clip;
      const r = await c.send('Page.captureScreenshot', params);
      const f = path.join(SHOTS, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  shot →', f);
      return f;
    },
    async installBot() { await api.eval(BOT_SRC); },
    async bot(props) { await api.eval(`Object.assign(window.__bot, ${JSON.stringify(props)})`); },
    async bot2(props) { await api.eval(`Object.assign(window.__bot2, ${JSON.stringify(props)})`); },
  };
  return api;
}

async function tapUntil(A, btn, expr, label) {
  for (let i = 0; i < 6; i++) {
    await A.tapButton(btn);
    try { await A.waitFor(expr, 1500, label); return; } catch {}
  }
  throw new Error('tapUntil gave up: ' + label);
}
async function toSelect(A, card) {
  await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
  for (let i = 0; i < 10; i++) {
    const cur = await A.eval('__pp.selectSel');
    if (cur === card) break;
    await A.tapButton(cur < card ? 15 : 14);
  }
}

const { srv, port: httpPort } = await serve();
const base = `http://127.0.0.1:${httpPort}`;

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

// centre-of-frame close crop (the skier rides bottom-centre of the frame)
const CLOSE = { x: 420, y: 250, width: 440, height: 330, scale: 2 };

try {
  /* ── session 1: look=1 alpenglow — idle, carve, tuck, airborne trick ── */
  await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=full&look=1`);
    await A.installBot();
    await toSelect(A, 0);
    await A.eval('window.__ppTurbo = 1');
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'countdown');
    await sleep(600);
    await A.shot('01-idle-startgate');
    await A.shot('01c-idle-close', CLOSE);
    await A.waitFor(`__pp.state==='run'`, 15000, 'run start');
    await A.eval('window.__ppTurbo = 8');
    await A.bot({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 300', 90000, 'mid-course');
    await A.eval('window.__ppTurbo = 1');
    // carve: the bot is steering — catch a sustained hard-steer moment
    await A.waitFor(`Math.abs(navigator.getGamepads()[0].axes[0]) > 0.7 && __pp.speed > 12 && !__pp.air`,
      60000, 'bot hard carve');
    await sleep(300);
    await A.shot('02-carve');
    await A.shot('02c-carve-close', CLOSE);
    // tuck: the bot holds south on straights — catch it, let the crouch ease in
    await A.waitFor(`navigator.getGamepads()[0].buttons[0].pressed && !__pp.air`, 60000, 'bot tuck');
    await sleep(700);
    await A.shot('03-tuck');
    await A.shot('03c-tuck-close', CLOSE);
    // airborne trick: bot briefly off on a straight — hop, then west = backflip
    await A.waitFor(`navigator.getGamepads()[0].buttons[0].pressed && !__pp.air`, 60000, 'straight for hop');
    await A.bot({ on: false });
    // in-page sequencing (CDP round-trips are too slow for the air window):
    // hop, release, first airborne frame → west again = backflip
    await A.eval(`(function(){
      __fakePad.axes(0, 0); __fakePad.press(2);
      setTimeout(function(){ __fakePad.press(); }, 90);
      (function w(){
        // wait until airborne AND the west button has been seen released for
        // two frames, so the second press is a clean edge for justPressed()
        if (__pp.air && !navigator.getGamepads()[0].buttons[2].pressed) {
          requestAnimationFrame(function(){ requestAnimationFrame(function(){
            __fakePad.press(2); setTimeout(function(){ __fakePad.press(); }, 90);
          }); });
        } else requestAnimationFrame(w);
      })();
    })()`);
    await A.waitFor('__pp.trick', 4000, 'trick started');
    await sleep(200);                                    // mid-flip
    await A.shot('04-air-trick');
    await A.shot('04c-air-close', CLOSE);
    await A.bot({ on: true });
    gate('session 1: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });

  /* ── session 2: 2P split — both jacket colours ── */
  await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=full&look=1`);
    await A.installBot();
    await tapUntil(A, 0, `__pp.state==='select'`, 'select screen');
    for (let i = 0; i < 6 && !(await A.eval('__pp.race.joined')); i++) await A.tapButton2(0);
    gate('2p: P2 joined', await A.eval('__pp.race.joined') === true);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, '2P run start');
    await A.waitFor(`__pp.state==='run'`, 12000, '2P countdown → run');
    await A.bot({ on: true, mode: 'race' });
    // desync: both bots ride the SAME deterministic line, which parks the
    // two rigs exactly on top of each other — so P2 brakes for a beat
    // first, then chases, and each half shows its own jacket colour.
    await A.eval('__fakePad2.press(1)');
    await sleep(1500);
    await A.eval('__fakePad2.press()');
    await A.bot2({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 260', 90000, '2P mid-run');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.shot('05-2p-split');
    const counts = await A.eval(`(function(){
      var out = [];
      window.__ppLook.rigs.forEach(function(r, i){
        var meshes = 0, tris = 0;
        r.group.traverse(function(o){ if (o.isMesh) { meshes++;
          tris += o.geometry.attributes.position.count / 3; } });
        out.push('rig' + i + ': ' + meshes + ' meshes, ' + tris + ' tris');
      });
      return out.join(' | ');
    })()`);
    console.log('  rig counts:', counts);
    gate('session 2: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });

  /* ── session 3: legacy pipeline ?look=0 ── */
  await withPage(async A => {
    await A.nav(`${base}/index.html?turbo=8&fx=full&look=0`);
    await A.installBot();
    await toSelect(A, 0);
    await tapUntil(A, 0, `__pp.state==='countdown'||__pp.state==='run'`, 'run start');
    await A.waitFor(`__pp.state==='run'`, 15000, 'countdown → run');
    await A.bot({ on: true, mode: 'race' });
    await A.waitFor('__pp.s >= 300', 90000, 'look0 mid-run');
    await A.eval('window.__ppTurbo = 1');
    await sleep(400);
    await A.shot('06-look0');
    await A.shot('06c-look0-close', CLOSE);
    gate('session 3: zero console errors', A.consoleBad.length === 0, A.consoleBad.slice(0, 3).join(' | '));
  });
} catch (e) {
  console.error('SHOTS ERROR:', e.message);
  failures++;
} finally {
  srv.close();
}
console.log(failures === 0 ? '\nSHOTS DONE' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
