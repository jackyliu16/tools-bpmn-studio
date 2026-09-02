/**
 * Test: verify DI-label false-positive lint overlay patch.
 *
 * This script tests that the prototype-level patch on bpmn-js-bpmnlint's
 * Linting class correctly strips _label elements from lint results, so that:
 *   (a) this._issues never includes DI-label false-positives (button count)
 *   (b) _createIssues never receives DI-label element IDs (overlay icons)
 *
 * Usage: npx vite-node scripts/test-lint-patch.mjs
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- minimal DOM (same as smoke.mjs) ----------------------------------------
const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <div id="js-canvas"></div>
     <div id="js-properties-panel"></div>
   </body></html>`,
  { pretendToBeVisual: true, url: 'http://localhost/' }
);

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
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.File = window.File;

window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 20 });
window.SVGElement.prototype.getScreenCTM = () => null;
window.SVGElement.prototype.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
window.SVGElement.prototype.getComputedTextLength = () => 0;
const fakeSVGTransform = () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    matrix, type: 1,
    setTranslate(x, y) { matrix.e = x; matrix.f = y; },
    setScale(x, y) { matrix.a = x; matrix.d = y; },
    setRotate() {},
    setMatrix(m) { Object.assign(matrix, m); }
  };
};
window.SVGSVGElement.prototype.createSVGTransform = fakeSVGTransform;
window.SVGSVGElement.prototype.createSVGTransformFromMatrix = (matrix) =>
  ({ matrix, type: 1, setMatrix(m) { Object.assign(this.matrix, m); } });

const fakeTransformList = () => {
  const items = [];
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, multiply() { return matrix; } };
  return {
    numberOfItems: 0,
    clear() { items.length = 0; this.numberOfItems = 0; },
    appendItem(item) { items.push(item); this.numberOfItems = items.length; return item; },
    initialize(item) { return this.appendItem(item); },
    createSVGTransformFromMatrix(m) { return m; },
    consolidate() {
      return { matrix: items.length ? items[items.length - 1] : matrix, type: 1 };
    }
  };
};
Object.defineProperty(window.SVGElement.prototype, 'transform', {
  configurable: true,
  get() { return { baseVal: fakeTransformList(), animVal: fakeTransformList() }; }
});

globalThis.CSS = window.CSS || {};
globalThis.CSS.escape = cssEscape;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}
}));

window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    font: '',
    measureText: (text) => ({
      width: String(text).length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 4
    }),
    save() {}, restore() {}, fillText() {}, translate() {}, scale() {}, clearRect() {}
  };
};

// --- assertions --------------------------------------------------------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// --- Step 1: Apply the prototype patch (same as src/main.js lines 56-105) ---
const BpmnLintModule = (await import('bpmn-js-bpmnlint')).default;
const LintingClass = BpmnLintModule.linting[1];

check('LintingClass exists', typeof LintingClass === 'function');
check('LintingClass.prototype._formatIssues exists before patch', typeof LintingClass.prototype._formatIssues === 'function');
check('LintingClass.prototype._createIssues exists before patch', typeof LintingClass.prototype._createIssues === 'function');

// Save originals for comparison
const origFormatIssues = LintingClass.prototype._formatIssues;
const origCreateIssues = LintingClass.prototype._createIssues;

// Apply the patch (same as src/main.js)
{
  if (typeof LintingClass.prototype._formatIssues === 'function') {
    const _orig = LintingClass.prototype._formatIssues;
    LintingClass.prototype._formatIssues = function patchedFormatIssues(issues) {
      const result = _orig.call(this, issues);
      const filtered = {};
      for (const id in result) {
        if (typeof id !== 'string' || !id.endsWith('_label')) {
          filtered[id] = result[id];
        }
      }
      return filtered;
    };
  }
  if (typeof LintingClass.prototype._createIssues === 'function') {
    const _orig = LintingClass.prototype._createIssues;
    LintingClass.prototype._createIssues = function patchedCreateIssues(issues) {
      const filtered = {};
      for (const id in issues) {
        if (typeof id !== 'string' || !id.endsWith('_label')) {
          filtered[id] = issues[id];
        }
      }
      return _orig.call(this, filtered);
    };
  }
}

check('patch applied: _formatIssues replaced',
  LintingClass.prototype._formatIssues !== origFormatIssues);
check('patch applied: _createIssues replaced',
  LintingClass.prototype._createIssues !== origCreateIssues);

// --- Step 2: Create modeler + import the starter diagram ---------------------
const BpmnModeler = (await import('bpmn-js/lib/Modeler.js')).default;
const { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } = await import('bpmn-js-properties-panel');
const { default: MinimapModule } = await import('diagram-js-minimap');
const { default: BpmnColorPickerModule } = await import('bpmn-js-color-picker');
const { default: TokenSimulationModule } = await import('bpmn-js-token-simulation');
const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));
const plainXML = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');

const modeler = new BpmnModeler({
  container: '#js-canvas',
  propertiesPanel: { parent: '#js-properties-panel' },
  additionalModules: [
    BpmnPropertiesPanelModule,
    BpmnPropertiesProviderModule,
    MinimapModule,
    BpmnColorPickerModule,
    BpmnLintModule,
    TokenSimulationModule
  ],
  moddleExtensions: {},
  linting: { bpmnlint: lintConfig }
});

await modeler.importXML(plainXML);

// --- Step 3: Verify lint issues do NOT contain _label entries ----------------
const linting = modeler.get('linting');
const issues = linting._issues;

const labelIds = Object.keys(issues).filter(id => id.endsWith('_label'));
const nonLabelIds = Object.keys(issues).filter(id => !id.endsWith('_label'));

check('_issues has no _label entries',
  labelIds.length === 0,
  labelIds.length ? `found: ${labelIds.join(', ')}` : '(none — correct)');

check('_issues keys are real elements only',
  nonLabelIds.every(id => ['Process_1', 'StartEvent_1', 'Activity_1', 'EndEvent_1',
    'Flow_1', 'Flow_2'].includes(id)),
  `keys: ${nonLabelIds.join(', ')}`);

// --- Step 4: Verify the linting.completed event issues are clean -------------
const completedIssues = await new Promise(resolve => {
  // Trigger a re-lint by re-importing
  modeler.importXML(plainXML).then(() => {
    const eventBus = modeler.get('eventBus');
    eventBus.once('linting.completed', (ev) => resolve(ev.issues));
    modeler.get('canvas').resized();
    // fallback timeout
    setTimeout(() => resolve(null), 3000);
  });
});

if (completedIssues) {
  const completedLabelIds = Object.keys(completedIssues).filter(id => id.endsWith('_label'));
  check('linting.completed issues have no _label entries',
    completedLabelIds.length === 0,
    completedLabelIds.length ? `found: ${completedLabelIds.join(', ')}` : '(none — correct)');
} else {
  check('linting.completed fired within timeout', false, 'timeout');
}

// --- Step 5: Simulate _createIssues call to verify filtering ----------------
let capturedCreateIssuesArg = null;
const testLinting = modeler.get('linting');
const savedCreateIssues = testLinting._createIssues;

testLinting._createIssues = function captureArg(issues) {
  capturedCreateIssuesArg = issues;
  return savedCreateIssues.call(this, issues);
};

// Trigger update
testLinting.update();
await new Promise(r => setTimeout(r, 2000));

testLinting._createIssues = savedCreateIssues;

if (capturedCreateIssuesArg) {
  const overlayLabelIds = Object.keys(capturedCreateIssuesArg).filter(id => id.endsWith('_label'));
  check('_createIssues received no _label IDs',
    overlayLabelIds.length === 0,
    overlayLabelIds.length ? `found: ${overlayLabelIds.join(', ')}` : '(none — correct)');
} else {
  check('_createIssues was called', false, 'no capture');
}

// --- Summary ----------------------------------------------------------------
modeler.destroy();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
