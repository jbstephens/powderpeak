#!/usr/bin/env node
// Air-mute probe (PP-LOOK-1): the motion (wind) loop must go quiet while the
// skier is airborne and return on landing. Real path: real fake-pad hop, an
// in-page per-frame recorder of {air, windGain}, assertions on the recording.
//   node --experimental-websocket test/air-audio-probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HARNESS = fs.readFileSync(path.join(DIR, 'test', 'harness.mjs'), 'utf8');
const PAD_STUB = HARNESS.match(/const PAD_STUB = `([\s\S]*?)`;\n/)[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const gate = (ok, label, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); if (!ok) fails++; };

const srv = http.createServer((req, res) => {
  const f = path.join(DIR, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-air-'));
const proc = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--force-device-scale-factor=1', '--no-first-run',
  '--disable-dev-shm-usage', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} });
const wsUrl = await new Promise((res, rej) => {
  let b = ''; proc.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  setTimeout(() => rej(new Error('no devtools')), 15000);
});
const list = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let mid = 0; const pending = new Map(); const errs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || 'ex');
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evl = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval'); return r.result.value; };
const waitFor = async (e, t = 25000, l = e) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await evl(e)) return; } catch (x) {} await sleep(120); } throw new Error('timeout: ' + l); };
const tap = async (...idx) => { await evl(`__fakePad.press(${idx.join(',')})`); await sleep(220); await evl('__fakePad.press()'); await sleep(200); };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: PAD_STUB });
await send('Page.navigate', { url: `http://127.0.0.1:${srv.address().port}/` });   /* look ON by default now */
await waitFor(`window.__pp && __pp.state === 'title'`, 30000, 'title');

/* real input: south through title + mountain select into a run */
for (let i = 0; i < 8 && (await evl('__pp.state')) !== 'run'; i++) await tap(0);
gate(await evl(`__pp.state`) === 'run', 'reached a run via pad');

/* let gravity build real speed until the wind loop is audible */
await waitFor(`__pp.speed > 8 && window.__ppAudio && __ppAudio().wind > 0.045`, 45000, 'cruising with wind audible');

/* in-page per-frame recorder, then a REAL hop (west = button 2) */
await evl(`window.__rec = []; window.__recOn = true;
  (function loop(){ if (!window.__recOn) return;
    __rec.push({ air: __pp.air, w: __ppAudio().wind, t: performance.now() });
    requestAnimationFrame(loop); })();`);
await sleep(400);
await evl('__fakePad.press(2)'); await sleep(160); await evl('__fakePad.press()');
await sleep(2200);
await evl('window.__recOn = false');
const rec = await evl('window.__rec');

const pre = rec.filter(s => !s.air && s.t < rec.find(x => x.air)?.t);
const airS = rec.filter(s => s.air);
const landT = airS.length ? airS[airS.length - 1].t : 0;
const post = rec.filter(s => !s.air && s.t > landT + 250 && s.t < landT + 1400);
gate(airS.length > 5, 'the hop actually left the snow', `${airS.length} airborne frames`);
if (airS.length > 5 && pre.length && post.length) {
  const preW = pre.reduce((a, s) => a + s.w, 0) / pre.length;
  const minAirW = Math.min(...airS.slice(Math.floor(airS.length / 2)).map(s => s.w));  /* second half of the air: ramp has settled */
  const postW = post.reduce((a, s) => a + s.w, 0) / post.length;
  gate(minAirW < preW * 0.25, 'motion loop goes quiet in the air', `cruise ${preW.toFixed(3)} → air-min ${minAirW.toFixed(3)}`);
  gate(postW > preW * 0.6, 'and returns after landing', `post ${postW.toFixed(3)} vs cruise ${preW.toFixed(3)}`);
  const ramps = rec.filter(s => s.air).every((s, i, a) => i === 0 || Math.abs(s.w - a[i - 1].w) < 0.08);
  gate(ramps, 'cut is a ramp, not a click (no >0.08 frame steps)');
}
gate(errs.length === 0, 'zero page exceptions', errs.slice(0, 2).join('|'));
console.log(fails === 0 ? 'ALL GREEN' : `${fails} FAILURES`);
proc.kill(); srv.close();
process.exit(fails ? 1 : 0);
