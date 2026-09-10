/**
 * verify-control-panel — 控制要素管理界面/管理逻辑回归（AppImage + Xvfb + CDP）。
 *
 * 验证对象（v0.1.15 控制要素改造）：
 *   P0  纯 BPMN 文件（无 camunda 命名空间）也默认获得 Camunda 平台字段集
 *   P1  「网关默认流」控制要素（官方缺失字段，camunda ns 落盘）
 *   P1  属性面板中文标签覆盖（translate 服务 override）
 *   P2  管理逻辑：默认流/条件表达式写入真实 BPMN 属性 → lint（camunda/forking-conditions）
 *       联动消除；删除出线后网关 default 悬空引用自动清理
 *
 * Usage: node scripts/verify/verify-control-panel.mjs [path/to/AppImage]
 * 需要 AppImage 与本改动同步构建（./build-head.sh --electron --targets AppImage）。
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
const PORT = 9340;

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await evaluate(expr)) return true;
    } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(250);
  }
}

// --- 纯 BPMN 夹具（无任何 camunda/zeebe 命名空间） ---------------------------
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="Process_1" name="控制要素测试流程">
    <startEvent id="Start_1" name="开始" />
    <exclusiveGateway id="Gateway_1" name="审批判断" />
    <userTask id="Task_A" name="审批通过" />
    <userTask id="Task_B" name="驳回" />
    <endEvent id="End_1" name="结束" />
    <sequenceFlow id="Flow_s" sourceRef="Start_1" targetRef="Gateway_1" />
    <sequenceFlow id="Flow_A" sourceRef="Gateway_1" targetRef="Task_A" />
    <sequenceFlow id="Flow_B" sourceRef="Gateway_1" targetRef="Task_B" />
    <sequenceFlow id="Flow_e1" sourceRef="Task_A" targetRef="End_1" />
    <sequenceFlow id="Flow_e2" sourceRef="Task_B" targetRef="End_1" />
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1"><dc:Bounds x="100" y="200" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_1_di" bpmnElement="Gateway_1"><dc:Bounds x="220" y="200" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_A_di" bpmnElement="Task_A"><dc:Bounds x="360" y="130" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_B_di" bpmnElement="Task_B"><dc:Bounds x="360" y="260" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1"><dc:Bounds x="560" y="200" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_s_di" bpmnElement="Flow_s"><di:waypoint x="136" y="218" /><di:waypoint x="220" y="225" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_A_di" bpmnElement="Flow_A"><di:waypoint x="245" y="200" /><di:waypoint x="245" y="170" /><di:waypoint x="360" y="170" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_B_di" bpmnElement="Flow_B"><di:waypoint x="245" y="250" /><di:waypoint x="245" y="300" /><di:waypoint x="360" y="300" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_e1_di" bpmnElement="Flow_e1"><di:waypoint x="460" y="170" /><di:waypoint x="560" y="218" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_e2_di" bpmnElement="Flow_e2"><di:waypoint x="460" y="300" /><di:waypoint x="560" y="250" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

// wait for the app shell + initial BPMN diagram
const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && window.__bpmnModeler)`);
check('app booted (canvas rendered, debug globals exposed)', booted);

// --- 1. 导入纯 BPMN 夹具 -------------------------------------------------------
const importOk = await evaluate(`window.__bpmnModeler.importXML(${JSON.stringify(XML)}).then(() => true).catch(e => 'ERR:' + e.message)`);
check('导入纯 BPMN 夹具（无 camunda 命名空间）成功', importOk === true, importOk);
await sleep(500);

// --- helpers（在渲染器内定义，两条 CDP 通道共用） -------------------------------
const panelExpressions = `
  window.__panel = {
    groupTitles: () => [...document.querySelectorAll('#js-properties-panel .bio-properties-panel-group-header-title')].map(e => e.textContent.trim()),
    openGroup: (gid) => {
      const h = document.querySelector('#js-properties-panel .bio-properties-panel-group[data-group-id="group-' + gid + '"] .bio-properties-panel-group-header');
      if (!h) return false;
      if (!h.classList.contains('open')) h.click();
      return true;
    },
    entry: (eid) => document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"]'),
    selectValue: (eid) => {
      const sel = document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"] select');
      return sel ? sel.value : null;
    },
    setSelect: (eid, value) => {
      const sel = document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"] select');
      if (!sel) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, value);
      // @bpmn-io/properties-panel 的 <select> 绑定 onInput（preact → 原生 input 事件）
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setText: (eid, value) => {
      const host = document.querySelector('#js-properties-panel [data-entry-id="' + eid + '"]');
      const el = host && (host.querySelector('input, textarea'));
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    saveXml: () => window.__bpmnModeler.saveXML({ format: true }).then(r => r.xml),
    lintText: () => (document.querySelector('#lint-list') || { textContent: '' }).textContent
  };
  true
`;
await evaluate(panelExpressions);

// --- 2. P1：选中排他网关 → 「网关默认流」组 + 中文标签 --------------------------
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  m.get('selection').select(m.get('elementRegistry').get('Gateway_1'));
})()`);
await sleep(400);

const gatewayGroups = await evaluate(`window.__panel.groupTitles().join('|')`);
check('面板中文分组渲染（通用/网关默认流/异步延续/执行监听器…）',
  gatewayGroups.includes('通用') && gatewayGroups.includes('网关默认流') &&
  gatewayGroups.includes('异步延续') && gatewayGroups.includes('执行监听器'), gatewayGroups);

const defaultFlowGroupShown = await evaluate(`window.__panel.openGroup('ControlPanel__GatewayDefaultFlow')`);
check('「网关默认流」分组渲染并可展开', defaultFlowGroupShown);

const options = await evaluate(`[...document.querySelectorAll('#js-properties-panel [data-entry-id="gatewayDefaultFlow"] select option')].map(o => o.value).join(',')`);
check('默认出线下拉包含全部出线（Flow_A/Flow_B）', options === 'Flow_A,Flow_B', options);

// --- 3. P2：通过下拉设置默认流 → 落盘 camunda 语义（default 属性） ---------------
const setDefault = await evaluate(`window.__panel.setSelect('gatewayDefaultFlow', 'Flow_B')`);
const defaultLanded = await waitFor(`(window.__bpmnModeler.get('elementRegistry').get('Gateway_1').businessObject.default || {}).id === 'Flow_B'`);
check('通过下拉将 Flow_B 设为默认流（模型层确认）', setDefault && defaultLanded);

const modelDefault = await evaluate(`(() => {
  const m = window.__bpmnModeler;
  const gw = m.get('elementRegistry').get('Gateway_1');
  return (gw.businessObject.default || {}).id;
})()`);
check('模型内 Gateway_1.default === Flow_B（组件 setter 生效）', modelDefault === 'Flow_B', modelDefault || '(default 未写入)');

let xml = await evaluate(`window.__panel.saveXml()`);
check('保存 XML 含 gateway default="Flow_B"', xml.includes('default="Flow_B"'), xml.includes('default="Flow_B"') ? '' : '缺少 default 属性');
check('纯 BPMN 文件未引入 camunda 命名空间（仅写标准属性）', !xml.includes('camunda.org/schema'));

// --- 4. P2：默认流 + lint 联动（camunda/forking-conditions 应只报 Flow_A） -------
const lintDefaulted = await waitFor(`(() => {
  const t = document.querySelector('#lint-list')?.textContent || '';
  return t.includes('Flow_A') && !t.includes('Flow_B');
})()`);
const lintAfterDefault = await evaluate(`window.__panel.lintText()`);
check('设置默认流后 lint 不再标记默认出线 Flow_B，仅报 Flow_A（missing condition）',
  lintDefaulted && /Flow_A/.test(lintAfterDefault) && !/Flow_B/.test(lintAfterDefault),
  lintAfterDefault.slice(0, 120));

// --- 5. P1/P2：Flow_A 填条件表达式（camunda Condition 组，中文标签） -------------
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  m.get('selection').select(m.get('elementRegistry').get('Flow_A'));
})()`);
await sleep(400);
await evaluate(`window.__panel.openGroup('CamundaPlatform__Condition')`);
await sleep(200);

const condGroupTitle = await evaluate(`document.querySelector('#js-properties-panel .bio-properties-panel-group[data-group-id="group-CamundaPlatform__Condition"] .bio-properties-panel-group-header-title')?.textContent.trim()`);
check('「条件」分组中文标题正确', condGroupTitle === '条件', condGroupTitle);

// 条件类型：表达式
const setCondType = await evaluate(`window.__panel.setSelect('conditionType', 'expression')`);
check('条件类型设为「表达式」', setCondType && await waitFor(`!!window.__panel.entry('conditionExpression')`));

// 表达式正文（等模型落地：debounce 300ms）
const setCondBody = await evaluate(`window.__panel.setText('conditionExpression', "income >= 1000")`);
const bodyLanded = await waitFor(`(() => {
  const bo = window.__bpmnModeler.get('elementRegistry').get('Flow_A').businessObject;
  return !!(bo.conditionExpression && bo.conditionExpression.get('body') === 'income >= 1000');
})()`);
check('写入条件表达式正文（模型层确认）', setCondBody && bodyLanded);

xml = await evaluate(`window.__panel.saveXml()`);
check('保存 XML 含 conditionExpression，且条件正文落盘',
  xml.includes('conditionExpression') && xml.includes('income &gt;= 1000') || xml.includes('income >= 1000'),
  xml.includes('conditionExpression') ? '' : '缺少 conditionExpression');

// lint：两条出线一条有条件、一条默认 → 不再报 missing condition
// （注：条件出线会被 bpmnlint label-required 要求补标签，属既有标准行为）
const lintFixed = await waitFor(`!((document.querySelector('#lint-list')?.textContent || '').includes('missing condition'))`);
const lintAfterFix = await evaluate(`window.__panel.lintText()`);
check('条件 + 默认流齐备后 lint 不再报 missing condition',
  lintFixed,
  lintAfterFix.slice(0, 160));

// --- 6. P2：undo 回退（命令栈粒度 = 单个字段命令） ---------------------------------
await evaluate(`window.__bpmnModeler.get('commandStack').undo()`);
const undoLanded = await waitFor(`(() => {
  const bo = window.__bpmnModeler.get('elementRegistry').get('Flow_A').businessObject;
  return !(bo.conditionExpression && bo.conditionExpression.get('body') === 'income >= 1000');
})()`);
check('undo 回退条件表达式（正文消失）', undoLanded);
xml = await evaluate(`window.__panel.saveXml()`);
check('undo 后默认流保留（default="Flow_B"）', xml.includes('default="Flow_B"'), xml.includes('default="Flow_B"') ? '' : '默认流也被回退了');

// --- 7. P2：删除默认流出线 → 悬空引用自动清理 -----------------------------------
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  // 重新设默认流后删除，验证悬空引用自动清理
  const gw = m.get('elementRegistry').get('Gateway_1');
  const flowB = m.get('elementRegistry').get('Flow_B');
  m.get('modeling').updateProperties(gw, { default: flowB.businessObject });
})()`);
const defaultReset = await waitFor(`(window.__bpmnModeler.get('elementRegistry').get('Gateway_1').businessObject.default || {}).id === 'Flow_B'`);
check('重新设置默认流（步骤 7 前置）', defaultReset);
await evaluate(`(() => {
  const m = window.__bpmnModeler;
  m.get('modeling').removeElements([m.get('elementRegistry').get('Flow_B')]);
})()`);
const cleaned = await waitFor(`(() => {
  const gw = window.__bpmnModeler.get('elementRegistry').get('Gateway_1');
  return !gw.businessObject.default;
})()`); // elements.changed 节流 80ms + 清理逻辑
check('删除默认流出线后 gateway.default 悬空引用被清理（模型层确认）', cleaned);
xml = await evaluate(`window.__panel.saveXml()`);
check('删除默认流出线后 gateway.default 悬空引用被清理',
  !xml.includes('default="Flow_B"'),
  xml.includes('default="Flow_B"') ? '残留 default 引用' : '');

const gwDefaultAfter = await evaluate(`(() => {
  const m = window.__bpmnModeler;
  return (m.get('elementRegistry').get('Gateway_1').businessObject.default || null) === null;
})()`);
check('模型内 Gateway_1.default 已清空', gwDefaultAfter === true);

// --- 8. 汇总 -------------------------------------------------------------------
console.log(results.join('\n'));
console.log(`\n${failed ? failed + ' FAILED' : 'ALL PASSED'} (${results.length} checks)`);
await sleep(200);
app.kill();
xvfb.kill();
process.exit(failed ? 1 : 0);