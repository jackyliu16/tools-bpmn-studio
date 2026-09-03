/**
 * lint-l10n — 校验规则与元素的本地化（中文）文案。
 *
 * 纯逻辑、无 DOM 依赖，可被 plain-node 脚本直接 import 做完备性测试。
 *
 * bpmnlint 汇报的问题对象携带 `rule`（英文规则名）与 `message`（英文原文，
 * 可能含参数），本模块只提供「中文规则名 + 修复建议」层，原文原样保留展示，
 * 以避免库内消息升级时翻译错位。
 *
 * 未知规则一律走兜底文案（原始规则名 + 通用建议），绝不抛错。
 */

// bpmnlint 官方规则文档基址
const BPMNLINT_DOCS_BASE = 'https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules';
// camunda 插件规则（插件仓库未按规则拆分文档，指向 rules 目录）
const CAMUNDA_RULES_BASE = 'https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules';

/**
 * 全部规则的中文名与修复建议。
 *
 * 覆盖本仓库打包 config（src/lint-config.js）中 bundled 的全部规则名，
 * 见 scripts/check-error-details.mjs 的完备性断言（新规则上线会在此暴露缺口）。
 */
export const RULE_LABELS = {
  // ── bpmnlint:recommended ──
  'ad-hoc-sub-process': {
    name: '临时子流程包含开始/结束事件',
    suggestion: 'Ad Hoc 子流程内不允许放置开始事件与结束事件，请移除或改用普通子流程。'
  },
  'conditional-flows': {
    name: '条件分支出线缺少条件',
    suggestion: '分叉元素（含条件出线的网关/活动）的每条出线要么是默认流，要么在属性面板中为其添加条件表达式。'
  },
  'end-event-required': {
    name: '缺少结束事件',
    suggestion: '每个流程/子流程都应有一个结束事件来终止实例，请补充一个 End Event。'
  },
  'event-based-gateway': {
    name: '事件网关出线数或条件不合规',
    suggestion: '事件网关必须至少 2 条出线，且出线不得携带条件表达式。'
  },
  'event-sub-process-typed-start-event': {
    name: '事件子流程的开始事件缺少事件定义',
    suggestion: '事件子流程（triggeredByEvent）中的开始事件必须绑定消息/定时/信号等事件定义。'
  },
  'fake-join': {
    name: '伪汇聚（任务/事件存在多条入线）',
    suggestion: '任务或事件不应表达汇聚语义，请改用并行汇聚（parallel join）网关。'
  },
  'global': {
    name: '全局元素未命名 / 未使用 / 重复命名',
    suggestion: 'Error、Message、Signal、Escalation 等全局元素必须命名、被至少一个元素引用，且同类型下名称唯一。'
  },
  'label-required': {
    name: '元素缺少标签/名称',
    suggestion: '选中该元素，在右侧属性面板的「名称」中填写 label。'
  },
  'link-event': {
    name: '链接事件缺失配对或命名',
    suggestion: '每个链接 throw 事件都需在同范围内有配对的 catch 事件；链接名（link name）必须存在且唯一成对。'
  },
  'no-bpmndi': {
    name: '元素缺少 BPMNDI 图形定义',
    suggestion: '该元素没有对应的 <bpmndi:> 图形段落，删除后重新拖入该元素，或用 XML 视图补全 DI 定义。'
  },
  'no-complex-gateway': {
    name: '不建议使用复杂网关',
    suggestion: '复杂网关（ComplexGateway）语义复杂且难以推导，建议用排他/并行网关组合替代。'
  },
  'no-disconnected': {
    name: '元素未连接',
    suggestion: '该节点没有入线或出线，请用顺序流将其接入流程。'
  },
  'no-duplicate-sequence-flows': {
    name: '存在重复顺序流',
    suggestion: '两个节点之间不应有多条相同方向的顺序流，请删除重复的那一条。'
  },
  'no-gateway-join-fork': {
    name: '网关同时汇聚与分叉',
    suggestion: '一个网关不应既有多条入线又有多条出线，请拆成「汇聚网关 + 分叉网关」串联。'
  },
  'no-implicit-split': {
    name: '隐式分叉',
    suggestion: '节点有多条出线时应使用显式网关（如排他/并行），而不是隐式分叉语义。'
  },
  'no-implicit-end': {
    name: '元素缺少出路线（隐式结束）',
    suggestion: '该节点没有出线，流程在此隐式终止；请补出线或用明确的结束事件/网关。'
  },
  'no-implicit-start': {
    name: '元素缺少入路线（隐式开始）',
    suggestion: '该节点没有入线，流程从此隐式开始；请补入线或用明确的开始事件/网关。'
  },
  'no-inclusive-gateway': {
    name: '不建议使用包容网关',
    suggestion: '包容网关（InclusiveGateway）易产生不可控的组合路径，建议用排他+并行网关组合替代。'
  },
  'no-overlapping-elements': {
    name: '元素重叠',
    suggestion: '多个元素的图形位置互相重叠，请拖动调整避免叠放。'
  },
  'single-blank-start-event': {
    name: '存在多个空白开始事件',
    suggestion: '同一流程（子流程）中只能有一个不带事件定义的空白开始事件。'
  },
  'single-event-definition': {
    name: '事件定义重复',
    suggestion: '一个事件只能绑定一个事件定义，请删除多余的 eventDefinition。'
  },
  'start-event-required': {
    name: '缺少开始事件',
    suggestion: '每个流程/子流程都应有一个开始事件作为流程入口，请补充一个 Start Event。'
  },
  'sub-process-blank-start-event': {
    name: '子流程空白开始事件',
    suggestion: '子流程内部的开始事件应绑定事件定义（或确认该子流程不需要触发语义）。'
  },
  'superfluous-gateway': {
    name: '多余网关',
    suggestion: '网关如果只有一条入线或一条出线就没有分流/汇聚语义，可以直接删除。'
  },
  'superfluous-termination': {
    name: '多余终止事件',
    suggestion: '单入线且无出线的终止事件没有额外语义，可以移除。'
  },

  // ── bpmnlint-plugin-camunda ──
  'camunda/avoid-lanes': {
    name: '避免使用泳道（Lane）',
    suggestion: 'Camunda 建模规范建议避免 lanes，请改用参与者/池（Participant）组织职责。'
  },
  'camunda/forking-conditions': {
    name: '分叉网关出线缺少条件',
    suggestion: '排他网关分叉（≥2 条出线）时，每条出线都要有条件表达式，或将其中一条设为默认流。'
  },
  'camunda/implementation': {
    name: '缺少可执行实现配置',
    suggestion: '活动需要绑定 Camunda 实现（类 class / 表达式 expression / 委托 delegateExpression），请到属性面板「实现」中配置。'
  }
};

/** 未收录规则的最短可读回退 */
const FALLBACK_SUGGESTION = '请选中该元素检查属性设置，或参考上方规则说明调整模型结构。';

/**
 * 获取规则的中文展示信息（未知规则优雅降级）。
 *
 * @param {string} rule  bpmnlint 规则名，如 'label-required' 或 'camunda/implementation'
 *
 * @returns {{ name: string, suggestion: string, docUrl: string }}
 */
export function ruleInfo(rule) {
  const entry = RULE_LABELS[rule] || {};
  const name = entry.name || rule;
  const suggestion = entry.suggestion || FALLBACK_SUGGESTION;
  const docUrl = ruleDocUrl(rule);
  return { name, suggestion, docUrl };
}

/**
 * 规则官方文档链接；camunda 规则指向插件仓库 rules 目录。
 *
 * @param {string} rule
 *
 * @returns {string} 文档 URL（未知前缀规则仍按 bpmnlint 文档链接处理）
 */
export function ruleDocUrl(rule) {
  if (rule.startsWith('camunda/')) {
    const short = rule.slice('camunda/'.length);
    return CAMUNDA_RULES_BASE + '/' + short + '.js';
  }
  return `${BPMNLINT_DOCS_BASE}/${rule}.md`;
}

/**
 * 元素类型 → 中文名。
 *
 * @param {string} $type  moddle 元素类型，如 'bpmn:UserTask'
 *
 * @returns {string} 中文类型名；未知类型剥离 'bpmn:' 前缀后原样返回
 */
export function elementTypeLabel($type) {
  if (typeof $type !== 'string') return '';
  const short = $type.includes(':') ? $type.slice($type.indexOf(':') + 1) : $type;
  return TYPE_LABELS[short] || short;
}

// 常见 BPMN 元素类型的中文名（覆盖大部分建模场景）
const TYPE_LABELS = {
  Definitions: '流程定义根',
  Collaboration: '协作',
  Process: '流程',
  Participant: '参与者/池',
  Lane: '泳道',
  StartEvent: '开始事件',
  EndEvent: '结束事件',
  TerminateEventDefinition: '终止事件定义',
  Task: '任务',
  UserTask: '用户任务',
  ServiceTask: '服务任务',
  SendTask: '发送任务',
  ReceiveTask: '接收任务',
  ManualTask: '手动任务',
  ScriptTask: '脚本任务',
  BusinessRuleTask: '业务规则任务',
  CallActivity: '调用活动',
  SubProcess: '子流程',
  Transaction: '事务',
  AdHocSubProcess: '临时子流程',
  EventSubProcess: '事件子流程',
  ExclusiveGateway: '排他网关',
  ParallelGateway: '并行网关',
  InclusiveGateway: '包容网关',
  EventBasedGateway: '事件网关',
  ComplexGateway: '复杂网关',
  SequenceFlow: '顺序流',
  MessageFlow: '消息流',
  DataAssociation: '数据关联',
  BoundaryEvent: '边界事件',
  IntermediateCatchEvent: '中间捕获事件',
  IntermediateThrowEvent: '中间抛出事件',
  ImplicitThrowEvent: '隐式抛出事件',
  DataObjectReference: '数据对象引用',
  DataStoreReference: '数据存储引用',
  TextAnnotation: '文本注释',
  Group: '分组',
  Association: '关联'
};

/**
 * lint 问题级别 → 中文标签（徽章用）。
 */
const CATEGORY_LABELS = {
  error: '错误',
  warn: '警告',
  info: '提示'
};

/**
 * @param {string} category  'error' | 'warn' | 'info'
 *
 * @returns {string} 中文级别名；未知值返回原始值
 */
export function lintCategoryLabel(category) {
  return CATEGORY_LABELS[category] || category || '问题';
}

/** 级别在 UI 中的排序权重（越小越靠前） */
export function categorySortWeight(category) {
  return category === 'error' ? 0 : category === 'warn' ? 1 : 2;
}