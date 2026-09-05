/**
 * Runtime verification (AppImage + Xvfb + CDP, no deps):
 *   1. Toolbar zoom +/- perform RELATIVE zoom (old bug: args swapped for
 *      diagram-js zoom(newScale, center) → NaN matrix → snapped back to 100%).
 *   2. "新建 DMN" toolbar button enters DMN mode (view tabs visible, .dmn title).
 *   3. Zoom +/- and the zoom label work in DMN mode too.
 *
 * Usage: node scripts/verify/verify-zoom-dmn.mjs [path/to/AppImage]
 * Picks the newest release/**\/*.AppImage when no path is given.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function newestAppImage() {
  const rel = path.join(root, 'release');
  const found = [];
  for (const dir of readdirSync(rel)) {
    const p = path.join(rel, dir, 'electron', 'BPMN Studio.AppImage');
    if (existsSync(p)) found.push(p);
  }
  if (!found.length) throw new Error('no AppImage found under release/ — run ./build-head.sh --electron --targets AppImage');
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}

const appimage = process.argv[2] || newestAppImage();
console.log('AppImage:', appimage);

const DISPLAY = process.env.VERIFY_DISPLAY || ':77';
const PORT = 9333;

// --- Xvfb -------------------------------------------------------------------
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const app = spawn(appimage, [
  '--appimage-extract-and-run',
  '--no-sandbox',
  '--disable-gpu',
  '--ozone-platform=x11',
  `--remote-debugging-port=${PORT}`
], { stdio: 'ignore', env: { ...process.env, DISPLAY, BPMN_STUDIO_DEBUG: '1' } });

let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function getWsUrl(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP page target never appeared');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await evaluate(expr)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(250);
  }
}
const click = (sel) => evaluate(`!!document.querySelector(${JSON.stringify(sel)})?.click()`);
const zoomText = () => evaluate(`document.querySelector('#zoom-level')?.textContent`);
const zoomNum = async () => parseFloat(await zoomText());

// wait for the app shell + initial BPMN diagram
const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && document.querySelector('#zoom-level'))`);
check('app booted (canvas + zoom label present)', booted);

// --- 1. BPMN zoom +/- --------------------------------------------------------
const z0 = await zoomNum();
await click('#btn-zoom-in');
await sleep(200);
const z1 = await zoomNum();
check('zoom-in multiplies current zoom (not snapped to 100%)',
  Math.abs(z1 - Math.round(z0 * 1.25)) <= 1, `${z0}% → ${z1}% (expect ~${Math.round(z0 * 1.25)}%)`);
await click('#btn-zoom-in');
await sleep(200);
const z2 = await zoomNum();
check('second zoom-in keeps multiplying', Math.abs(z2 - Math.round(z1 * 1.25)) <= 2, `${z1}% → ${z2}%`);
await click('#btn-zoom-out');
await sleep(200);
const z3 = await zoomNum();
check('zoom-out reverses one step', Math.abs(z3 - z1) <= 1, `${z2}% → ${z3}% (expect ~${z1}%)`);
await click('#btn-zoom-out'); await sleep(200);
const z4 = await zoomNum();
check('zoom-out round-trips to start', Math.abs(z4 - z0) <= 1, `${z3}% → ${z4}% (expect ~${z0}%)`);
await click('#btn-zoom-out'); await sleep(200);
const zSmall = await zoomNum();
check('zoom-out shrinks below start', zSmall < z0, `→ ${zSmall}%`);
await click('#btn-zoom-fit'); await sleep(400);
const zFit = await zoomNum();
check('fit-viewport updates label', Number.isFinite(zFit), `→ ${zFit}%`);

// --- 2. New DMN entry point ----------------------------------------------------
const hasBtn = await evaluate(`!!document.querySelector('#btn-new-dmn')`);
check('toolbar has 新建 DMN button', hasBtn);
const labels = await evaluate(`[...document.querySelectorAll('#topbar .group.file .tool')].map(b=>b.textContent.trim()).join('|')`);
check('new buttons clearly labeled', /新建 BPMN/.test(labels) && /新建 DMN/.test(labels), labels);

await click('#btn-new-dmn');
const dmnReady = await waitFor(
  `!document.querySelector('#dmn-view-tabs').classList.contains('hidden')` +
  ` && !document.querySelector('#js-dmn-canvas').classList.contains('hidden')` +
  ` && !!document.querySelector('#js-dmn-canvas .djs-container')`
);
check('新建 DMN enters DMN mode (view tabs + dmn canvas rendered)', dmnReady);
const name = await evaluate(`document.querySelector('#diagram-name')?.textContent`);
check('diagram name switched to untitled.dmn', name === 'untitled.dmn', name);

// --- 3. zoom works in DMN mode --------------------------------------------------
const d0 = await zoomNum();
await click('#btn-zoom-in');
await sleep(250);
const d1 = await zoomNum();
check('zoom-in works in DMN mode', Math.abs(d1 - Math.round(d0 * 1.25)) <= 1, `${d0}% → ${d1}%`);
await click('#btn-zoom-out');
await sleep(250);
const d2 = await zoomNum();
check('zoom-out works in DMN mode', Math.abs(d2 - d0) <= 1, `${d1}% → ${d2}% (expect ~${d0}%)`);

// view switch keeps label in sync
await click('#btn-dmn-decision-table');
await sleep(600);
const d3 = await zoomNum();
check('zoom label follows view switch', Number.isFinite(d3), `decision table → ${d3}%`);

// --- L5/L6: tab highlight follows the real active view (regression for the dead
// 'view.switch' listener — dmn-js actually fires 'views.changed') ------------------
const tabState = await evaluate(`(() => {
  const active = (window.__dmnModeler.getActiveView() || {}).type;
  const cls = k => document.querySelector('#btn-dmn-' + k).classList.contains('active');
  return JSON.stringify({ active, drd: cls('drd'), dt: cls('decision-table'), le: cls('literal-expression') });
})()`);
const ts = JSON.parse(tabState);
check('L5/L6 tab highlight follows real active view (switched to decisionTable)',
  ts.active === 'decisionTable' && ts.dt === true && ts.drd === false, tabState);

// literalExpression is not in the empty DMN model → its tab must be disabled (not a silent dead click)
const leDisabled = await evaluate(`document.querySelector('#btn-dmn-literal-expression').disabled`);
check('L5/L6 tab for an absent view type is disabled (literalExpression absent)', leDisabled === true);

// clicking the disabled tab must not move the active view
await evaluate(`document.querySelector('#btn-dmn-literal-expression').click()`);
await sleep(300);
const afterDead = await evaluate(`(window.__dmnModeler.getActiveView() || {}).type`);
check('L5/L6 clicking absent view tab does not change active view', afterDead === 'decisionTable', afterDead);

console.log('\n' + results.join('\n'));
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} (${results.length} total)`);

ws.close();
app.kill('SIGTERM');
xvfb.kill('SIGTERM');
process.exit(failed === 0 ? 0 : 1);
