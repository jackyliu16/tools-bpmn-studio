/**
 * cleanup-default — 默认流引用完整性清理（管理逻辑）。
 *
 * BPMN 中 `gateway.default` 是对 sequenceFlow 的 moddle 引用；删除一条出线后
 * moddle 不会自动清除该引用，遗留悬空的 default 会让 lint 规则
 * （conditional-flows / camunda/forking-conditions）持续误报
 * 「Sequence flow is missing condition」，并产生非法模型。
 *
 * 本模块在 import 完成后与结构变更（elements.changed，与既有
 * rebuildFlowNodeBackrefs 同一节流）之后扫描元素注册表，
 * 对「default 指向已不存在出线」的网关执行 modeling.updateProperties 清空。
 *
 * 只处理注册表中可见的网关（塌缩子流程内不可见元素天然豁免）：
 * 若网关自己不可见，则根本不会对其执行更新；出线与网关同处一个 plane，
 * 因此「网关可见但出线丢失」即真实悬空。
 */

/** 允许携带默认流的网关类型（与 default-flow-provider.js 保持一致） */
const DEFAULT_FLOW_GATEWAY_TYPES = [
  'bpmn:ExclusiveGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ComplexGateway'
];

/**
 * 清理全部悬空默认流引用。
 *
 * @param {import('bpmn-js/lib/Modeler').default} modeler 当前 BPMN modeler
 * @returns {number} 清理的悬空引用数（便于测试断言）
 */
export function cleanupDanglingDefaultFlows(modeler) {
  if (!modeler) return 0;

  const elementRegistry = modeler.get('elementRegistry');
  const modeling = modeler.get('modeling');

  if (!elementRegistry || !modeling) return 0;

  let cleaned = 0;

  for (const element of elementRegistry.getAll()) {
    const bo = element.businessObject;
    if (!bo || !DEFAULT_FLOW_GATEWAY_TYPES.includes(bo.$type)) continue;
    if (!bo.default) continue;

    const defaultFlowId = bo.default.id;
    if (elementRegistry.get(defaultFlowId)) continue;

    // 悬空引用：清空，走命令栈（可 undo）。
    try {
      modeling.updateProperties(element, { default: undefined });
      cleaned++;
    } catch (err) {
      // 清理失败不阻塞建模；日志留给诊断通道
      console.warn('[control] 清理悬空默认流失败:', element.id, err);
    }
  }

  return cleaned;
}