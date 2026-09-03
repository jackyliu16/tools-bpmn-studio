/**
 * Full-shell UI harness: loads the REAL index.html + REAL src/main.js under
 * jsdom (via vite-node + css-stub config) and drives the XML editing flow.
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement;
globalThis.SVGMatrix = window.SVGMatrix || class SVGMatrix {};
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.DOMParser = window.DOMParser;
globalThis.CSS = window.CSS || {};
globalThis.CSS.escape = cssEscape;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));

// SVG / canvas polyfills (from smoke.mjs)
window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 20 });
window.SVGElement.prototype.getScreenCTM = () => null;
window.SVGElement.prototype.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
window.SVGElement.prototype.getComputedTextLength = () => 0;
window.SVGSVGElement.prototype.createSVGTransform = () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return { matrix, type: 1, setTranslate(x, y) { matrix.e = x; matrix.f = y; }, setScale(x, y) { matrix.a = x; matrix.d = y; }, setRotate() {}, setMatrix(m) { Object.assign(matrix, m); } };
};
window.SVGSVGElement.prototype.createSVGTransformFromMatrix = (matrix) => ({ matrix, type: 1, setMatrix(m) { Object.assign(this.matrix, m); } });
window.SVGSVGElement.prototype.createSVGMatrix = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, scale(s) { this.a *= s; this.d *= s; return this; }, translate(x, y) { this.e = x; this.f = y; return this; }, multiply() { return this; } });
const fakeTransformList = () => {
  const items = [];
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, multiply() { return matrix; } };
  return { numberOfItems: 0, clear() { items.length = 0; this.numberOfItems = 0; }, appendItem(i) { items.push(i); this.numberOfItems = items.length; return i; }, initialize(i) { return this.appendItem(i); }, createSVGTransformFromMatrix(m) { return m; }, consolidate() { return { matrix: items.length ? items[items.length - 1] : matrix, type: 1 }; } };
};
Object.defineProperty(window.SVGElement.prototype, 'transform', { configurable: true, get() { return { baseVal: fakeTransformList(), animVal: fakeTransformList() }; } });
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    font: '', measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 4 }),
    save() {}, restore() {}, fillText() {}, translate() {}, scale() {}, clearRect() {}
  };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// boot the REAL app shell (jsdom does not execute <script type="module">)
await import('/src/main.js');
await new Promise((r) => setTimeout(r, 2500));

const q = (sel) => window.document.querySelector(sel);
const modeler = window.__bpmnModeler;
check('modeler booted', !!modeler);

// --- 1. open XML panel ---
q('#btn-xml').click();
await new Promise((r) => setTimeout(r, 800));
check('XML panel visible', !q('#xml-panel').classList.contains('hidden'));
check('xml content rendered', (q('#xml-code').textContent || '').includes('bpmn:definitions'));

// --- 2. clicking the viewer should NOT enter edit mode ---
q('#xml-viewer').click();
await new Promise((r) => setTimeout(r, 50));
check('click on viewer stays readonly', q('#xml-code').contentEditable !== 'true', 'code stays readonly');

// --- 3. enter edit mode via the 编辑 button ---
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
check('edit button enters edit mode', q('#xml-code').contentEditable === 'true', 'code becomes contenteditable');
check('apply button visible', q('#btn-xml-apply').classList.contains('hidden') === false);
check('code still contains XML content', (q('#xml-code').textContent || '').includes('Process_1'));

// --- 3. edit content: rename the process ---
const origXml = q('#xml-code').textContent;
const edited = origXml
  .replace('name="示例流程"', 'name="被我改过的流程"')
  .replace('id="Process_1"', 'id="Process_Edited"');
q('#xml-code').textContent = edited;

// --- 4. apply ---
q('#btn-xml-apply').click();
await new Promise((r) => setTimeout(r, 1500));
check('code returns to readonly after apply', q('#xml-code').contentEditable === 'false');
check('apply button hidden after apply', q('#btn-xml-apply').classList.contains('hidden'));
const defs = modeler.getDefinitions();
const proc = defs.rootElements.find((re) => re.$type === 'bpmn:Process');
check('applied: process renamed', proc && proc.name === '被我改过的流程', proc && proc.name);
check('applied: process id changed', proc && proc.id === 'Process_Edited', proc && proc.id);
check('xml view refreshed with new content', (q('#xml-code').textContent || '').includes('Process_Edited'));

// --- 5. edit mode + invalid XML → big error ---
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
q('#xml-code').textContent = '<bpmn:definitions><unclosed';
q('#btn-xml-apply').click();
await new Promise((r) => setTimeout(r, 300));
check('invalid XML shows big error overlay', !q('#error-overlay').classList.contains('hidden'), q('#error-title').textContent);
q('#btn-error-close').click();

// --- 6. revert discards edits ---
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
q('#xml-code').textContent = 'GARBAGE';
q('#btn-xml-revert').click();
await new Promise((r) => setTimeout(r, 100));
check('revert returns to readonly view', q('#xml-code').contentEditable !== 'true');
check('revert keeps model unchanged', (modeler.getDefinitions().rootElements[0].name === '被我改过的流程'));

// --- 7a. 解析警告：行/列 + 元素线索（moddle lax 解析 → 导入成功 + 警告） ---
// 合法命名空间中放入一个未知节点：DOMParser 预检通过，moddle 在 lax 模式下把它记为
// 警告（消息内嵌 line/column，此处应为第 5 行）→ 提示条 → 详情列表应显示真实行/列。
const laxXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Defs_w" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_w" isExecutable="true">
    <bpmn:startEvent id="Start_w" />
    <bpmn:unparsableThing id="Junk_w" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_w">
    <bpmndi:BPMNPlane id="Plane_w" bpmnElement="Process_w">
      <bpmndi:BPMNShape id="Start_w_di" bpmnElement="Start_w"><dc:Bounds x="100" y="100" width="36" height="36" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
q('#xml-code').textContent = laxXml;
q('#btn-xml-apply').click();
await new Promise((r) => setTimeout(r, 1200));
check('parse warning: notice bar appears', !q('#notice-bar').classList.contains('hidden'), q('#notice-text').textContent);
q('#btn-notice-details').click();
await new Promise((r) => setTimeout(r, 100));
const warnPos = q('#error-warnings .warn-pos');
check('parse warning: 详情显示真实行/列', !!(warnPos && /第 \d+ 行, 第 \d+ 列/.test(warnPos.textContent)), warnPos && warnPos.textContent);
q('#btn-error-close').click();
await new Promise((r) => setTimeout(r, 50));
q('#btn-notice-close').click();

// --- 7b. 导入拒绝（有命名空间但无 BPMNDI 图 → 'no diagram to display'）---
// 导入失败但 moddle 不给位置信息 → 摘要应隐藏（优雅退化），但「查看原文」仍可用。
const noDiXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_noDI" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_NoDI" isExecutable="true" />
</bpmn:definitions>`;
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
q('#xml-code').textContent = noDiXml;
q('#btn-xml-apply').click();
await new Promise((r) => setTimeout(r, 1200));
check('import rejection: error overlay shown', !q('#error-overlay').classList.contains('hidden'), q('#error-title').textContent);
check('import rejection: 无位置时不显示摘要（优雅退化）', q('#error-excerpt').classList.contains('hidden'));
check('import rejection: 查看原文按钮可见', !q('#btn-error-view-xml').classList.contains('hidden'));
q('#btn-error-view-xml').click();
await new Promise((r) => setTimeout(r, 200));
check('view-original: XML 面板显示失败原文',
  !q('#xml-panel').classList.contains('hidden') && q('#xml-code').textContent.includes('id="Defs_noDI"'), '');
check('view-original: 无位置 → 无行级高亮', !q('#xml-code mark.xml-err-line'));
check('view-original: 状态注明非当前模型', (q('#xml-status').textContent || '').includes('非当前模型内容'));
q('#btn-xml-revert').click(); // 退出编辑态，恢复只读
await new Promise((r) => setTimeout(r, 100));

// --- 8. lint 面板：逐条明细 + 点击定位 ---
const lintXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Defs_lint" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_lint" isExecutable="true">
    <bpmn:startEvent id="Start_lint" />
    <bpmn:task id="Task_NoLabel" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_lint">
      <bpmndi:BPMNShape id="Start_lint_di" bpmnElement="Start_lint"><dc:Bounds x="100" y="100" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_NoLabel_di" bpmnElement="Task_NoLabel"><dc:Bounds x="200" y="94" width="100" height="80" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
q('#btn-xml-edit').click();
await new Promise((r) => setTimeout(r, 50));
q('#xml-code').textContent = lintXml;
q('#btn-xml-apply').click();
await new Promise((r) => setTimeout(r, 2500));
const lintModeler = window.__bpmnModeler;
const rows = q('#lint-list').querySelectorAll('.lint-issue');
check('lint panel lists per-issue rows', rows.length >= 3, `rows=${rows.length}`);
check('lint rows carry rule attribute', !!q('#lint-list .lint-issue[data-rule]'));
check('lint severity badge rendered', !!q('#lint-list .lint-badge.error'));
check('lint message text rendered', !!(q('#lint-list .lint-message') && q('#lint-list .lint-message').textContent.length > 0));
check('lint element chip rendered', !!q('#lint-list .elem-chip'));
const firstRow = rows[0];
const labelRow = [...rows].find((li) => li.dataset.id === 'Task_NoLabel') || firstRow;
labelRow.click();
await new Promise((r) => setTimeout(r, 200));
const selection = lintModeler.get('selection').get();
check('clicking lint row selects target element', selection.some((s) => s.id === 'Task_NoLabel'),
  selection.map((s) => s.id).join(','));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
window.close && window.close();
process.exit(failed ? 1 : 0);