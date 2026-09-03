/**
 * dmn-studio — DMN editor module.
 *
 * Wraps dmn-js Modeler for editing DMN 1.3 / 1.4 decision models.
 * Provides the same lifecycle interface as the BPMN modeler
 * (importXML / saveXML / saveSVG / destroy) so main.js can drive
 * both editors through a common protocol.
 */

// --- styles ---------------------------------------------------------------
import 'dmn-js/dist/assets/diagram-js.css';
import 'dmn-js/dist/assets/dmn-font/css/dmn-embedded.css';
import 'dmn-js/dist/assets/dmn-js-shared.css';
import 'dmn-js/dist/assets/dmn-js-drd.css';
import 'dmn-js/dist/assets/dmn-js-decision-table.css';
import 'dmn-js/dist/assets/dmn-js-decision-table-controls.css';
import 'dmn-js/dist/assets/dmn-js-literal-expression.css';
import 'dmn-js/dist/assets/dmn-js-boxed-expression.css';
import 'dmn-js/dist/assets/dmn-js-boxed-expression-controls.css';

// --- libraries ------------------------------------------------------------
import DmnModeler from 'dmn-js/lib/Modeler';

/**
 * Create a DMN modeler instance attached to the given container.
 *
 * @param {string|HTMLElement} container  CSS selector or DOM node
 * @param {Object}  [options]  Extra dmn-js options (moddleExtensions, etc.)
 * @returns {DmnModeler}
 */
export function createDmnModeler(container, options = {}) {
  const modeler = new DmnModeler({
    container,
    ...options
  });

  return modeler;
}

/**
 * Default DMN XML template (empty DRD with one decision).
 *
 * 使用 dmn-moddle 声明的标准 DMNDI 命名空间（https://www.omg.org/spec/DMN/20191111/DMNDI/，
 * 前缀 dmndi，结构 DMNDI > DMNDiagram > DMNShape）。注意：不要使用 "https://www.omg.org/spec/
 * DMN/20191111/DI/" —— 该命名空间不在 dmn-moddle 描述符中，导入会产生
 * "unrecognized element <ns0:DMNDI>" 警告并丢失图形（DRD 会退回决策表视图）。
 * dc 命名空间同样必须用描述符中的 http://www.omg.org/spec/DMN/20180521/DC/。
 */
export const EMPTY_DMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"
             xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/"
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
  <dmndi:DMNDI>
    <dmndi:DMNDiagram>
      <dmndi:DMNShape id="Decision_1_di" dmnElementRef="Decision_1">
        <dc:Bounds x="160" y="100" width="180" height="80" />
        <dmndi:DMNLabel />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>`;

export default DmnModeler;
