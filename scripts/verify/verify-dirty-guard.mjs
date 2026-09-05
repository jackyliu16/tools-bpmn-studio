/**
 * Runtime verification for the v0.1.10 silent-data-loss fixes
 * (AppImage + Xvfb + CDP, no deps):
 *   H2  dirty ★ tracking is alive after boot/new (baseline seeded on import)
 *   H3  selection.changed survives elements without businessObject
 *   H5  new/open asks for confirmation while dirty (confirmDiscardUnsaved)
 *   H4  invalid DMN drop → error card AND the previous DMN model is restored
 *   H1  preload close-guard bridge exists (dialog clicks stay manual)
 *
 * Requires the AppImage built from v0.1.10 code (BPMN_STUDIO_DEBUG=1 is set
 * by this script so the renderer exposes window.__bpmnModeler via ?debug).
 *
 * Usage: node scripts/verify/verify-dirty-guard.mjs [path/to/AppImage]
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

const DISPLAY = process.env.VERIFY_DISPLAY || ':78';
const PORT = 9334;

// --- Xvfb -------------------------------------------------------------------
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const app = spawn(appimage, [
  '--appimage-extract-and-run',
  '--no-sandbox',
  '--disable-gpu',
  '--ozone-platform=x11',
  `--remote-debugging-port=${PORT}`
], {
  stdio: 'ignore',
  // BPMN_STUDIO_DEBUG=1 → main.cjs loads dist/index.html?debug → window.__bpmnModeler is exposed
  env: { ...process.env, DISPLAY, BPMN_STUDIO_DEBUG: '1' }
});

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

const dirtyVisible = () => evaluate(`!document.querySelector('#dirty').classList.contains('hidden')`);
const titleHasStar = () => evaluate(`document.title.includes('*')`);

// wait for the app shell + initial BPMN diagram
const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && window.__bpmnModeler)`);
check('app booted (canvas rendered, debug globals exposed)', booted);

// --- 0. close-guard preload bridge (H1 contract surface) ----------------------
const bridge = await evaluate(`['setDirtyState','onSaveBeforeClose','allowWindowClose']
  .map(k => typeof (window.bpmnStudio || {})[k]).join(',')`);
check('preload close-guard bridge exposed (setDirtyState/onSaveBeforeClose/allowWindowClose)',
  bridge === 'function,function,function', bridge);

// --- 1. H2: fresh boot is clean ----------------------------------------------
check('boot: ★ hidden (clean baseline)', !(await dirtyVisible()));
check('boot: title has no *', !(await titleHasStar()));

// --- 2. H2: edit after boot marks dirty (baseline seeded at import) -----------
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  const root = m.get('canvas').getRootElement();
  m.get('modeling').updateProperties(root, { name: 'dirty-probe' });
})()`);
const becameDirty = await waitFor(`!document.querySelector('#dirty').classList.contains('hidden')`);
check('H2 edit on a fresh (never-saved) diagram shows ★', becameDirty);
check('H2 document.title carries * while dirty', await titleHasStar());

// --- 3. H3: selection.changed tolerates elements without businessObject -------
const ghostOk = await evaluate(`(() => {
  try {
    window.__bpmnModeler.get('eventBus').fire('selection.changed', { newSelection: [{ id: 'ghost' }] });
    return 'ok';
  } catch (err) { return 'threw: ' + (err && err.message); }
})()`);
check('H3 selection.changed with businessObject-less element does not throw',
  ghostOk === 'ok', ghostOk);
const statusAfterGhost = await evaluate(`document.querySelector('#status-right').textContent`);
check('H3 status bar cleared for ghost selection', statusAfterGhost === '', JSON.stringify(statusAfterGhost));

const realSel = await evaluate(`(() => {
  const el = window.__bpmnModeler.get('elementRegistry').getAll().find(e => e.businessObject && e.id);
  if (!el) return 'none';
  window.__bpmnModeler.get('eventBus').fire('selection.changed', { newSelection: [el] });
  return el.id;
})()`);
const statusAfterReal = await evaluate(`document.querySelector('#status-right').textContent`);
check('H3 regular selection still renders id (type) in status bar',
  realSel !== 'none' && statusAfterReal.includes(realSel), `${realSel} → ${JSON.stringify(statusAfterReal)}`);

// --- 4. H5: new diagram is guarded while dirty ---------------------------------
await evaluate(`window.__confirmArgs = []; window.confirm = (msg) => { window.__confirmArgs.push(String(msg)); return false; };`);
await click('#btn-new');
await sleep(600);
check('H5 declined confirm keeps the diagram dirty (nothing was discarded)', await dirtyVisible());

await evaluate(`window.confirm = (msg) => { window.__confirmArgs.push(String(msg)); return true; };`);
await click('#btn-new');
const becameClean = await waitFor(`document.querySelector('#dirty').classList.contains('hidden')`);
check('H5 accepted confirm proceeds and new diagram starts clean', becameClean);
const confirmAsked = await evaluate(`window.__confirmArgs.some(s => s.includes('未保存'))`);
check('H5 confirm dialog mentioned unsaved changes', confirmAsked);
check('H5 title cleared after discard+new', !(await titleHasStar()));

// --- 5. H4: invalid DMN drop → error card + previous DMN model restored --------
await click('#btn-new-dmn');
const dmnReady = await waitFor(
  `!document.querySelector('#dmn-view-tabs').classList.contains('hidden')` +
  ` && !!document.querySelector('#js-dmn-canvas .djs-container')`
);
check('DMN mode entered (valid baseline model loaded)', dmnReady);

await evaluate(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['<notDMN xmlns="http://example.com/"><stuff/></notDMN>'], 'bad.dmn', { type: 'application/xml' }));
  document.querySelector('#js-canvas').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`);
const errorShown = await waitFor(`!document.querySelector('#error-overlay').classList.contains('hidden')`);
check('H4 invalid DMN import surfaces the error card', errorShown);
await sleep(700); // allow the restore re-import to settle
const modelRestored = await evaluate(
  `(document.querySelector('#js-dmn-canvas .djs-container')?.querySelectorAll('.djs-element').length) || 0`
);
check('H4 previous DMN model restored after failed import (canvas not blank)', modelRestored > 0, `elements: ${modelRestored}`);
check('H4 app still responsive after the failed import', (await evaluate(`1`)) === 1);

// --- 6. M1: SVG export works in DMN mode (self-implemented serializer) --------
const dmnSvg = await evaluate(`(async () => {
  try {
    const svg = await window.__saveActiveSvg();
    return typeof svg === 'string' && svg.startsWith('<svg') && svg.includes('viewBox') && svg.length > 1000
      ? 'ok:' + svg.length
      : 'bad:' + String(svg).slice(0, 80);
  } catch (err) { return 'threw: ' + err.message; }
})()`);
check('M1 DMN SVG export produces standalone serialized SVG (viewBox + inlined styles)',
  dmnSvg.startsWith('ok:'), dmnSvg);

// --- 7. M1 sanity: BPMN export path unchanged (native saveSVG) -----------------
await click('#btn-error-close'); // 关掉 H4 留下的错误卡，避免遮住后续操作
await evaluate(`window.confirm = () => true;`);
await click('#btn-new');
await waitFor(`!document.querySelector('#dmn-view-tabs').classList.contains('hidden') ? false : !!window.__bpmnModeler`, 10000);
const bpmnSvg = await evaluate(`(async () => {
  try {
    const svg = await window.__saveActiveSvg();
    return typeof svg === 'string' && svg.includes('<svg') ? 'ok' : 'bad';
  } catch (err) { return 'threw: ' + err.message; }
})()`);
check('M1 BPMN SVG export still works via native saveSVG', bpmnSvg === 'ok', bpmnSvg);

// --- 8. M2: toolbar undo drives the ACTIVE modeler's stack (name reverts) -------
// 注：新建图未保存时 savedStackIdx=null，回退后 ★ 按保守语义仍保留（设计如此）；
// 这里验证的是“按钮确实操作了当前模型栈”——重命名被撤销即可证。
const rootNameBefore = await evaluate(`window.__bpmnModeler.get('canvas').getRootElement().businessObject.name || ''`);
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  m.get('modeling').updateProperties(m.get('canvas').getRootElement(), { name: 'undo-probe' });
})()`);
const probeApplied = await waitFor(`window.__bpmnModeler.get('canvas').getRootElement().businessObject.name === 'undo-probe'`);
check('M2 setup: rename command applied to active BPMN model', probeApplied);
await click('#btn-undo');
const nameReverted = await waitFor(`(() => {
  const n = window.__bpmnModeler.get('canvas').getRootElement().businessObject.name || '';
  return n !== 'undo-probe';
})()`);
check('M2 toolbar undo button drives the active command stack (rename reverted)', nameReverted,
  `before=${rootNameBefore}`);

console.log('\n' + results.join('\n'));
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} (${results.length} total)`);

ws.close();
app.kill('SIGTERM');
xvfb.kill('SIGTERM');
process.exit(failed === 0 ? 0 : 1);
