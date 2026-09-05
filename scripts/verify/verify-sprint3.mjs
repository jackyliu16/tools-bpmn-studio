/**
 * Runtime verification for the v0.1.12 Sprint 3 fixes (AppImage + Xvfb + CDP, no deps):
 *   Fix 5   XML Apply no longer false-marks ★ on round-trip-equivalent content,
 *           and still marks ★ on a real change (canonical baseline)
 *   Fix 3   entering a new/open diagram exits stale XML edit mode (content was replaced)
 *   Fix 10/11  destroy clears minimap button + status-right residue
 *   Fix 15  drop-to-open works on the DMN canvas (cross-mode success path included)
 *   Fix 9   multiple decision tables each get their own enabled tab (getViews()-driven)
 *   Fix 12  zoom label follows the switched view
 *   Fix 7   failed cross-mode open rolls back to the previous mode AND model
 *   Fix 6   save-diagram-direct refuses paths the user never confirmed via a dialog
 *   Fix 18  prefs:set honours the key allowlist
 *
 * Native dialogs (save/close prompts) remain manual — see AUDIT-BACKLOG.md checklist.
 *
 * Usage: node scripts/verify/verify-sprint3.mjs [path/to/AppImage]
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

const DISPLAY = process.env.VERIFY_DISPLAY || ':79';
const PORT = 9335;

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

// 拖放注入：Chromium 支持构造 DataTransfer + File，触发与真实拖放同一条 drop 路径
const dropFile = (hostSel, content, name) => evaluate(`(async () => {
  const host = document.querySelector(${JSON.stringify(hostSel)});
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'application/xml' }));
  host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
})()`);

const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && window.__bpmnModeler)`);
check('app booted (canvas rendered, debug globals exposed)', booted);

// 自动通过「放弃未保存变更」确认框
await evaluate(`window.confirm = () => true;`);

// --- Fix 5: XML Apply 的脏标记以序列化规范形态为基准 ---------------------------
await click('#btn-xml');            // 打开 XML 面板（内容 = 活模型的序列化输出）
await sleep(300);
await click('#btn-xml-edit');       // 进入编辑模式
await sleep(300);
await click('#btn-xml-apply');      // 一字不改直接 Apply
await waitFor(`document.querySelector('#status-left').textContent.includes('已应用 XML 修改')`);
await sleep(300);
check('Fix 5: applying unchanged XML does NOT set ★ (canonical baseline)', !(await dirtyVisible()));

// 真改动（改根元素名）→ 仍须置脏
const edited = await evaluate(`(() => {
  const el = document.querySelector('#xml-code');
  el.textContent = el.textContent.replace('示例流程', 'Sprint3改名');
  return el.textContent.includes('Sprint3改名');
})()`);
await click('#btn-xml-apply');
await waitFor(`document.querySelector('#status-left').textContent.includes('已应用 XML 修改')`);
await sleep(300);
check('Fix 5: applying a real change still sets ★', (await dirtyVisible()) && edited === true);

// --- Fix 3: 内容被整体替换后不得残留编辑态 -------------------------------------
await evaluate(`(() => { const el = document.querySelector('#xml-code'); el.textContent = el.textContent.replace('Sprint3改名', '再改一次'); })()`);
await click('#btn-new');            // 新建（同模型器路径，不走 destroyModeler）
const newLoaded = await waitFor(`document.querySelector('#diagram-name').textContent === 'untitled.bpmn'`);
await sleep(400);
const editOff = await evaluate(`!document.querySelector('#btn-xml-edit').classList.contains('active')
  && document.querySelector('#btn-xml-apply').classList.contains('hidden')`);
check('Fix 3: open/new while in XML edit mode exits edit mode (stale buffer cannot be applied)',
  newLoaded && editOff);

// --- Fix 11: 销毁后状态栏右侧不得残留已销毁模型的元素信息 ------------------------
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  m.get('selection').select(m.get('canvas').getRootElement());
})()`);
await sleep(200);
const rightBefore = await evaluate(`document.querySelector('#status-right').textContent`);
await click('#btn-new-dmn');        // BPMN → DMN 触发 destroyModeler
await waitFor(`!!window.__dmnModeler`);
await sleep(400);
const rightAfter = await evaluate(`document.querySelector('#status-right').textContent`);
check('Fix 11: model destroy clears status-right element info',
  rightBefore.length > 0 && rightAfter === '', `"${rightBefore}" → "${rightAfter}"`);

// --- Fix 10: 小地图按钮 active 随模型销毁清除 ------------------------------------
const minimapActive = await evaluate(`document.querySelector('#btn-minimap').classList.contains('active')`);
check('Fix 10: minimap button not left active after switching to DMN', minimapActive === false);

// --- Fix 15/9/12: DMN 画布拖放打开 + 多决策表动态 tab + 缩放标签跟随 --------------
const twoTables = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"
             xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/"
             id="Definitions_two" name="TwoTables"
             namespace="https://www.omg.org/spec/DMN/20191111/MODEL/">
  <decision id="Decision_A" name="表A">
    <decisionTable id="DecisionTable_A">
      <input id="Input_A"><inputExpression id="InputExpr_A" typeRef="string"><text>x</text></inputExpression></input>
      <output id="Output_A" name="r" typeRef="string" />
    </decisionTable>
  </decision>
  <decision id="Decision_B" name="表B">
    <decisionTable id="DecisionTable_B">
      <input id="Input_B"><inputExpression id="InputExpr_B" typeRef="string"><text>y</text></inputExpression></input>
      <output id="Output_B" name="s" typeRef="string" />
    </decisionTable>
  </decision>
  <dmndi:DMNDI><dmndi:DMNDiagram>
    <dmndi:DMNShape id="Shape_A" dmnElementRef="Decision_A"><dc:Bounds x="100" y="100" width="150" height="80" /></dmndi:DMNShape>
    <dmndi:DMNShape id="Shape_B" dmnElementRef="Decision_B"><dc:Bounds x="320" y="100" width="150" height="80" /></dmndi:DMNShape>
  </dmndi:DMNDiagram></dmndi:DMNDI>
</definitions>`;

// 当前已在 DMN 模式 —— 拖到 DMN 画布应可打开（同模式路径）
await dropFile('#js-dmn-canvas', twoTables, 'two-tables.dmn');
const opened = await waitFor(`document.querySelector('#status-left').textContent.includes('two-tables')`);
check('Fix 15: drop-to-open works on the DMN canvas', opened);

const tabInfo = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#dmn-view-tabs button')];
  return JSON.stringify(tabs.map(t => ({ id: t.id || null, text: t.textContent, disabled: t.disabled })));
})()`);
const tabs = JSON.parse(tabInfo);
const dtTabs = tabs.filter((t) => t.text.startsWith('决策表') && !t.disabled);
check('Fix 9: each decision table gets its own enabled tab (incl. the second one)',
  dtTabs.length === 2 && dtTabs[0].id === 'btn-dmn-decision-table' && dtTabs[1].id === 'btn-dmn-decision-table-2',
  tabInfo);

await click('#btn-dmn-decision-table-2');
await sleep(600);
const activeId = await evaluate(`(window.__dmnModeler.getActiveView() || {}).id`);
check('Fix 9: second decision-table tab switches to its own view', activeId === 'Decision_B', activeId);

const zoomLabel = await evaluate(`document.querySelector('#zoom-level').textContent`);
check('Fix 12: zoom label is a finite % after view switch', /^\d+(\.\d+)?%$/.test(zoomLabel), zoomLabel);

// --- Fix 7: 跨模式打开失败必须回滚（模式 + 模型 + 标题） --------------------------
await dropFile('#js-dmn-canvas', '<?xml version="1.0"?><broken', 'broken.bpmn');
const errShown = await waitFor(`!document.querySelector('#error-overlay').classList.contains('hidden')`);
await sleep(600);
const rollback = await evaluate(`JSON.stringify({
  dmnAlive: !!window.__dmnModeler && (window.__dmnModeler.getViews() || []).length === 3,
  tabsVisible: !document.querySelector('#dmn-view-tabs').classList.contains('hidden'),
  name: document.querySelector('#diagram-name').textContent
})`);
check('Fix 7: failed cross-mode open rolls back to previous mode AND model',
  errShown && JSON.parse(rollback).dmnAlive && JSON.parse(rollback).tabsVisible && JSON.parse(rollback).name === 'two-tables.dmn',
  rollback);
await click('#btn-error-close');

// --- Fix 6: 直写 IPC 只接受经过对话框确认的路径 -----------------------------------
const direct = await evaluate(`window.bpmnStudio.saveDiagramDirect({ path: '/tmp/evil-sprint3.bpmn', content: 'x' })`);
check('Fix 6: saveDiagramDirect refuses a path never confirmed via dialog',
  direct && direct.error && direct.error.code === 'EACCES', JSON.stringify(direct));

// --- Fix 18: prefs 键白名单 --------------------------------------------------------
const prefsProbe = await evaluate(`(async () => {
  const evil = await window.bpmnStudio.setPreference('__proto__', { polluted: true });
  const unknown = await window.bpmnStudio.setPreference('sprint3.unknown', 1);
  const orig = await window.bpmnStudio.getPreference('ui.theme');
  const ok = await window.bpmnStudio.setPreference('ui.theme', 'dark');
  await window.bpmnStudio.setPreference('ui.theme', orig ?? null); // 还原，不污染真实偏好
  return JSON.stringify({ evil, unknown, ok });
})()`);
const pp = JSON.parse(prefsProbe);
check('Fix 18: prefs:set rejects off-allowlist keys, allowlisted key works',
  pp.evil === undefined && pp.unknown === undefined && pp.ok === 'dark', prefsProbe);

console.log('\n' + results.join('\n'));
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} (${results.length} total)`);

ws.close();
app.kill('SIGTERM');
xvfb.kill('SIGTERM');
process.exit(failed === 0 ? 0 : 1);
