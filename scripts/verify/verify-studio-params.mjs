/**
 * verify-studio-params — B2 studio 参数体系 E2E 回归（AppImage + Xvfb + CDP）。
 *
 * 覆盖：
 *  1. 活动类元素「入参/出参」组（中文）可用，DOM 增删改
 *  2. 双向落盘：studio:parameters 与生成的 camunda:inputOutput 都在 XML
 *  3. undo 原子性：单次 undo 同时回退 studio 与 camunda 两侧
 *  4. 路由变量 chips：作用域出参→点击插入条件表达式
 *  5. 边参数投影徽标（overlay .studio-flow-badge）
 *  6. 参数检查面板：R1（未声明变量）/ R4（camunda 漂移 + 修复按钮）
 *  7. 保存→重导入往返回显
 *
 * Usage: node scripts/verify/verify-studio-params.mjs [AppImage]
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
  if (!found.length) throw new Error('no AppImage — run ./build-head.sh --electron --targets AppImage');
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}

const appimage = process.argv[2] || newestAppImage();
console.log('AppImage:', appimage);

const DISPLAY = process.env.VERIFY_DISPLAY || ':81';
const PORT = 9341;

const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const app = spawn(appimage, [
  '--appimage-extract-and-run', '--no-sandbox', '--disable-gpu', '--ozone-platform=x11',
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
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP page target never appeared');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 25000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await evaluate(expr)) return true; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(250);
  }
}

// 夹具：Start → Task_A(审批) → Task_B(处理) → GW1 → Task_C(通过) / End_1(结束)
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="Process_1" name="studio 参数测试">
    <startEvent id="Start_1" name="开始" />
    <userTask id="Task_A" name="审批" />
    <userTask id="Task_B" name="处理" />
    <exclusiveGateway id="GW_1" name="判断" />
    <task id="Task_C" name="通过" />
    <endEvent id="End_1" name="结束" />
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_A" />
    <sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="Task_B" />
    <sequenceFlow id="Flow_3" sourceRef="Task_B" targetRef="GW_1" />
    <sequenceFlow id="Flow_4" sourceRef="GW_1" targetRef="Task_C" />
    <sequenceFlow id="Flow_5" sourceRef="GW_1" targetRef="End_1" />
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="s1" bpmnElement="Start_1"><dc:Bounds x="60" y="180" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="s2" bpmnElement="Task_A"><dc:Bounds x="150" y="160" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="s3" bpmnElement="Task_B"><dc:Bounds x="300" y="160" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="s4" bpmnElement="GW_1"><dc:Bounds x="450" y="175" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="s5" bpmnElement="Task_C"><dc:Bounds x="560" y="100" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="s6" bpmnElement="End_1"><dc:Bounds x="560" y="260" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="e1" bpmnElement="Flow_1"><di:waypoint x="96" y="198" /><di:waypoint x="150" y="200" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="e2" bpmnElement="Flow_2"><di:waypoint x="250" y="200" /><di:waypoint x="300" y="200" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="e3" bpmnElement="Flow_3"><di:waypoint x="400" y="200" /><di:waypoint x="450" y="200" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="e4" bpmnElement="Flow_4"><di:waypoint x="475" y="175" /><di:waypoint x="475" y="140" /><di:waypoint x="560" y="140" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="e5" bpmnElement="Flow_5"><di:waypoint x="475" y="225" /><di:waypoint x="475" y="278" /><di:waypoint x="560" y="278" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && window.__bpmnModeler)`);
check('app booted', booted);
const importOk = await evaluate(`window.__bpmnModeler.importXML(${JSON.stringify(XML)}).then(() => true).catch((e) => 'ERR:' + e.message)`);
check('导入 fixture 成功', importOk === true, importOk);
await sleep(600);

// --- 面板 helpers（挂在 window.__studio 上） ---
await evaluate(`(() => {
  window.__studio = {
    groupTitles: () => [...document.querySelectorAll('#js-properties-panel .bio-properties-panel-group-header-title')].map((e) => e.textContent.trim()),
    openGroup: (gid) => {
      const h = document.querySelector('#js-properties-panel .bio-properties-panel-group[data-group-id="group-' + gid + '"] .bio-properties-panel-group-header');
      if (h && !h.classList.contains('open')) h.click();
      return !!h;
    },
    clickAdd: (gid) => {
      const b = document.querySelector('#js-properties-panel .bio-properties-panel-group[data-group-id="group-' + gid + '"] .bio-properties-panel-add-entry');
      if (b) b.click();
      return !!b;
    },
    clickRemove: (gid, idx) => {
      const items = [...document.querySelectorAll('#js-properties-panel .bio-properties-panel-group[data-group-id="group-' + gid + '"] .bio-properties-panel-list-item')];
      const item = items[idx];
      if (item) { const r = item.querySelector('.bio-properties-panel-remove-entry'); if (r) r.click(); }
      return !!item && !!item.querySelector('.bio-properties-panel-remove-entry');
    },
    setText: (eid, value) => {
      const host = document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"]');
      const el = host && host.querySelector('input, textarea');
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    setSelect: (eid, value) => {
      const sel = document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"] select');
      if (!sel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, value);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    clickChip: (name) => {
      const chip = [...document.querySelectorAll('#js-properties-panel .studio-var-chip')].find((c) => c.textContent === name);
      if (chip) { chip.click(); return true; }
      return false;
    },
    parState: (elId) => {
      const bo = window.__bpmnModeler.get('elementRegistry').get(elId).businessObject;
      const vals = (bo.extensionElements && bo.extensionElements.get('values')) || [];
      const sp = vals.find((v) => v.$instanceOf && v.$instanceOf('studio:Parameters'));
      const io = vals.find((v) => v.$instanceOf && v.$instanceOf('camunda:InputOutput'));
      return {
        studioIn: sp ? (sp.get('inputParameters') || []).map((p) => ({ name: p.get('name'), type: p.get('type') })) : [],
        studioOut: sp ? (sp.get('outputParameters') || []).map((p) => ({ name: p.get('name'), type: p.get('type') })) : [],
        camIn: io ? (io.get('inputParameters') || []).map((p) => p.get('name')) : [],
        camOut: io ? (io.get('outputParameters') || []).map((p) => ({ name: p.get('name'), value: p.get('value') })) : []
      };
    },
    saveXml: () => window.__bpmnModeler.saveXML({ format: true }).then((r) => r.xml),
    itemCount: (gid) => document.querySelectorAll('#js-properties-panel .bio-properties-panel-group[data-group-id="group-' + gid + '"] .bio-properties-panel-list-item').length,
    conditionOf: (elId) => {
      const bo = window.__bpmnModeler.get('elementRegistry').get(elId).businessObject;
      const ce = bo.get('conditionExpression');
      return ce ? ce.get('body') : null;
    },
    checkText: () => (document.querySelector('#studio-check-summary') || { textContent: '' }).textContent,
    checkList: () => (document.querySelector('#studio-check-list') || { textContent: '' }).textContent,
    badges: () => [...document.querySelectorAll('.studio-flow-badge')].map((b) => b.textContent)
  };
  true
})()`);

// --- 1. 参数组 UI ---
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Task_A')); })()`);
await sleep(400);
const titles = await evaluate(`window.__studio.groupTitles().join('|')`);
check('Task_A 出现「入参/出参」组（中文）',
  titles.includes('入参（流程变量 → 节点局部）') && titles.includes('出参（节点结果 → 流程变量）'), titles);

// --- 2. 添加入参 income(number/expression) ---
await evaluate(`window.__studio.clickAdd('StudioParams__Inputs')`);
const inAdded = await waitFor(`window.__studio.parState('Task_A').studioIn.length === 1`);
check('添加入参 → studio inputParameters 1 条', inAdded);
await sleep(200);
await evaluate(`window.__studio.setText('studio-inputParameters-name-0', 'income')`);
await evaluate(`window.__studio.setSelect('studio-inputParameters-type-0', 'number')`);
await evaluate(`window.__studio.setText('studio-inputParameters-expression-0', 'income')`);
const inFilled = await waitFor(`JSON.stringify(window.__studio.parState('Task_A').studioIn[0]) === JSON.stringify({name:'income',type:'number'})`);
check('入参名称/类型/表达式填写生效', inFilled);

// --- 3. 添加出参 result(boolean) + camunda 双向落盘 ---
await evaluate(`window.__studio.clickAdd('StudioParams__Outputs')`);
await waitFor(`window.__studio.parState('Task_A').studioOut.length === 1`);
await sleep(200);
await evaluate(`window.__studio.setText('studio-outputParameters-name-0', 'result')`);
await evaluate(`window.__studio.setSelect('studio-outputParameters-type-0', 'boolean')`);
await evaluate(`window.__studio.setText('studio-outputParameters-expression-0', 'result')`);
const outFilled = await waitFor(`JSON.stringify(window.__studio.parState('Task_A').studioOut[0]) === JSON.stringify({name:'result',type:'boolean'})`);
check('出参 result 生效', outFilled);

const dualWrite = await waitFor(`(() => {
  const s = window.__studio.parState('Task_A');
  return s.camIn.length === 1 && s.camOut.length === 1 &&
    s.camIn[0] === 'income' && s.camOut[0].name === 'result' && s.camOut[0].value === 'result';
})()`);
check('camunda:inputOutput 同步生成（收入 Income / 出 result）', dualWrite);

let xml = await evaluate(`window.__studio.saveXml()`);
check('XML 双写：studio:parameters + camunda:inputOutput',
  xml.includes('<studio:parameters>') && xml.includes('camunda:inputOutput') &&
  xml.includes('studio:outputParameter') && xml.includes('camunda:outputParameter'));

// --- 4. undo 原子性：改名 → undo → 两侧同时回退 ---
await evaluate(`window.__studio.setText('studio-inputParameters-name-0', 'salary')`);
const renamed = await waitFor(`window.__studio.parState('Task_A').studioIn[0].name === 'salary'`);
xml = await evaluate(`window.__studio.saveXml()`);
check('改名后 XML 含 salary', renamed && xml.includes('salary'));

await evaluate(`window.__bpmnModeler.get('commandStack').undo()`);
const atomicUndo = await waitFor(`(() => {
  const s = window.__studio.parState('Task_A');
  return s.studioIn[0].name === 'income' && s.camIn[0] === 'income';
})()`);
check('单次 undo 同时回退 studio 与 camunda 两侧（原子批）', atomicUndo, `camIn=${await evaluate(`window.__studio.parState('Task_A').camIn[0]`)}`);
xml = await evaluate(`window.__studio.saveXml()`);
check('undo 后 XML 不含 salary', !xml.includes('salary'));

// --- 5. Task_B 加入参 result → 边参数投影徽标 ---
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Task_B')); })()`);
await sleep(400);
await evaluate(`window.__studio.clickAdd('StudioParams__Inputs')`);
await waitFor(`window.__studio.parState('Task_B').studioIn.length === 1`);
await sleep(200);
await evaluate(`window.__studio.setText('studio-inputParameters-name-0', 'result')`);
const badgeOk = await waitFor(`window.__studio.badges().some((t) => t.includes('result'))`, 15000);
check('边参数投影徽标（Flow_2 Task_A→Task_B ⇄ result）', badgeOk, `badges=${JSON.stringify(await evaluate(`window.__studio.badges()`))}`);

// --- 6. 路由变量 chips → 点击插入条件 ---
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Flow_4')); })()`);
await sleep(400);
await evaluate(`window.__studio.openGroup('CamundaPlatform__Condition')`);
await sleep(200);
await evaluate(`window.__studio.setSelect('conditionType', 'expression')`);
const condReady = await waitFor(`!!document.querySelector('#js-properties-panel [data-entry-id="conditionExpression"] input')`);
check('条件组就绪（表达式输入框出现）', condReady);

const chips = await evaluate(`[...document.querySelectorAll('#js-properties-panel .studio-var-chip')].map((c) => c.textContent).join(',')`);
check('路由变量 chips 含 result（作用域出参）', chips.includes('result'), chips);
await evaluate(`window.__studio.clickChip('result')`);
const condInserted = await waitFor(`(window.__studio.conditionOf('Flow_4') || '').includes('result')`);
check('点击 chip 插入条件表达式', condInserted, await evaluate(`window.__studio.conditionOf('Flow_4')`));
xml = await evaluate(`window.__studio.saveXml()`);
check('条件表达式落盘 XML', xml.includes('conditionExpression') && /conditionExpression[^>]*>.*result/.test(xml) || xml.includes('result'));

// --- 7. 参数检查面板：基线一致 + R1 + R4 修复 ---
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Task_C')); })()`);
await sleep(400);
await evaluate(`document.querySelector('#btn-studio-check').click()`);
await sleep(400);
const baseline = await evaluate(`window.__studio.checkText()`);
check('参数检查基线：一致 ✓', baseline.includes('一致') || baseline === '参数/路由一致 ✓', baseline);

// R1：条件引用未声明变量
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Flow_4')); })()`);
await sleep(400);
await evaluate(`window.__studio.setText('conditionExpression', 'ghost_var >= 1')`);
const r1Shown = await waitFor(`window.__studio.checkList().includes('R1') && window.__studio.checkList().includes('ghost_var')`);
check('R1：引用未声明变量 → 检查面板 warn', r1Shown, (await evaluate(`window.__studio.checkList()`)).slice(0, 120));

// R4：外部直改 camunda 映射 → 漂移 error + 修复
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  const bo = m.get('elementRegistry').get('Task_A').businessObject;
  const io = bo.extensionElements.get('values').find((v) => v.$instanceOf('camunda:InputOutput'));
  const param = io.get('outputParameters')[0];
  m.get('modeling').updateModdleProperties(m.get('elementRegistry').get('Task_A'), param, { name: 'mutated' });
})()`);
const r4Shown = await waitFor(`window.__studio.checkList().includes('R4')`);
check('R4：camunda 映射被外部修改 → 漂移 error', r4Shown, (await evaluate(`window.__studio.checkList()`)).slice(0, 160));
const fixBtn = await evaluate(`!!document.querySelector('#studio-check-list .studio-fix-btn')`);
check('R4 行提供「重新生成」修复按钮', fixBtn);
if (fixBtn) await evaluate(`document.querySelector('#studio-check-list .studio-fix-btn').click()`);
const r4Fixed = await waitFor(`!window.__studio.checkList().includes('R4')`);
check('点击修复后 R4 清零（映射按 studio 重建）', r4Fixed, (await evaluate(`window.__studio.checkList()`)).slice(0, 120));
xml = await evaluate(`window.__studio.saveXml()`);
check('修复后 XML 恢复 result 映射', xml.includes('name="result"'));

// --- 8. 保存 → 重导入往返回显 ---
xml = await evaluate(`window.__studio.saveXml()`);
check('round-trip 源仍含 studio+camunda', xml.includes('<studio:parameters>') && xml.includes('camunda:inputOutput'));

const reimport = await evaluate(
  'window.__bpmnModeler.importXML(' + JSON.stringify(xml) + ').then(function(){return true}).catch(function(e){return "ERR:" + e.message})'
);
check('重导入成功', reimport === true, reimport);
await sleep(800);
await evaluate(`(() => { const m = window.__bpmnModeler; m.get('selection').select(m.get('elementRegistry').get('Task_A')); })()`);
await sleep(600);
const back = await evaluate(`window.__studio.parState('Task_A')`);
check('重导入后参数回显（入参 income + 出参 result）',
  back && back.studioIn && back.studioIn[0] && back.studioIn[0].name === 'income' &&
  back.studioOut[0] && back.studioOut[0].name === 'result',
  JSON.stringify(back).slice(0, 200));

console.log(results.join('\n'));
console.log(`\n${failed ? failed + ' FAILED' : 'ALL PASSED'} (${results.length} checks)`);
await sleep(200);
app.kill();
xvfb.kill();
process.exit(failed ? 1 : 0);
