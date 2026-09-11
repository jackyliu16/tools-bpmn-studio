/**
 * studio-moddle — studio 参数体系的 moddle 描述符。
 *
 * 自定义命名空间 `studio:`（http://bpmn.studio/schema/studio），承载 B2 方案的
 * 参数 schema（作者态）：节点入参/出参（名称、类型、表达式、说明）。
 *
 * 结构对齐 camunda-bpmn-moddle 惯例：
 *   - `studio:Parameters` 挂在元素的 `bpmn:extensionElements` values 里；
 *   - tagAlias=lowerCase，序列化为 `<studio:parameters>`；
 *   - 每个参数一个 `<studio:inputParameter name=… type=… expression=… description=…/>`
 *     （全部属性化，避免与 camunda value(body) 语义混淆）。
 *
 * camunda 可执行侧（camunda:inputOutput）由同步器从本 schema 单向生成（双写落盘），
 * 见 studio-utils.js 的 buildSyncCommands。
 */
export const STUDIO_URI = 'http://bpmn.studio/schema/studio';

/** 参数类型枚举（选择器与等价性检查共用） */
export const STUDIO_PARAM_TYPES = ['string', 'number', 'boolean', 'date'];

export const studioModdle = {
  name: 'Studio',
  prefix: 'studio',
  uri: STUDIO_URI,
  xml: {
    tagAlias: 'lowerCase'
  },
  types: [
    {
      name: 'Parameters',
      superClass: ['Element'],
      meta: {
        // 与 camunda 扩展类型相同的声明：允许出现在 bpmn:FlowNode 的 extensionElements
        allowedIn: ['bpmn:FlowNode']
      },
      properties: [
        { name: 'inputParameters', isMany: true, type: 'InputParameter' },
        { name: 'outputParameters', isMany: true, type: 'OutputParameter' }
      ]
    },
    {
      name: 'InputParameter',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'expression', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' }
      ]
    },
    {
      name: 'OutputParameter',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'expression', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' }
      ]
    }
  ]
};

export default studioModdle;