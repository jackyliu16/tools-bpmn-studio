/**
 * studio-check — 参数检查（B2 等价性/引用完整性检查，独立面板，不入 lint 打包管线）。
 *
 * 规则：
 *   R1  路由条件引用未声明变量 → warn
 *   R3  数值比较条件引用 string 类型变量 → warn（轻量启发式）
 *   R4  camunda:inputOutput 与 studio 参数不一致（漂移/缺失/外部编辑）→ error（可修复）
 *   R5  非活动元素携带 studio 参数（无执行落点）→ info
 *   R6  出参未被任何条件或下游入参消费 → warn
 *
 * runStudioChecks 为纯逻辑（吃一个抽象的“模型视图”），可 node 单测；
 * renderStudioCheck 为 DOM 渲染（main.js 调用）。
 */
import {
  camundaMatchesStudio,
  extractConditionIdentifiers,
  hasStudioParamsIn,
  getStudioParams,
  paramList,
  isStudioActivity,
  resolveScopeVariablesFor,
  ensureExtensionElements,
  buildCamundaSyncCommands
} from './studio-utils.js';

export const STUDIO_CHECK_RULES = ['R1', 'R3', 'R4', 'R5', 'R6'];

/**
 * 模型视图抽象：把 modeler 服务收敛成纯数据结构，便于单测。
 *
 * @typedef {Object} ModelView
 * @property {Array<{id: string, bo: Object, isConnection?: boolean, sourceBo?: Object|null, targetBo?: Object|null}>} elements
 */

/**
 * @param {ModelView} view
 * @returns {Array<{id: string, elementId: string, category: 'error'|'warn'|'info', rule: string, message: string}>}
 */
export function runStudioChecks(view) {
  const issues = [];
  const bos = view.elements.map((e) => e.bo);

  // 作用域目录（按 flow 所在 scope 惰性缓存）
  const scopeCache = new Map();
  const scopeFor = (flowBo) => {
    const key = flowBo && flowBo.$parent ? flowBo.$parent.id : 'root';
    if (!scopeCache.has(key)) {
      scopeCache.set(key, resolveScopeVariablesFor(flowBo, bos));
    }
    return scopeCache.get(key);
  };

  // 全局消费者：条件引用 ∪ 全部活动入参名（R6）
  const consumers = new Set();
  const conditionRefs = new Map(); // flowId → [identifiers]
  for (const el of view.elements) {
    if (!el.bo) continue;
    if (el.bo.$instanceOf && el.bo.$instanceOf('bpmn:SequenceFlow')) {
      const body = el.bo.get && el.bo.get('conditionExpression') && el.bo.get('conditionExpression').get('body');
      if (body) {
        const ids = extractConditionIdentifiers(body);
        conditionRefs.set(el.id, ids);
        ids.forEach((id) => consumers.add(id));
      }
    }
    if (el.bo.$instanceOf && el.bo.$instanceOf('bpmn:Activity')) {
      paramList(getStudioParams(el.bo), 'inputParameters').forEach((p) => p.name && consumers.add(p.name));
    }
  }

  // R1/R3 按 flow
  for (const [flowId, ids] of conditionRefs) {
    const flow = view.elements.find((e) => e.id === flowId);
    const flowBo = flow.bo;
    const directory = scopeFor(flowBo);
    const byName = new Map(directory.map((v) => [v.name, v]));
    for (const id of ids) {
      const declared = byName.get(id);
      if (!declared) {
        issues.push({
          id: `R1-${flowId}-${id}`,
          elementId: flowId,
          category: 'warn',
          rule: 'R1',
          message: `路由条件引用未声明变量「${id}」——可在上游节点「出参」中声明，或在「入参 / 出参」面板补全。`
        });
      } else if (declared.type === 'string' && /[<>]=?/.test(flowBo.get('conditionExpression').get('body') || '')) {
        issues.push({
          id: `R3-${flowId}-${id}`,
          elementId: flowId,
          category: 'warn',
          rule: 'R3',
          message: `变量「${id}」类型为 string，却被用于数值比较。`
        });
      }
    }
  }

  // R4/R5 按节点
  for (const el of view.elements) {
    if (!el.bo || !el.bo.$instanceOf) continue;
    if (isStudioActivity(el.bo)) {
      if (!camundaMatchesStudio(el.bo)) {
        issues.push({
          id: `R4-${el.id}`,
          elementId: el.id,
          category: 'error',
          rule: 'R4',
          message: 'Camunda 映射与「入参 / 出参」不一致（缺失、漂移或外部编辑）。点击修复重新生成。',
          fixable: true
        });
      }
    } else if (!el.isConnection && hasStudioParamsIn(el.bo)) {
      issues.push({
        id: `R5-${el.id}`,
        elementId: el.id,
        category: 'info',
        rule: 'R5',
        message: '该元素非活动类，参数仅有建模语义，Camunda 执行时无落点。'
      });
    }

    // R6：出参无消费
    if (isStudioActivity(el.bo)) {
      const outputs = paramList(getStudioParams(el.bo), 'outputParameters').filter((p) => p.name);
      for (const out of outputs) {
        if (!consumers.has(out.name)) {
          issues.push({
            id: `R6-${el.id}-${out.name}`,
            elementId: el.id,
            category: 'warn',
            rule: 'R6',
            message: `出参「${out.name}」未被任何条件或下游入参消费。`
          });
        }
      }
    }
  }

  return issues;
}

/** R4 修复：为该元素以当前 studio 参数重建 camunda:inputOutput（原子） */
export function regenerateCamundaMapping(modeler, elementId) {
  const element = modeler.get('elementRegistry').get(elementId);
  if (!element) return false;
  const bo = element.businessObject;
  if (!bo) return false;
  const params = getStudioParams(bo);
  const inputs = paramList(params, 'inputParameters');
  const outputs = paramList(params, 'outputParameters');
  const bpmnFactory = modeler.get('bpmnFactory');
  const { ee, commands } = ensureExtensionElements(element, bo, bpmnFactory);
  const sync = buildCamundaSyncCommands(element, bo, ee, bpmnFactory, inputs, outputs);
  if (!sync.length) return false;
  modeler.get('commandStack').execute('properties-panel.multi-command-executor', [...commands, ...sync]);
  return true;
}

/** 从 modeler 服务构造 ModelView（main.js 与 E2E 共用） */
export function modelViewFromModeler(modeler) {
  const elementRegistry = modeler.get('elementRegistry');
  return {
    elements: elementRegistry.getAll().map((el) => ({
      id: el.id,
      bo: el.businessObject,
      isConnection: !!el.waypoints,
      sourceBo: el.source && el.source.businessObject,
      targetBo: el.target && el.target.businessObject
    }))
  };
}