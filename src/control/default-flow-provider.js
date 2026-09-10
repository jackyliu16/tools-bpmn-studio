/**
 * default-flow-provider — 「网关默认流」控制要素。
 *
 * 官方 bpmn-js-properties-panel 5.65 的 Camunda Platform provider 没有默认流
 * 编辑入口（只有渲染图标与条件设置时的隐式清除），而排他/包容网关分叉时
 * 「设一条默认流出线」是 camunda/forking-conditions 等 lint 规则的标准解法。
 * 本 provider 在任意平台（bpmn / camunda-7 / camunda-8）为网关补充该字段：
 *
 *   - 读：gateway businessObject.default
 *   - 写：modeling.updateProperties(gateway, { default: flowBo }) —— 走命令栈，
 *     undo/redo 与 dirty ★（stackIdx baseline）自动生效
 *
 * 写入真实 BPMN `default` 属性（camunda 命名空间方案），因此 lint 规则
 * （conditional-flows / camunda/forking-conditions 的 isDefaultFlow 判定）
 * 与 Camunda 引擎语义直接联动，而非自定义扩展属性。
 *
 * 渲染复用 @bpmn-io/properties-panel 官方 SelectEntry，与面板其他条目同源。
 */
import { SelectEntry } from '@bpmn-io/properties-panel';
import { isAny } from 'bpmn-js/lib/util/ModelUtil';

/** 允许携带默认流的网关类型 */
const DEFAULT_FLOW_GATEWAYS = ['bpmn:ExclusiveGateway', 'bpmn:InclusiveGateway', 'bpmn:ComplexGateway'];

/**
 * Properties provider 类：构造时注册到属性面板。
 *
 * @param {import('bpmn-js-properties-panel').PropertiesPanel} propertiesPanel
 * @param {import('diagram-js/lib/features/modeling/Modeling').default} modeling
 */
export default function DefaultFlowProvider(propertiesPanel, modeling) {
  this._modeling = modeling;
  propertiesPanel.registerProvider(750, this);
}

DefaultFlowProvider.$inject = ['propertiesPanel', 'modeling'];

/**
 * 在「通用」等官方组之后、Camunda 平台组之前插入「网关默认流」分组。
 *
 * 注册优先级 750：核心 provider 注册于 DEFAULT_PRIORITY(1000)，Camunda/Zeebe
 * 注册于 LOW_PRIORITY(500)。事件总线按优先级从高到低触发，因此本 transformer
 * 在核心组之后、平台组之前执行，分组顺序为：通用 → 说明文档 → 网关默认流 → 实现…
 */
DefaultFlowProvider.prototype.getGroups = function (element) {
  const modeling = this._modeling;
  return function (groups) {
    if (!isAny(element, DEFAULT_FLOW_GATEWAYS)) {
      return groups;
    }

    const outgoing = element.outgoing || [];
    if (!outgoing.length) {
      return groups;
    }

    groups.push({
      id: 'ControlPanel__GatewayDefaultFlow',
      label: '网关默认流',
      entries: [DefaultFlowEntry({ element, modeling })]
    });

    return groups;
  };
};

/**
 * 「默认出线」下拉：outgoing 中选一条作为默认流，或清空。
 */
function DefaultFlowEntry({ element, modeling }) {
  return {
    id: 'gatewayDefaultFlow',
    element,
    component(props) {
      return SelectEntry({
        ...props,
        id: 'gatewayDefaultFlow',
        element,
        label: '默认出线（所有条件不满足时走此分支）',
        getValue: () => {
          const bo = element.businessObject;
          return bo.default ? bo.default.id : '';
        },
        setValue: (flowId) => {
          const flow = flowId && element.outgoing.find((f) => f.id === flowId);
          modeling.updateProperties(element, {
            default: flow ? flow.businessObject : undefined
          });
        },
        getOptions: () => {
          const seen = new Set();
          return (element.outgoing || [])
            .filter((f) => {
              if (seen.has(f.id)) return false;
              seen.add(f.id);
              return true;
            })
            .map((f) => ({
              value: f.id,
              label: (f.businessObject && f.businessObject.name) || f.id
            }));
        }
      });
    },
    isEdited: () => !!element.businessObject.default
  };
}