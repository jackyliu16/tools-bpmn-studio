/**
 * Quick verification: ensure the prototype patch actually prevents
 * _label entries from appearing in _issues after a full lint cycle.
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 仓库根（本脚本位于 scripts/verify/ 下，向上三级）
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// --- DOM shims (abbreviated) ---
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
  const m = { a:1,b:0,c:0,d:1,e:0,f:0 };
  return { matrix: m, type: 1, setTranslate(x,y){m.e=x;m.f=y}, setScale(x,y){m.a=x;m.d=y}, setRotate(){}, setMatrix(o){Object.assign(m,o)} };
};
window.SVGSVGElement.prototype.createSVGTransformFromMatrix = (matrix) => ({ matrix, type:1, setMatrix(m){Object.assign(this.matrix,m)} });
Object.defineProperty(window.SVGElement.prototype, 'transform', {
  configurable: true,
  get() { return { baseVal: { numberOfItems:0, clear(){}, appendItem(i){return i}, initialize(i){return i}, createSVGTransformFromMatrix(m){return m}, consolidate(){return {matrix:{a:1,b:0,c:0,d:1,e:0,f:0},type:1}} }, animVal: {} }; }
});
globalThis.CSS = window.CSS || {}; globalThis.CSS.escape = cssEscape;
globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} takeRecords(){return []} };
window.matchMedia = window.matchMedia || (() => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
window.HTMLCanvasElement.prototype.getContext = () => ({
  font:'', measureText:(t)=>({width:String(t).length*7,actualBoundingBoxAscent:8,actualBoundingBoxDescent:4}),
  save(){}, restore(){}, fillText(){}, translate(){}, scale(){}, clearRect(){}
});

// --- Apply the SAME prototype patch as src/main.js ---
const BpmnLintModule = (await import('bpmn-js-bpmnlint')).default;
const LintingClass = BpmnLintModule.linting[1];

{
  const origFormat = LintingClass.prototype._formatIssues;
  if (typeof origFormat === 'function') {
    LintingClass.prototype._formatIssues = function patched(issues) {
      const r = origFormat.call(this, issues);
      const f = {};
      for (const id in r) { if (typeof id !== 'string' || !id.endsWith('_label')) f[id] = r[id]; }
      return f;
    };
  }
  const origCreate = LintingClass.prototype._createIssues;
  if (typeof origCreate === 'function') {
    LintingClass.prototype._createIssues = function patched(issues) {
      const f = {};
      for (const id in issues) { if (typeof id !== 'string' || !id.endsWith('_label')) f[id] = issues[id]; }
      return origCreate.call(this, f);
    };
  }
}

// --- Create modeler + import ---
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
    BpmnPropertiesPanelModule, BpmnPropertiesProviderModule,
    MinimapModule, BpmnColorPickerModule, BpmnLintModule, TokenSimulationModule
  ],
  moddleExtensions: {},
  linting: { bpmnlint: lintConfig }
});

await modeler.importXML(plainXML);

// Wait for async lint cycle to settle
await new Promise(r => setTimeout(r, 3000));

const linting = modeler.get('linting');
const issueKeys = Object.keys(linting._issues);
const labelKeys = issueKeys.filter(k => k.endsWith('_label'));

console.log('=== Lint Patch Verification ===');
console.log('Total _issues keys:', issueKeys.length);
console.log('All keys:', issueKeys.join(', '));
console.log('Label keys (should be 0):', labelKeys.length, labelKeys.length ? labelKeys : '');
console.log('');
console.log(issueKeys.length === 0 || labelKeys.length === 0
  ? '✅ PASS: No DI-label false-positives in _issues'
  : '❌ FAIL: _issues contains DI-label entries');

// Also check via linting.completed event
const eventIssues = await new Promise(resolve => {
  const eb = modeler.get('eventBus');
  eb.once('linting.completed', ev => resolve(ev.issues));
  modeler.get('canvas').resized();
  setTimeout(() => resolve(null), 3000);
});

if (eventIssues) {
  const evtLabelKeys = Object.keys(eventIssues).filter(k => k.endsWith('_label'));
  console.log('');
  console.log('linting.completed total keys:', Object.keys(eventIssues).length);
  console.log('linting.completed label keys:', evtLabelKeys.length);
  console.log(evtLabelKeys.length === 0
    ? '✅ PASS: linting.completed has no DI-label entries'
    : '❌ FAIL: linting.completed contains DI-label entries');
}

modeler.destroy();
process.exit(labelKeys.length > 0 ? 1 : 0);
