/**
 * index — 「控制要素」模块组装。
 *
 * 由 main.js 加入 BpmnModeler additionalModules，全局生效：
 *
 *   1. `translate`（value 覆盖）— 官方属性面板全部中文标签（zh-labels.js）；
 *   2. `controlProvider`（type + __init__）— 「网关默认流」控制要素组
 *      （default-flow-provider.js）。
 */
import DefaultFlowProvider from './default-flow-provider.js';
import { controlTranslate } from './zh-labels.js';

export { controlTranslate } from './zh-labels.js';
export { cleanupDanglingDefaultFlows } from './cleanup-default.js';

/**
 * bpmn-js 模块声明：覆盖 translate 服务并初始化控制要素 provider。
 */
export const controlModule = {
  translate: ['value', controlTranslate],
  __init__: ['controlProvider'],
  controlProvider: ['type', DefaultFlowProvider]
};

export default controlModule;