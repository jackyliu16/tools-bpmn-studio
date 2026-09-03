/**
 * Repro: what does the diagnostics function actually observe?
 *
 * 1. Boot a modeler EXACTLY like src/main.js (prototype patch applied).
 * 2. Import resources/newDiagram.bpmn (the "示例程序" default diagram).
 * 3. Inspect raw lint state (with patch) — what overlays does the user see?
 * 4. Re-run WITHOUT the patch to see the raw false positives.
 * 5. Replay the diagnostic's exact collection sequence (saveXML → importXML →
 *    once('linting.completed') after await → canvas.resized() → 2s timeout)
 *    and print what the diagnostics would report.
 *
 * Usage: npx vite-node scripts/repro-diagnostic.mjs
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 仓库根（本脚本位于 scripts/verify/ 下，向上三级）
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

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

const BpmnLintModule = (await import('bpmn-js-bpmnlint')).default;
const BpmnModeler = (await import('bpmn-js/lib/Modeler.js')).default;
const { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } = await import('bpmn-js-properties-panel');
const { default: MinimapModule } = await import('diagram-js-minimap');
const { default: BpmnColorPickerModule } = await import('bpmn-js-color-picker');
const { default: TokenSimulationModule } = await import('bpmn-js-token-simulation');
const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));
const plainXML = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');

function applyPatch() {
  const LintingClass = BpmnLintModule.linting[1];
  const ok = typeof LintingClass === 'function' && LintingClass.prototype;
  if (!ok) { console.log('!! patch NOT applied — LintingClass missing'); return false; }
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
  return true;
}

function makeModeler() {
  const modeler = new BpmnModeler({
    container: '#js-canvas',
    propertiesPanel: { parent: '#js-properties-panel' },
    additionalModules: [
      BpmnPropertiesPanelModule, BpmnPropertiesProviderModule,
      MinimapModule, BpmnColorPickerModule, BpmnLintModule, TokenSimulationModule
    ],
    moddleExtensions: {},
    linting: { bpmnlint: lintConfig }
  });
  return modeler;
}

function describeIssues(issues) {
  const out = [];
  for (const id of Object.keys(issues || {})) {
    for (const issue of issues[id] || []) {
      out.push(`  ${id} [${issue.severity}] ${issue.rule}: ${issue.message}`);
    }
  }
  return out;
}

// ============================================================
// Part A: modeler WITH the prototype patch (like the app)
// ============================================================
console.log('\n========== A. WITH patch (as in the app) ==========');
const patchOk = applyPatch();
console.log('patch applied:', patchOk);
const mA = makeModeler();
const completedEventsA = [];
mA.on('linting.completed', (ev) => completedEventsA.push(Object.keys(ev.issues || {}).length));
await mA.importXML(plainXML);
await new Promise(r => setTimeout(r, 2500));

const lintA = mA.get('linting');
console.log('A: _issues keys:', Object.keys(lintA._issues).length ? Object.keys(lintA._issues).join(', ') : '(none)');
for (const line of describeIssues(lintA._issues)) console.log(line);
console.log('A: linting.completed events seen so far:', JSON.stringify(completedEventsA));

// How many overlays exist on the canvas right now? (what the user SEES)
const overlaysA = mA.get('overlays');
let overlayCount = 0;
for (const el of mA.get('elementRegistry').getAll()) {
  const ov = overlaysA.get(el.id);
  if (ov && ov.length) { overlayCount += ov.length; console.log(`A: overlay on ${el.id}:`, ov.map(o => o.type).join(',')); }
}
console.log('A: total overlays visible:', overlayCount);

// ------------------------------------------------------------
// Replay the EXACT diagnostic collection sequence
// ------------------------------------------------------------
console.log('\n--- Replay of diagnostic collection (with patch) ---');
let diagRaw = 'PENDING';
try {
  const { xml } = await mA.saveXML({ format: true });
  const { warnings } = await mA.importXML(xml);
  console.log('diagnostic: re-import warnings:', warnings.length ? warnings.map(w => w.message) : '(none)');

  diagRaw = await new Promise(resolve => {
    const t0 = Date.now();
    const timeout = setTimeout(() => resolve(null), 2000);
    mA.once('linting.completed', (ev) => {
      clearTimeout(timeout);
      console.log(`diagnostic: linting.completed fired after ${Date.now() - t0}ms, keys=${Object.keys(ev.issues || {}).length}`);
      resolve(ev.issues);
    });
    try {
      mA.get('canvas').resized();
    } catch (e) {
      console.log('diagnostic: canvas.resized() threw:', e.message);
    }
  });
} catch (err) {
  diagRaw = `ERROR: ${err.message}`;
  console.log('diagnostic: outer catch:', err.stack);
}
if (diagRaw === null) {
  console.log('diagnostic: TIMED OUT — would print "Lint Issues: none ✓" (FALSE NEGATIVE)');
} else if (diagRaw === 'PENDING') {
  console.log('diagnostic: (never reached)');
} else if (Object.keys(diagRaw).length === 0) {
  console.log('diagnostic: empty issues — would print "Lint Issues: none ✓"');
} else {
  console.log('diagnostic: issues captured:');
  for (const line of describeIssues(diagRaw)) console.log(line);
}
mA.destroy();

// ============================================================
// Part B: raw bpmnlint output on the same model (no patching),
// to see whether DI-label elements also produce raw issues.
// ============================================================
console.log('\n========== B. RAW bpmnlint output (no patch) ==========');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const LinterCjs = require('bpmnlint/lib/linter.js');
const { BpmnModdle } = await import('bpmn-moddle');
const { Reader: ModdleXmlReader } = await import('moddle-xml');
const model = new BpmnModdle();
const { rootElement } = await new ModdleXmlReader(model).fromXML(plainXML, 'bpmn:Definitions');
const linter = new LinterCjs({ resolver: lintConfig.resolver, config: lintConfig.config });
const results = await linter.lint(rootElement);
let n = 0;
for (const [rule, reports] of Object.entries(results)) {
  for (const r of reports) { n++; console.log(`B: raw  ${r.id || '(root)'} [${rule}]: ${r.message}`); }
}
if (!n) console.log('B: no raw issues');
