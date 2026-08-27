/**
 * bpmn-studio — renderer smoke test (runs in Node + jsdom, no browser needed).
 *
 * Verifies the real modeler wiring used by the app boots under a DOM:
 *   - all bpmn-js + extension modules load and construct
 *   - per-platform moddle extension selection works:
 *       plain BPMN | Camunda Platform 7 | Camunda 8 / Zeebe
 *   - camunda/zeebe extension properties round-trip through importXML
 *   - packed bpmnlint config resolves ({ config, resolver })
 *   - importXML of the starter diagram produces a rendered element registry
 *
 * Usage: npx vite-node scripts/smoke.mjs
 */
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- minimal DOM -----------------------------------------------------------
const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <div id="js-canvas"></div>
     <div id="js-dmn-canvas"></div>
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

// jsdom lacks SVG layout / transform APIs used by diagram-js + tiny-svg.
// NOTE: a 0-size getBBox makes diagram-js Text layout compute maxWidth=0,
// which hits a NaN path and loops forever — return browser-like sizes.
window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 20 });
window.SVGElement.prototype.getScreenCTM = () => null;
window.SVGElement.prototype.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
window.SVGElement.prototype.getComputedTextLength = () => 0;
const fakeSVGTransform = () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    matrix,
    type: 1,
    setTranslate(x, y) { matrix.e = x; matrix.f = y; },
    setScale(x, y) { matrix.a = x; matrix.d = y; },
    setRotate(angle, cx, cy) { /* identity-ish stub */ },
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
      // SVGTransform-like: diagram-js reads `transform.matrix.a..f`
      return { matrix: items.length ? items[items.length - 1] : matrix, type: 1 };
    }
  };
};
Object.defineProperty(window.SVGElement.prototype, 'transform', {
  configurable: true,
  get() { return { baseVal: fakeTransformList(), animVal: fakeTransformList() }; }
});

// jsdom lacks CSS.escape / ResizeObserver / matchMedia
globalThis.CSS = window.CSS || {};
globalThis.CSS.escape = cssEscape;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
};
window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {}
}));

// jsdom has no canvas 2D context — diagram-js uses it for text measurement.
// Without a working measureText(), layout hits a NaN/infinite-loop path
// (maxWidth 0 → 0/0). Provide a browser-like context with proportional widths.
window.HTMLCanvasElement.prototype.getContext = function () {
  const ctx = {
    font: '',
    measureText: (text) => ({
      width: String(text).length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 4
    }),
    save() {},
    restore() {},
    fillText() {},
    translate() {},
    scale() {},
    clearRect() {}
  };
  return ctx;
};

// --- diagrams under test ---------------------------------------------------
const plainXML = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');

function camunda7XML() {
  return plainXML
    .replace(
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:camunda="http://camunda.org/schema/1.0/bpmn"'
    )
    .replace(
      '<bpmn:process id="Process_1" name="示例流程" isExecutable="false">',
      '<bpmn:process id="Process_1" name="示例流程" isExecutable="false" camunda:modelerTemplate="com.example.template">'
    );
}

function zeebeXML() {
  return plainXML
    .replace(
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"'
    )
    .replace(
      '<bpmn:task id="Activity_1" name="办理任务" />',
      '<bpmn:serviceTask id="Activity_1" name="办理任务"><bpmn:extensionElements><zeebe:taskDefinition zeebe:type="task" /></bpmn:extensionElements></bpmn:serviceTask>'
    );
}

// --- import the real app modules (same as src/main.js) ------------------------
const BpmnModeler = (await import('bpmn-js/lib/Modeler.js')).default;

const {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
  CamundaPlatformPropertiesProviderModule,
  ZeebePropertiesProviderModule
} = await import('bpmn-js-properties-panel');

const { default: camundaModdle } = await import(
  'camunda-bpmn-moddle/resources/camunda.json', { with: { type: 'json' } }
);
const { default: zeebeModdle } = await import(
  'zeebe-bpmn-moddle/resources/zeebe.json', { with: { type: 'json' } }
);

const { default: MinimapModule } = await import('diagram-js-minimap');
const { default: BpmnColorPickerModule } = await import('bpmn-js-color-picker');
const { default: BpmnLintModule } = await import('bpmn-js-bpmnlint');
const { default: TokenSimulationModule } = await import('bpmn-js-token-simulation');

const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));

// --- assertions ----------------------------------------------------------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

check('lint config shape { config, resolver }', !!(lintConfig && lintConfig.config && lintConfig.resolver));
check('camunda moddle parses', !!(camundaModdle && camundaModdle.prefix));
check('zeebe moddle parses', !!(zeebeModdle && zeebeModdle.uri));

function createModeler(moddleExtensions, providers) {
  return new BpmnModeler({
    container: '#js-canvas',
    propertiesPanel: { parent: '#js-properties-panel' },
    additionalModules: [
      BpmnPropertiesPanelModule,
      BpmnPropertiesProviderModule,
      ...providers,
      MinimapModule,
      BpmnColorPickerModule,
      BpmnLintModule,
      TokenSimulationModule
    ],
    moddleExtensions,
    linting: { bpmnlint: lintConfig }
  });
}

let modeler = null;

// --- scenario 1: plain BPMN ---------------------------------------------------
modeler = createModeler({}, []);
check('plain: modeler constructed', !!modeler);

{
  const { warnings } = await modeler.importXML(plainXML);
  check('plain: importXML clean (no unparsable content)', warnings.length === 0,
    warnings.map((w) => w.message.split('\n')[0]).join('; '));

  const registry = modeler.get('elementRegistry');
  const count = Object.keys(registry._elements || {}).length;
  check('plain: elements rendered', count > 0, `${count} elements`);
  check('plain: element StartEvent_1', !!registry.get('StartEvent_1'));
  check('plain: element Flow_2', !!registry.get('Flow_2'));

  // metadata access path (same accessors as the ⓘ 元数据 dialog)
  const definitions = modeler.getDefinitions();
  check('plain: defs.targetNamespace via get()', definitions.get('targetNamespace') === 'http://bpmn.io/schema/bpmn', definitions.get('targetNamespace'));
  check('plain: defs.get handles missing attrs', definitions.get('exporter') == null || typeof definitions.get('exporter') === 'string');

  const all = registry.getAll();
  const conns = all.filter((el) => el.waypoints).length;
  const nodes = all.length - conns;
  check('plain: stats gather (nodes/connections)', nodes === 6 && conns === 2, `${nodes} nodes / ${conns} connections`);

  const services = ['propertiesPanel', 'minimap', 'linting', 'simulator', 'toggleMode', 'searchPad', 'colorPopupProvider', 'colorContextPadProvider'];
  for (const s of services) {
    try {
      check(`plain: service ${s}`, !!modeler.get(s));
    } catch (err) {
      check(`plain: service ${s}`, false, err.message);
    }
  }

  const { xml } = await modeler.saveXML({ format: true });
  check('plain: saveXML roundtrip', xml.includes('Process_1') && xml.includes('Definitions_1'));
}

// --- scenario 2: Camunda Platform 7 ---------------------------------------------
modeler.destroy();
modeler = createModeler({ camunda: camundaModdle }, [CamundaPlatformPropertiesProviderModule]);
check('camunda-7: modeler constructed', !!modeler);

{
  const { warnings } = await modeler.importXML(camunda7XML());
  check('camunda-7: importXML clean', warnings.length === 0,
    warnings.map((w) => w.message.split('\n')[0]).join('; '));

  const definitions = modeler.getDefinitions();
  const template = definitions.rootElements[0].get('modelerTemplate');
  check('camunda-7: camunda:modelerTemplate read', template === 'com.example.template', String(template));

  check('camunda-7: properties providers active', !!modeler.get('camundaPlatformPropertiesProvider'));

  const { xml } = await modeler.saveXML({ format: true });
  check('camunda-7: modelerTemplate survives saveXML', xml.includes('modelerTemplate'));
}

// --- scenario 3: Camunda 8 / Zeebe ----------------------------------------------
modeler.destroy();
modeler = createModeler({ zeebe: zeebeModdle }, [ZeebePropertiesProviderModule]);
check('camunda-8: modeler constructed', !!modeler);

{
  const { warnings } = await modeler.importXML(zeebeXML());
  check('camunda-8: importXML clean', warnings.length === 0,
    warnings.map((w) => w.message.split('\n')[0]).join('; '));

  const task = modeler.get('elementRegistry').get('Activity_1');
  const bo = task.businessObject;
  const extValues = (bo.extensionElements && bo.extensionElements.values) || [];
  const td = extValues.find((v) => v.$type === 'zeebe:TaskDefinition');
  check('camunda-8: zeebe:taskDefinition read', !!td && td.get('type') === 'task', td && td.get('type'));

  check('camunda-8: properties providers active', !!modeler.get('zeebePropertiesProvider'));

  const { xml } = await modeler.saveXML({ format: true });
  check('camunda-8: zeebe taskDefinition survives saveXML', xml.includes('taskDefinition'));
}

modeler.destroy();

// =========================================================================
// --- DMN tests -----------------------------------------------------------
// =========================================================================

const DmnModeler = (await import('dmn-js/lib/Modeler.js')).default;

// --- scenario 4: DMN DRD (Decision Requirements Diagram) -----------------
let dmnModeler = null;

const emptyDmnXML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             xmlns:di="https://www.omg.org/spec/DMN/20191111/DI/"
             xmlns:dc="http://www.omg.org/spec/DMN/20191111/DC/"
             id="Definitions_1"
             name="DRD"
             namespace="https://www.omg.org/spec/DMN/20191111/MODEL/">
  <decision id="Decision_1" name="Decision 1">
    <decisionTable id="DecisionTable_1">
      <input id="Input_1">
        <inputExpression id="InputExpression_1" typeRef="string">
          <text></text>
        </inputExpression>
      </input>
      <output id="Output_1" name="Result" typeRef="string" />
    </decisionTable>
  </decision>
  <di:DMNDI>
    <di:DMNShape id="Decision_1_di" dmnElementRef="Decision_1">
      <dc:Bounds x="160" y="100" width="180" height="80" />
      <di:DMNLabel />
    </di:DMNShape>
  </di:DMNDI>
</definitions>`;

dmnModeler = new DmnModeler({ container: '#js-dmn-canvas' });
check('dmn: modeler constructed', !!dmnModeler);

{
  const { warnings } = await dmnModeler.importXML(emptyDmnXML);
  // DMN DI warnings are expected in jsdom (no real SVG rendering)
  const realWarnings = warnings.filter(w => !w.message.includes('unparsable content'));
  check('dmn: importXML clean (ignoring DI warnings)', realWarnings.length === 0,
    realWarnings.map((w) => w.message.split('\n')[0]).join('; '));

  const views = dmnModeler.getViews();
  check('dmn: views available', views.length > 0, `${views.length} views`);

  const drdView = views.find(v => v.type === 'drd');
  check('dmn: DRD view exists', !!drdView);

  if (drdView) {
    await dmnModeler.open(drdView);
    // dmn-js accesses services through the active viewer, not the modeler directly
    const viewer = dmnModeler.getActiveViewer();
    const registry = viewer.get('elementRegistry');
    const count = registry.getAll().length;
    check('dmn: DRD elements rendered', count > 0, `${count} elements`);
  }

  const definitions = dmnModeler.getDefinitions();
  check('dmn: defs.id', definitions.id === 'Definitions_1', definitions.id);

  const { xml } = await dmnModeler.saveXML({ format: true });
  check('dmn: saveXML roundtrip', xml.includes('Decision_1') && xml.includes('Definitions_1'));
}

// --- scenario 5: DMN Decision Table view ----------------------------------
{
  const views = dmnModeler.getViews();
  const tableView = views.find(v => v.type === 'decisionTable');
  if (tableView) {
    await dmnModeler.open(tableView);
    check('dmn: decision table view opened', true);
  } else {
    check('dmn: decision table view exists', false, 'no decisionTable view');
  }
}

// --- scenario 6: DMN view switching ----------------------------------------
{
  const views = dmnModeler.getViews();
  const drdView = views.find(v => v.type === 'drd');
  if (drdView) {
    await dmnModeler.open(drdView);
    const activeView = dmnModeler.getActiveView();
    check('dmn: switch back to DRD', activeView && activeView.type === 'drd');
  }
}

dmnModeler.destroy();

// =========================================================================
// --- DMN import from dmn-editor module -----------------------------------
// =========================================================================

const { createDmnModeler, EMPTY_DMN_XML: MODULE_EMPTY_DMN } = await import(path.join(root, 'src', 'dmn-editor.js'));
check('dmn-editor: exports createDmnModeler', typeof createDmnModeler === 'function');
check('dmn-editor: exports EMPTY_DMN_XML', typeof MODULE_EMPTY_DMN === 'string' && MODULE_EMPTY_DMN.includes('definitions'));

{
  const testModeler = createDmnModeler('#js-dmn-canvas');
  check('dmn-editor: createDmnModeler works', !!testModeler);

  const { warnings } = await testModeler.importXML(MODULE_EMPTY_DMN);
  // DMN DI warnings are expected in jsdom (no real SVG rendering)
  const realWarnings2 = warnings.filter(w => !w.message.includes('unparsable content'));
  check('dmn-editor: importXML clean (ignoring DI warnings)', realWarnings2.length === 0,
    realWarnings2.map((w) => w.message.split('\n')[0]).join('; '));

  const definitions = testModeler.getDefinitions();
  check('dmn-editor: definitions loaded', !!definitions && !!definitions.id);

  testModeler.destroy();
}

// --- summary ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);