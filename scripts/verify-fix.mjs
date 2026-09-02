/**
 * Verify both fixes:
 *   1. rebuildFlowNodeBackrefs (wired via import.parse.complete, exactly as
 *      src/main.js now does) eliminates the connectivity false positives
 *      on the valid sample — while REAL problems are still detected.
 *   2. The NEW diagnostic collection sequence (eventBus.once +
 *      linting.update + live-state fallback) captures the live issues with
 *      their category, instead of always printing "none".
 *
 * Usage: npx vite-node scripts/verify-fix.mjs
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- minimal DOM (same as other harness scripts) --------------------------------
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="js-canvas"></div><div id="js-properties-panel"></div>
</body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location; globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement; globalThis.SVGMatrix = window.SVGMatrix || class {};
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.Node = window.Node; globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent; globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.File = window.File;
window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 20 });
window.SVGElement.prototype.getScreenCTM = () => null;
window.SVGElement.prototype.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
window.SVGElement.prototype.getComputedTextLength = () => 0;
window.SVGSVGElement.prototype.createSVGTransform = () => {
  const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return { matrix: m, type: 1, setTranslate(x, y) { m.e = x; m.f = y; }, setScale(x, y) { m.a = x; m.d = y; }, setRotate() {}, setMatrix(o) { Object.assign(m, o); } };
};
window.SVGSVGElement.prototype.createSVGTransformFromMatrix = (matrix) => ({ matrix, type: 1, setMatrix(m) { Object.assign(this.matrix, m); } });
Object.defineProperty(window.SVGElement.prototype, 'transform', {
  configurable: true,
  get() { return { baseVal: { numberOfItems: 0, clear() {}, appendItem(i) { return i; }, initialize(i) { return i; }, createSVGTransformFromMatrix(m) { return m; }, consolidate() { return { matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, type: 1 }; } }, animVal: {} }; }
});
globalThis.CSS = window.CSS || {}; globalThis.CSS.escape = cssEscape;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.HTMLCanvasElement.prototype.getContext = () => ({
  font: '', measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 4 }),
  save() {}, restore() {}, fillText() {}, translate() {}, scale() {}, clearRect() {}
});

// --- assertions ------------------------------------------------------------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// --- the backref fix, copied from src/main.js (must stay in sync) ---------------
function rebuildFlowNodeBackrefs(definitions) {
  if (!definitions) return;

  const rebuildContainer = (container) => {
    const flowElements = container.flowElements || [];

    for (const fe of flowElements) {
      if (fe.$instanceOf && fe.$instanceOf('bpmn:FlowNode')) {
        fe.incoming = [];
        fe.outgoing = [];
      }
    }

    for (const fe of flowElements) {
      if (fe.$type !== 'bpmn:SequenceFlow' && fe.$type !== 'bpmn:MessageFlow') continue;
      const source = fe.sourceRef;
      const target = fe.targetRef;
      if (source && Array.isArray(source.outgoing)) source.outgoing.push(fe);
      if (target && Array.isArray(target.incoming)) target.incoming.push(fe);
    }

    for (const fe of flowElements) {
      if (fe.flowElements) rebuildContainer(fe);
    }
  };

  for (const re of definitions.rootElements || []) {
    if (re.processRef) {
      rebuildContainer(re.processRef);
    } else if (re.$type === 'bpmn:Process') {
      rebuildContainer(re);
    }
  }
}

const BpmnLintModule = (await import('bpmn-js-bpmnlint')).default;
const BpmnModeler = (await import('bpmn-js/lib/Modeler.js')).default;
const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));

// apply the same DI-label prototype patch as src/main.js
{
  const LintingClass = BpmnLintModule.linting[1];
  const origFormat = LintingClass.prototype._formatIssues;
  LintingClass.prototype._formatIssues = function (issues) {
    const r = origFormat.call(this, issues);
    const f = {};
    for (const id in r) if (typeof id !== 'string' || !id.endsWith('_label')) f[id] = r[id];
    return f;
  };
  const origCreate = LintingClass.prototype._createIssues;
  LintingClass.prototype._createIssues = function (issues) {
    const f = {};
    for (const id in issues) if (typeof id !== 'string' || !id.endsWith('_label')) f[id] = issues[id];
    return origCreate.call(this, f);
  };
}

function makeModeler() {
  const modeler = new BpmnModeler({
    container: '#js-canvas',
    propertiesPanel: { parent: '#js-properties-panel' },
    additionalModules: [BpmnLintModule],
    moddleExtensions: {},
    linting: { bpmnlint: lintConfig }
  });
  // exact wiring added to src/main.js
  modeler.on('import.parse.complete', (event) => {
    rebuildFlowNodeBackrefs(event.definitions);
  });
  modeler.on('elements.changed', () => {
    rebuildFlowNodeBackrefs(modeler.getDefinitions());
  });
  return modeler;
}

function printIssues(issues) {
  const out = [];
  for (const id of Object.keys(issues || {})) {
    for (const issue of issues[id] || []) {
      out.push(`    ${id} [${issue.category}] ${issue.rule}: ${issue.message}`);
    }
  }
  return out.length ? out.join('\n') : '    (none)';
}

const sampleXML = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');

// A deliberately broken diagram:
//   SE_1 -> T_1 -> EE_1   (valid chain)
//   SE_2                      (start with no outgoing)
//   T_2                       (floating task)
const brokenXML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P1" isExecutable="false">
    <bpmn:startEvent id="SE_1" name="s1"><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="T_1" name="t1"><bpmn:incoming>F1</bpmn:incoming><bpmn:outgoing>F2</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="EE_1" name="e1"><bpmn:incoming>F2</bpmn:incoming></bpmn:endEvent>
    <bpmn:startEvent id="SE_2" name="s2"/>
    <bpmn:task id="T_2" name="t2"/>
    <bpmn:sequenceFlow id="F1" sourceRef="SE_1" targetRef="T_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T_1" targetRef="EE_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="DIAG_1">
    <bpmndi:BPMNPlane id="PLANE_1" bpmnElement="P1">
      <bpmndi:BPMNShape id="SE_1_di" bpmnElement="SE_1"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="T_1_di" bpmnElement="T_1"><dc:Bounds x="200" y="80" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EE_1_di" bpmnElement="EE_1"><dc:Bounds x="360" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="SE_2_di" bpmnElement="SE_2"><dc:Bounds x="100" y="250" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="T_2_di" bpmnElement="T_2"><dc:Bounds x="250" y="230" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="F1_di" bpmnElement="F1"><di:waypoint x="136" y="118"/><di:waypoint x="200" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="F2_di" bpmnElement="F2"><di:waypoint x="300" y="118"/><di:waypoint x="360" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

// ============================================================
// Part 1: valid sample — false positives must be GONE
// ============================================================
console.log('\n========== 1. valid sample with backref fix ==========');
const m1 = makeModeler();
await m1.importXML(sampleXML);
await new Promise(r => setTimeout(r, 2000));
const issues1 = m1.get('linting')._issues;
console.log(printIssues(issues1));
check('valid sample: zero lint issues', Object.keys(issues1).length === 0,
  Object.keys(issues1).length ? `still: ${Object.keys(issues1).join(', ')}` : '(false positives eliminated)');

// backrefs actually populated now?
const se1bo = m1.get('elementRegistry').get('StartEvent_1').businessObject;
check('backrefs populated: StartEvent_1.outgoing === [Flow_1]',
  Array.isArray(se1bo.outgoing) && se1bo.outgoing.length === 1 && se1bo.outgoing[0].id === 'Flow_1');
m1.destroy();

// ============================================================
// Part 2: broken diagram — REAL problems must still be detected
// ============================================================
console.log('\n========== 2. broken diagram still detected ==========');
const m2 = makeModeler();
await m2.importXML(brokenXML);
await new Promise(r => setTimeout(r, 2000));
const issues2 = m2.get('linting')._issues;
console.log(printIssues(issues2));

const rules2 = {};
for (const id of Object.keys(issues2)) for (const i of issues2[id]) {
  (rules2[id] = rules2[id] || []).push(i.rule);
}
check('broken: SE_2 flagged (no-disconnected, no-implicit-end)',
  rules2['SE_2']?.includes('no-disconnected') && rules2['SE_2']?.includes('no-implicit-end'),
  `SE_2: ${(rules2['SE_2'] || []).join(', ')}`);
check('broken: T_2 flagged (no-disconnected, no-implicit-start, no-implicit-end)',
  rules2['T_2']?.includes('no-disconnected') && rules2['T_2']?.includes('no-implicit-start') && rules2['T_2']?.includes('no-implicit-end'),
  `T_2: ${(rules2['T_2'] || []).join(', ')}`);
check('broken: valid chain SE_1/T_1/EE_1 NOT flagged',
  !rules2['SE_1'] && !rules2['T_1'] && !rules2['EE_1'],
  [rules2['SE_1'], rules2['T_1'], rules2['EE_1']].filter(Boolean).join('; ') || 'clean');

// ============================================================
// Part 3: NEW diagnostic collection sequence (as in src/main.js)
// ============================================================
console.log('\n========== 3. new diagnostic collection ==========');
let diagIssues = null;
let diagSource = 'unknown';
try {
  const lintModule = m2.get('linting');
  diagIssues = (lintModule && lintModule._issues) || {};
  diagSource = 'last known state (completion event timed out)';

  const eventBus = m2.get('eventBus');
  const result = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 3000);
    eventBus.once('linting.completed', (ev) => {
      clearTimeout(timeout);
      resolve(ev);
    });
    if (typeof lintModule.update === 'function') {
      try { lintModule.update(); } catch { /* ignore */ }
    }
  });

  if (result && result.issues) {
    diagIssues = result.issues;
    diagSource = 'fresh lint pass';
  }
} catch (err) {
  diagSource = `FAILED: ${err.message}`;
}
console.log(`  collection: ${diagSource}`);
console.log(printIssues(diagIssues));
check('diagnostic: collection succeeded via eventBus.once (no modeler.once crash)',
  diagSource === 'fresh lint pass', diagSource);
check('diagnostic: issues captured with element detail',
  Object.keys(diagIssues || {}).length >= 2,
  `keys: ${Object.keys(diagIssues || {}).join(', ')}`);
const anyIssue = Object.values(diagIssues || {}).flat()[0];
check('diagnostic: category field present (was "severity" — always ?)',
  anyIssue && typeof anyIssue.category === 'string' && anyIssue.category.length > 0,
  anyIssue ? `category=${anyIssue.category}` : 'no issues');
m2.destroy();

// --- summary -------------------------------------------------------------------
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
