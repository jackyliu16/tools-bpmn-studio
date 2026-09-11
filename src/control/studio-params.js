/**
 * studio-params — studio 参数体系的属性面板 provider。
 *
 * 提供（均走既有 registerProvider 机制）：
 *   1. StudioParamsProvider（优先级 720）：活动类元素的「入参/出参」ListGroup，
 *      studio schema（名称/类型/表达式/说明）为唯一编辑入口；
 *      每次编辑 = properties-panel.multi-command-executor 原子批
 *      （studio 变更 + camunda:inputOutput 同步，undo 成对回退）。
 *   2. StudioRouteProvider（优先级 700）：顺序流专用——
 *      「路由变量」chips（作用域可用变量，点击插入条件表达式）
 *      +「顺序流变量（边携带）」投影列表（A 出参 ∩ B 入参）。
 *   3. StudioNoticeProvider（优先级 400）：在官方 Inputs/Outputs 组首
 *      插入「由【入参/出参】组同步生成」说明，标识生成件只读权威。
 */
import { ListGroup, SelectEntry, TextFieldEntry, isSelectEntryEdited, isTextFieldEntryEdited } from '@bpmn-io/properties-panel';
import { h } from 'preact';
import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

import { STUDIO_PARAM_TYPES } from './studio-moddle.js';
import {
  flowProjectionNames,
  getCamundaIo,
  getStudioParams,
  paramList,
  isStudioActivity,
  buildStudioWriteCommands,
  resolveScopeVariablesFor
} from './studio-utils.js';

// ---------------------------------------------------------------------------
// 只读提示条目（preact 自定义组件，非输入框）
// ---------------------------------------------------------------------------

function readonlyEntry(id, getText) {
  return {
    id,
    component(props) {
      return h('div', { class: 'bio-properties-panel-entry', 'data-entry-id': props.id },
        h('div', { class: 'studio-note' }, getText()));
    }
  };
}

// ---------------------------------------------------------------------------
// 1) 「入参 / 出参」参数组（活动类元素）
// ---------------------------------------------------------------------------

export function StudioParamsProvider(propertiesPanel, commandStack, bpmnFactory, eventBus, debounceInput) {
  this._commandStack = commandStack;
  this._bpmnFactory = bpmnFactory;
  this._eventBus = eventBus;
  this._debounce = debounceInput;
  propertiesPanel.registerProvider(720, this);
}

StudioParamsProvider.$inject = ['propertiesPanel', 'commandStack', 'bpmnFactory', 'eventBus', 'debounceInput'];

StudioParamsProvider.prototype.getGroups = function (element) {
  const self = this;
  return function (groups) {
    const businessObject = getBusinessObject(element);
    if (!isStudioActivity(businessObject)) {
      return groups;
    }

    const { _commandStack: commandStack, _bpmnFactory: bpmnFactory, _eventBus: eventBus, _debounce: debounce } = self;
    // 官方 Inputs/Outputs 组是 ListGroup（.items），不注入条目；说明放 studio 组内（仅在存在映射时展示）
    if (getStudioParams(businessObject) || getCamundaIo(businessObject)) {
      groups.push({
        id: 'StudioParams__Note',
        label: 'Camunda 映射（自动生成）',
        entries: [readonlyEntry('studioCamundaGeneratedNotice',
          () => 'Camunda 侧 inputOutput 由下方「入参 / 出参」同步生成，请勿在官方 Inputs/Outputs 组手改；外部编辑会触发参数检查 R4 漂移。')]
      });
    }
    groups.push(studioListGroup(element, businessObject, 'inputParameters', '入参（流程变量 → 节点局部）', commandStack, bpmnFactory, eventBus, debounce));
    groups.push(studioListGroup(element, businessObject, 'outputParameters', '出参（节点结果 → 流程变量）', commandStack, bpmnFactory, eventBus, debounce));
    return groups;
  };
};

function writeList(element, businessObject, which, nextList, commandStack, bpmnFactory, eventBus) {
  commandStack.execute('properties-panel.multi-command-executor',
    buildStudioWriteCommands(element, businessObject, bpmnFactory, which, nextList));
  // 兜底：批量命令的 elements.changed 载荷可能不含选中元素，面板不会自动重建；
  // 显式补发一次（幂等），保证 ListGroup 立即反映最新模型（含 undo/redo 路径）。
  eventBus.fire('elements.changed', { elements: [element] });
}

function studioListGroup(element, businessObject, which, label, commandStack, bpmnFactory, eventBus, debounce) {
  const list = paramList(getStudioParams(businessObject), which);

  const add = () => writeList(element, businessObject, which,
    [...list, { name: '', type: 'string', expression: '', description: '' }], commandStack, bpmnFactory, eventBus);

  return {
    id: `StudioParams__${which === 'inputParameters' ? 'Inputs' : 'Outputs'}`,
    label,
    component: ListGroup,
    items: list.map((p, index) => ({
      id: `studio-${which}-${index}`,
      label: p.name || `参数 ${index + 1}`,
      entries: paramFieldEntries(element, businessObject, which, index, commandStack, bpmnFactory, eventBus, debounce),
      remove: () => {
        const current = paramList(getStudioParams(businessObject), which);
        writeList(element, businessObject, which, current.filter((_, i) => i !== index), commandStack, bpmnFactory, eventBus);
      }
    })),
    add
  };
}

function paramFieldEntries(element, businessObject, which, index, commandStack, bpmnFactory, eventBus, debounce) {
  const value = () => (paramList(getStudioParams(businessObject), which)[index] || {});
  const update = (field, fieldValue) => {
    const current = paramList(getStudioParams(businessObject), which);
    writeList(element, businessObject, which,
      current.map((p, i) => (i === index ? { ...p, [field]: fieldValue } : p)), commandStack, bpmnFactory, eventBus);
  };

  return [
    {
      id: `studio-${which}-name-${index}`,
      component: TextFieldEntry,
      isEdited: isTextFieldEntryEdited,
      label: '名称',
      debounce,
      getValue: () => value().name,
      setValue: (v) => update('name', v || '')
    },
    {
      id: `studio-${which}-type-${index}`,
      component: SelectEntry,
      isEdited: isSelectEntryEdited,
      label: '类型',
      getValue: () => value().type || 'string',
      setValue: (v) => update('type', v),
      getOptions: () => STUDIO_PARAM_TYPES.map((t) => ({ value: t, label: t }))
    },
    {
      id: `studio-${which}-expression-${index}`,
      component: TextFieldEntry,
      isEdited: isTextFieldEntryEdited,
      label: '表达式',
      debounce,
      getValue: () => value().expression,
      setValue: (v) => update('expression', v || '')
    },
    {
      id: `studio-${which}-description-${index}`,
      component: TextFieldEntry,
      isEdited: isTextFieldEntryEdited,
      label: '说明',
      debounce,
      getValue: () => value().description,
      setValue: (v) => update('description', v || '')
    }
  ];
}

// ---------------------------------------------------------------------------
// 2) 路由变量 chips + 顺序流变量投影
// ---------------------------------------------------------------------------

export function StudioRouteProvider(propertiesPanel, commandStack, bpmnFactory, elementRegistry) {
  this._commandStack = commandStack;
  this._bpmnFactory = bpmnFactory;
  this._elementRegistry = elementRegistry;
  propertiesPanel.registerProvider(700, this);
}

StudioRouteProvider.$inject = ['propertiesPanel', 'commandStack', 'bpmnFactory', 'elementRegistry'];

StudioRouteProvider.prototype.getGroups = function (element) {
  const self = this;
  return function (groups) {
    const businessObject = getBusinessObject(element);
    if (!businessObject || !businessObject.$instanceOf('bpmn:SequenceFlow')) {
      return groups;
    }

    groups.push({
      id: 'StudioRouteVariables',
      label: '路由变量（点击插入条件）',
      entries: [chipsEntry(element, self)]
    });

    const projection = flowProjectionNames(
      element.source && element.source.businessObject,
      element.target && element.target.businessObject
    );
    groups.push({
      id: 'StudioFlowVariables',
      label: '顺序流变量（边携带）',
      entries: [readonlyEntry('studioFlowVariablesValue',
        () => (projection.length ? `上游出参 ∩ 下游入参：${projection.join(', ')}` : '上游出参 ∩ 下游入参：（无）'))]
    });

    return groups;
  };
};

function chipsEntry(element, provider) {
  const { _commandStack: commandStack, _bpmnFactory: bpmnFactory, _elementRegistry: elementRegistry } = provider;

  return {
    id: 'studioRouteVariablesChips',
    component() {
      const variables = resolveScopeVariablesFor(
        getBusinessObject(element),
        elementRegistry.getAll().map((el) => el.businessObject)
      );
      if (!variables.length) {
        return h('div', { class: 'bio-properties-panel-entry' },
          h('div', { class: 'studio-note' }, '该作用域暂无变量 —— 在上游节点「出参」中声明（写回流程变量后即可在此引用）'));
      }
      return h('div', { class: 'bio-properties-panel-entry' },
        h('div', { class: 'studio-var-chips' }, variables.map((variable) =>
          h('button', {
            type: 'button',
            class: 'studio-var-chip',
            title: `${variable.type ? '类型 ' + variable.type : '未声明类型'} · 点击插入条件`,
            onClick: () => insertConditionVariable(element, variable.name, commandStack, bpmnFactory)
          }, variable.name)
        )));
    }
  };
}

/** 点击插入：优先写入条件表达式输入框光标处，否则直接创建/追加条件 */
function insertConditionVariable(element, name, commandStack, bpmnFactory) {
  const host = document.querySelector('#js-properties-panel [data-entry-id="conditionExpression"]');
  const input = host && (host.querySelector('input.bio-properties-panel-input, textarea.bio-properties-panel-textarea'));
  if (input && input.isConnected) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + name + input.value.slice(end);
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const cursor = start + name.length;
    input.setSelectionRange(cursor, cursor);
    input.focus();
    return;
  }

  const bo = getBusinessObject(element);
  const existing = bo.get('conditionExpression');
  const body = existing && existing.get('body') ? `${existing.get('body')} ${name}` : name;
  const formal = bpmnFactory.create('bpmn:FormalExpression', { body }, bo);
  commandStack.execute('properties-panel.multi-command-executor', [
    { cmd: 'element.updateProperties', context: { element, properties: { conditionExpression: formal } } }
  ]);
}

// ---------------------------------------------------------------------------
// 3) 官方 Inputs/Outputs 组说明——废弃：该组为 ListGroup（.items），
//    不兼容 entries 注入（unshift 会崩）。改为 StudioParams__Note 组内展示。
// ---------------------------------------------------------------------------

export function StudioNoticeProvider(propertiesPanel) {
  // 保留导出以兼容模块注册表；不再注入官方 ListGroup（结构不兼容，见注释）。
  propertiesPanel.registerProvider(400, this);
}

StudioNoticeProvider.$inject = ['propertiesPanel'];

StudioNoticeProvider.prototype.getGroups = function () {
  return function (groups) {
    return groups;
  };
};