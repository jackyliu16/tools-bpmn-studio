/**
 * studio-utils — studio 参数体系的纯逻辑（可 node 单测，无 DOM 依赖）。
 *
 * 职责：
 *   1. 读取/构造 studio:Parameters（extensionElements 内）；
 *   2. 构造「单向编译：studio → camunda:inputOutput」的命令序列
 *      （走 properties-panel.multi-command-executor 原子批，undo 成对回退）；
 *   3. 边参数投影（上游出参 ∩ 下游入参）与条件变量引用提取（检查面板用）。
 *
 * 编辑态权威是 studio:Parameters；camunda 侧始终由同步命令重建（双写落盘），
 * 保证 1:1 对应，避免漂移。
 */

/** 元素 extensionElements 中指定类型的实例列表 */
export function getExtensionElementsList(businessObject, type) {
  const extensionElements = businessObject && businessObject.get('extensionElements');
  if (!extensionElements) return [];
  const values = extensionElements.get('values') || [];
  return values.filter((v) => v.$instanceOf(type));
}

/** studio:Parameters 包装（无则 null） */
export function getStudioParams(businessObject) {
  return getExtensionElementsList(businessObject, 'studio:Parameters')[0] || null;
}

/** camunda:InputOutput 包装（无则 null） */
export function getCamundaIo(businessObject) {
  return getExtensionElementsList(businessObject, 'camunda:InputOutput')[0] || null;
}

/** 参数 moddle 元素 → 普通对象 */
export function normalizeParam(param) {
  if (!param) return null;
  return {
    name: param.get('name') || '',
    type: param.get('type') || '',
    expression: param.get('expression') || '',
    description: param.get('description') || ''
  };
}

export function paramList(params, which) {
  const list = (params && params.get(which)) || [];
  return list.map(normalizeParam);
}

/** studio 参数 → camunda:InputOutput 实例（value=表达式，body 文本） */
export function inputOutputFromStudio(bpmnFactory, inputs, outputs) {
  return bpmnFactory.create('camunda:InputOutput', {
    inputParameters: inputs.map((p) =>
      bpmnFactory.create('camunda:InputParameter', { name: p.name || undefined, value: p.expression || undefined })
    ),
    outputParameters: outputs.map((p) =>
      bpmnFactory.create('camunda:OutputParameter', { name: p.name || undefined, value: p.expression || undefined })
    )
  });
}

/** 确保 extensionElements 存在（缺失时产出创建命令）；返回解析后的 ee 实例 */
export function ensureExtensionElements(element, businessObject, bpmnFactory) {
  const existing = businessObject.get('extensionElements');
  if (existing) return { ee: existing, commands: [] };
  const ee = bpmnFactory.create('bpmn:ExtensionElements', { values: [] });
  return {
    ee,
    commands: [{
      cmd: 'element.updateModdleProperties',
      context: { element, moddleElement: businessObject, properties: { extensionElements: ee } }
    }]
  };
}

/** 更新 studio 某一侧参数列表的单个命令 */
export function updateStudioListCommand(element, paramsBo, which, nextList) {
  return {
    cmd: 'element.updateModdleProperties',
    context: {
      element,
      moddleElement: paramsBo,
      properties: { [which]: nextList }
    }
  };
}

/** 重建 camunda:InputOutput 使其精确等于 studio 参数（命令序列；双侧皆空则移除）
 *  ee 由 ensureExtensionElements 在构造期解析并传入，避免执行前读不到的问题。
 *
 * 注意：本函数在【构造期】读取 ee.get('values') 等实时状态；调用方须保证
 * 在此之前已把新建的 studio:Parameters 推入同一 ee 实例（模拟执行顺序），
 * 否则多命令批中下游命令会拿到脏快照。 */
export function buildCamundaSyncCommands(element, businessObject, ee, bpmnFactory, inputs, outputs) {
  const existing = getCamundaIo(businessObject);
  const hasAny = inputs.length > 0 || outputs.length > 0;

  if (!hasAny) {
    if (!existing) return [];
    return [{
      cmd: 'element.updateModdleProperties',
      context: {
        element,
        moddleElement: ee,
        properties: { values: (ee.get('values') || []).filter((v) => v !== existing) }
      }
    }];
  }

  // 全量重建而非增量：消除改名/删除后残留，保证与 studio 1:1
  const rebuilt = inputOutputFromStudio(bpmnFactory, inputs, outputs);
  if (!existing) {
    return [{
      cmd: 'element.updateModdleProperties',
      context: {
        element,
        moddleElement: ee,
        properties: { values: [...(ee.get('values') || []), rebuilt] }
      }
    }];
  }

  return [{
    cmd: 'element.updateModdleProperties',
    context: {
      element,
      moddleElement: ee,
      properties: { values: (ee.get('values') || []).map((v) => (v === existing ? rebuilt : v)) }
    }
  }];
}

/** 完整的 studio 写命令（保证 EE + studio:Parameters + 列表 + camunda 同步原子化） */
export function buildStudioWriteCommands(element, businessObject, bpmnFactory, which, nextList) {
  // 构造期解析 EE：后续命令共享同一实例（执行期才能读取）
  const { ee, commands } = ensureExtensionElements(element, businessObject, bpmnFactory);

  let paramsBo = getStudioParams(businessObject);
  if (!paramsBo) {
    paramsBo = bpmnFactory.create('studio:Parameters', { inputParameters: [], outputParameters: [] });
    // 构造期模拟执行：把新参数推入 ee，令后续同步命令读到正确快照
    const values = ee.get('values') || [];
    values.push(paramsBo);
    if (ee.get('values') !== values) {
      // fresh EE 且未预置 values 时（防御）：回写
      ee.set('values', values);
    }
    commands.push({
      cmd: 'element.updateModdleProperties',
      context: {
        element,
        moddleElement: ee,
        properties: { values: ([...values]) }
      }
    });
  }

  // 构造变更后的双侧列表（另一侧保持现状）
  const inputs = which === 'inputParameters' ? nextList : paramList(paramsBo, 'inputParameters');
  const outputs = which === 'outputParameters' ? nextList : paramList(paramsBo, 'outputParameters');

  // 关键：nextList 是纯对象，必须先实例化为带 $descriptor 的 moddle 元素，
  // 否则 updateModdleProperties 会塞入裸对象（无 $descriptor → lint 遍历/序列化崩溃）
  const ParamType = which === 'inputParameters' ? 'studio:InputParameter' : 'studio:OutputParameter';
  const nextInstances = nextList.map((p) => bpmnFactory.create(ParamType, {
    name: p.name || undefined,
    type: p.type || 'string',
    expression: p.expression || undefined,
    description: p.description || undefined
  }));

  commands.push(updateStudioListCommand(element, paramsBo, which, nextInstances));
  commands.push(...buildCamundaSyncCommands(element, businessObject, ee, bpmnFactory, inputs, outputs));
  return commands;
}

/** 活动类元素判定（studio 参数适用范围） */
export function isStudioActivity(businessObject) {
  return businessObject && typeof businessObject.$instanceOf === 'function' &&
    businessObject.$instanceOf('bpmn:Activity');
}

/** 非活动元素是否携带 studio 参数（R5：无执行落点） */
export function hasStudioParamsIn(businessObject) {
  const params = getStudioParams(businessObject);
  return !!params && (params.get('inputParameters').length > 0 || params.get('outputParameters').length > 0);
}

/** 元素「出参名集合」（studio 权威 + camunda 兼容合并） */
export function outputNames(businessObject) {
  const names = new Set(paramList(getStudioParams(businessObject), 'outputParameters').map((p) => p.name).filter(Boolean));
  const io = getCamundaIo(businessObject);
  if (io) (io.get('outputParameters') || []).forEach((p) => names.add(p.get('name')));
  return names;
}

/** 元素「入参名集合」 */
export function inputNames(businessObject) {
  const names = new Set(paramList(getStudioParams(businessObject), 'inputParameters').map((p) => p.name).filter(Boolean));
  const io = getCamundaIo(businessObject);
  if (io) (io.get('inputParameters') || []).forEach((p) => names.add(p.get('name')));
  return names;
}

/**
 * 边参数投影：上游出参 ∩ 下游入参（同名变量即「边携带」）。
 * 派生视图，不落盘 —— 对应 B2 方案「边参数 = 投影」。
 */
export function flowProjectionNames(sourceBo, targetBo) {
  if (!sourceBo || !targetBo) return [];
  const outs = outputNames(sourceBo);
  const ins = inputNames(targetBo);
  return [...outs].filter((n) => ins.has(n)).sort();
}

const CONDITION_KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'if', 'else', 'then', 'and', 'or', 'not',
  'for', 'in', 'of', 'new', 'return', 'function', 'var', 'let', 'const', 'this', 'self',
  'window', 'document', 'Math', 'JSON', 'String', 'Number', 'Boolean', 'Date', 'Array', 'Object',
  'is', 'item', 'setVariable', 'getVariable', 'execution', 'task', 'historyService'
]);

/** 从条件表达式正文粗提取「根标识符」引用（字符串/数字/关键字除外）。
 *
 *  - `order.status == 'paid'` → `['order']`（属性/方法段不属于变量引用）
 *  - `${amount > 100}` / `#{amount > 100}` → `['amount']`（EL 定界符分隔，保留内部）
 *  - `myVar.get("a") == 1` → `['myVar']`
 */
export function extractConditionIdentifiers(body) {
  if (!body || typeof body !== 'string') return [];
  const cleaned = body
    // 字符串字面量整体忽略
    .replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, ' ')
    // EL 定界符（${…} / #{…}）当分隔符，内部表达式保留
    .replace(/[$#]\{/g, ' ')
    .replace(/\}/g, ' ')
    // 去掉属性/方法访问段，只保留根标识符
    .replace(/\.[A-Za-z_$][\w$]*/g, '');
  const found = cleaned.match(/[A-Za-z_$][\w$]*/g) || [];
  return [...new Set(found.filter((id) => !CONDITION_KEYWORDS.has(id) && !/^\d+$/.test(id)))];
}

/** camunda 侧与 studio 侧是否 1:1 对应（R4 漂移判定） */
export function camundaMatchesStudio(businessObject) {
  const studio = getStudioParams(businessObject);
  const io = getCamundaIo(businessObject);
  const sIn = paramList(studio, 'inputParameters');
  const sOut = paramList(studio, 'outputParameters');
  const hasStudio = !!studio && (sIn.length > 0 || sOut.length > 0);

  if (!hasStudio) {
    // 无 studio 参数却存在 camunda io → 外部产物/漂移
    return !io;
  }
  if (!io) return false;
  const cIn = (io.get('inputParameters') || []).map((p) => ({ name: p.get('name'), expression: p.get('value') }));
  const cOut = (io.get('outputParameters') || []).map((p) => ({ name: p.get('name'), expression: p.get('value') }));
  // 空表达式归一化：studio 侧为 ''（未设），camunda 侧为 undefined（无 body）→ 等价。
  // 无序比较：Camunda 语义与参数先后顺序无关，外部工具重排同一集合不应判为漂移。
  const keyOf = (p) => `${p.name || ''}\u0000${p.expression || ''}`;
  const eq = (a, b) => {
    if (a.length !== b.length) return false;
    const ak = a.map(keyOf).sort();
    const bk = b.map(keyOf).sort();
    return ak.every((x, i) => x === bk[i]);
  };
  return eq(cIn, sIn) && eq(cOut, sOut);
}

/**
 * 作用域变量目录（同步、确定性；路由变量 chips 与 R1/R3 检查共用）。
 *
 * 取 flow 所在作用域（进程/子流程）**直接子级**活动节点的出参名（studio 权威 + camunda 合并），
 * 附 studio 类型。严格作用域局部：子流程内部活动产生的变量不上浮到父作用域
 * （Camunda 语义下需经输出映射才可见），因此不做祖先/后代穿透。
 *
 * @param {ModdleElement} flowBo 顺序流的 businessObject（取 $parent 为作用域）
 * @param {ModdleElement[]} elementBos 注册表内全部元素的 businessObject
 * @returns {Array<{name: string, type: string}>}
 */
export function resolveScopeVariablesFor(flowBo, elementBos) {
  const scope = flowBo && flowBo.$parent;
  if (!scope) return [];

  const byName = new Map();
  for (const bo of elementBos) {
    if (!bo || typeof bo.$instanceOf !== 'function' || !bo.$instanceOf('bpmn:Activity')) continue;
    if (bo.$parent !== scope) continue;
    for (const name of outputNames(bo)) {
      if (!byName.has(name)) {
        byName.set(name, { name, type: studioParamTypeOf(bo, name) });
      }
    }
  }
  return [...byName.values()];
}

function studioParamTypeOf(bo, name) {
  const p = paramList(getStudioParams(bo), 'outputParameters').find((x) => x.name === name);
  return p ? p.type : '';
}