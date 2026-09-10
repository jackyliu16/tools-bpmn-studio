/**
 * zh-labels — 属性面板（控制要素）中文标签覆盖。
 *
 * 通过覆盖 diagram-js 的 `translate` 服务（value 注入，didi 后注册者生效），
 * 把 bpmn-js-properties-panel 官方 provider（Bpmn / Camunda Platform / Zeebe）
 * 暴露的全部 group / entry / select 标签翻译为中文，构成「控制要素」管理界面。
 *
 * 覆盖范围以 node_modules/bpmn-js-properties-panel/dist/index.esm.js 中全部
 * `label: translate('…')` 与 `translate(('…')` 字面量为基准（见 ZH_LABELS 键）。
 * 未收录的键回退为 diagram-js 原生 translate 行为（原文 + {占位符} 插值），
 * 不抛错、不影响其他组件（调色板 / context pad 等共享同一 translate 服务）。
 */

/**
 * 英文原文 → 中文标签。键必须与官方源码字符串完全一致（含大小写与空格）。
 */
export const ZH_LABELS = {
  // ── 分组（groups） ──
  'General': '通用',
  'Documentation': '说明文档',
  'Compensation': '补偿',
  'Error': '错误',
  'Errors': '错误',
  'Escalation': '升级',
  'Link': '链接',
  'Message': '消息',
  'Multi-instance': '多实例',
  'Ad-hoc': '临时子流程',
  'Signal': '信号',
  'Timer': '定时器',
  'Implementation': '实现',
  'User assignment': '用户分配',
  'Execution listeners': '执行监听器',
  'Task listeners': '任务监听器',
  'Asynchronous continuations': '异步延续',
  'Job execution': '作业执行',
  'Condition': '条件',
  'Call activity': '调用活动',
  'Extension properties': '扩展属性',
  'Field injections': '字段注入',
  'Business key': '业务键',
  'Candidate starter': '候选发起人',
  'Tasklist': '任务列表',
  'History cleanup': '历史清理',
  'Start initiator': '发起人',
  'External task': '外部任务',
  'Process variables': '流程变量',
  'Forms': '表单',
  'Form fields': '表单字段',
  'In mappings': '输入映射',
  'Out mappings': '输出映射',
  'Connector inputs': '连接器输入',
  'Connector outputs': '连接器输出',
  'In mapping propagation': '输入映射传播',
  'Out mapping propagation': '输出映射传播',
  'Script': '脚本',

  // ── 通用条目（core provider） ──
  'Name': '名称',
  'Process name': '流程名称',
  'Process ID': '流程 ID',
  'ID': '标识',
  'Executable': '可执行',
  'Element documentation': '元素文档',
  'Process documentation': '流程文档',
  'Version': '版本',
  'Version tag': '版本标签',
  'Tenant ID': '租户 ID',

  // ── 实现（Implementation） ──
  'Implementation type': '实现类型',
  'Class': '类',
  'Java class': 'Java 类',
  'Expression': '表达式',
  'Delegate expression': '委托表达式',
  'Delegate Class': '委托类',
  'Delegate Expression': '委托表达式',
  'Delegate Variable Mapping': '委托变量映射',
  'Topic': '主题',
  'Type': '类型',
  'Job type': '作业类型',
  'Job worker': '作业工作者',
  'Resource': '资源',
  'Format': '格式',
  'Inline script': '内联脚本',
  'Script type': '脚本类型',
  'Called element': '被调用元素',
  'Called decision': '被调用决策',
  'Decision ID': '决策 ID',
  'Decision reference': '决策引用',
  'Map decision result': '映射决策结果',
  'Result variable': '结果变量',
  'Wait for completion': '等待完成',
  'Case ref': 'CMMN 用例引用',

  // ── 用户分配（User assignment） ──
  'Assignee': '受理人',
  'Candidate users': '候选用户',
  'Candidate groups': '候选组',
  'Due date': '到期时间',
  'Follow up date': '跟进时间',
  'Priority': '优先级',
  'Assignment': '分配',
  'Assignment type': '分配类型',
  'Custom type': '自定义类型',
  'Config': '配置',

  // ── 异步 / 作业 ──
  'Asynchronous before': '异步前',
  'Asynchronous after': '异步后',
  'Exclusive': '排他（独占作业）',
  'Retries': '重试次数',
  'Retry time cycle': '重试周期',
  'Job priority': '作业优先级',
  'Time to live': '存活时间',

  // ── 条件 ──
  'Condition expression': '条件表达式',
  'Condition Expression': '条件表达式',
  'Variable events': '变量事件',
  'Local': '本地',

  // ── 监听器 / 字段注入 / 扩展属性 ──
  'Listener ID': '监听器标识',
  'Listener type': '监听器类型',
  'Event type': '事件类型',
  'Field injection': '字段注入',
  'Properties': '属性',
  'Key': '键',
  'Value': '值',
  'Values': '值列表',
  'Variable name': '变量名',
  'Variable assignment value': '变量赋值',
  'Source': '来源',
  'Target': '目标',
  'Source expression': '来源表达式',
  'Throw expression': '抛出表达式',

  // ── 表单 / 业务键 / 候选发起人 ──
  'Form': '表单',
  'Form key': '表单标识',
  'Custom form key': '自定义表单标识',
  'Form ID': '表单 ID',
  'Form JSON configuration': '表单 JSON 配置',
  'Form reference': '外部表单引用',
  'External form reference': '外部表单引用',
  'Camunda Form': 'Camunda 表单',
  'Camunda Form (linked)': 'Camunda 表单（链接）',
  'Camunda Form (embedded)': 'Camunda 表单（内嵌）',
  'Camunda Forms': 'Camunda 表单',
  'Camunda user task': 'Camunda 用户任务',
  'Generated Task Forms': '生成的表单',
  'Embedded or External Task Forms': '内嵌或外部表单',
  'Business key expression': '业务键表达式',
  'Business ID': '业务 ID',
  'Subscription correlation key': '订阅关联键',
  'Candidate starter groups': '候选发起组',
  'Candidate starter users': '候选发起用户',
  'Initiator': '发起人',

  // ── 任务列表 / 历史清理 / 流程变量 ──
  'Startable': '可启动',

  // ── 输入 / 输出映射 ──
  'Input mapping': '输入映射',
  'Output mapping': '输出映射',
  'Input propagation': '输入传播',
  'Output propagation': '输出传播',
  'Propagate all variables': '传播所有变量',
  'Propagate all parent process variables': '传播所有父流程变量',
  'Propagate all child process variables': '传播所有子流程变量',
  'Connector ID': '连接器标识',
  'Headers': '头部',

  // ── 调用活动 / 多实例 / 补偿 ──
  'Binding': '绑定',
  'deployment': '同部署',
  'latest': '最新',
  'version': '版本',
  'version tag': '版本标签',
  'versionTag': '版本标签',
  'Version tag binding': '版本标签绑定',
  'Multi Instance': '多实例',
  'Loop cardinality': '循环基数',
  'Collection': '集合',
  'Element variable': '元素变量',
  'Input collection': '输入集合',
  'Input element': '输入元素',
  'Output collection': '输出集合',
  'Output element': '输出元素',
  'Completion condition': '完成条件',
  'Cancel remaining instances': '取消剩余实例',
  'Active elements': '活动元素',
  'Active elements collection': '活动元素集合',
  'Completion': '完成',
  'Map': '映射',
  'Map entries': '映射条目',
  'Activity reference': '活动引用',

  // ── 定时器 / 消息 / 错误 / 信号 / 升级 ──
  'Cycle': '周期',
  'Date': '日期',
  'Duration': '时长',
  'Message variable': '消息变量',
  'Global error reference': '全局错误引用',
  'Global message reference': '全局消息引用',
  'Global signal reference': '全局信号引用',
  'Global escalation reference': '全局升级引用',
  'Constraints': '约束',

  // ── 选择项 / 杂项 ──
  '<none>': '<无>',
  '<custom type>': '<自定义类型>',
  'Before': '之前',
  'After': '之后',
  'start': '开始',
  'end': '结束',
  'take': '流转',
  'timeout': '超时',
  'complete': '完成',
  'create': '创建',
  'delete': '删除',
  'update': '更新',
  'assignment': '分配',
  'boolean': '布尔',
  'string': '字符串',
  'date': '日期',
  'long': '长整型',
  'enum': '枚举',
  'List': '列表',
  'List values': '列表值',
  'String or expression': '字符串或表达式',
  'Default value': '默认值',
  'BPMN': 'BPMN',
  'CMMN': 'CMMN',
  'DMN decision': 'DMN 决策',
  'FEEL expression': 'FEEL 表达式',
  'Create new ...': '新建 …',
  'Learn more.': '了解更多。',
  'Learn how to define conditions.': '了解如何定义条件。',
  'Usage': '用法',
  'Preview': '预览',
  'Output behavior': '输出行为',
  'Input': '输入',
  'Output': '输出',
  'Embed': '嵌入',
  'Inline': '内联',
  'External': '外部',
  'Optional': '可选',
  'Input data references': '输入数据引用',
  'Output data references': '输出数据引用',
  'DataInput': '数据输入',
  'DataOutput': '数据输出',
  'DataObject': '数据对象',
  'DataStore': '数据存储',
  'TextAnnotation': '文本注释',
  'Group': '分组',
  'Association': '关联',
  'MessageFlow': '消息流',
  'SequenceFlow': '顺序流',
  'Participant': '参与者',
  'Lane': '泳道',
  'SubProcess': '子流程',
  'Transaction': '事务',
  'CallActivity': '调用活动',
  'Gateway': '网关',
  'Event': '事件',
  'Task': '任务'
};

/**
 * 覆盖 diagram-js translate 服务的函数。
 *
 * @param {string} template 英文原文模板
 * @param {Object} [replacements] 占位符插值（与 diagram-js 原生行为一致）
 *
 * @returns {string} 中文文案；未收录键回退原文插值
 */
export function controlTranslate(template, replacements) {
  replacements = replacements || {};

  const hit = ZH_LABELS[template];
  if (typeof hit === 'string' && hit !== '') {
    return applyReplacements(hit, replacements);
  }
  return applyReplacements(template, replacements);
}

function applyReplacements(text, replacements) {
  return text.replace(/{([^}]+)}/g, (_, key) => replacements[key] || '{' + key + '}');
}