/**
 * index — 「控制要素 / studio 参数」模块组装。
 *
 * by main.js 加入 BpmnModeler additionalModules，全局生效：
 *
 *   controlModule（既有）：
 *     1. `translate`（value 覆盖）— 官方属性面板全部中文标签（zh-labels.js）；
 *     2. `controlProvider`（type + __init__）— 「网关默认流」控制要素组。
 *
 *   studioControlModule（B2 参数体系）：
 *     3. studioParamsProvider — 活动「入参/出参」ListGroup + camunda 同步（原子批）；
 *     4. studioRouteProvider — 顺序流「路由变量」chips + 「顺序流变量」投影；
 *     5. studioNoticeProvider — 官方 Inputs/Outputs 组「生成件」说明；
 *     6. studioFlowBadge — 边参数投影徽标（overlays）。
 */
import DefaultFlowProvider from './default-flow-provider.js';
import { controlTranslate } from './zh-labels.js';
import { StudioParamsProvider, StudioRouteProvider, StudioNoticeProvider } from './studio-params.js';
import FlowBadge from './flow-badge.js';

export { controlTranslate } from './zh-labels.js';
export { cleanupDanglingDefaultFlows } from './cleanup-default.js';
export { studioModdle, STUDIO_URI, STUDIO_PARAM_TYPES } from './studio-moddle.js';
export { runStudioChecks, regenerateCamundaMapping, modelViewFromModeler } from './studio-check.js';
export {
  getStudioParams,
  paramList,
  flowProjectionNames,
  buildStudioWriteCommands,
  camundaMatchesStudio,
  resolveScopeVariablesFor
} from './studio-utils.js';

/**
 * bpmn-js 模块声明：bpmn 平台覆盖 translate 服务并初始化控件要素 provider。
 */
export const controlModule = {
  translate: ['value', controlTranslate],
  __init__: ['controlProvider'],
  controlProvider: ['type', DefaultFlowProvider]
};

/**
 * bpmn-js 模块声明：studio 参数体系（B2）。
 */
export const studioControlModule = {
  __init__: [
    'studioParamsProvider',
    'studioRouteProvider',
    'studioNoticeProvider',
    'studioFlowBadge'
  ],
  studioParamsProvider: ['type', StudioParamsProvider],
  studioRouteProvider: ['type', StudioRouteProvider],
  studioNoticeProvider: ['type', StudioNoticeProvider],
  studioFlowBadge: ['type', FlowBadge]
};

export default controlModule;