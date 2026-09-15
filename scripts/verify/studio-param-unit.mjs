/**
 * studio-param-unit — studio 参数体系纯逻辑单元测试（node，无 DOM）。
 *
 * 覆盖：
 *  1. studio moddle descriptor：fromXML → toXML 往返（<studio:parameters> 序列化）
 *  2. camunda 映射编译命令序列（buildStudioWriteCommands）
 *  3. camunda 一致性判定（R4）
 *  4. 边参数投影（上游出参 ∩ 下游入参）
 *  5. 检查规则 R1/R3/R6（runStudioChecks 纯函数）
 */
import { BpmnModdle } from 'bpmn-moddle';
import { readFileSync } from 'node:fs';

import { studioModdle } from '../../src/control/studio-moddle.js';
import {
  getStudioParams,
  camundaMatchesStudio,
  flowProjectionNames,
  buildStudioWriteCommands,
  resolveScopeVariablesFor,
  extractConditionIdentifiers,
  paramList
} from '../../src/control/studio-utils.js';
import { runStudioChecks } from '../../src/control/studio-check.js';

import { createTester } from '../lib/testkit.mjs';

const { check, finish } = createTester();

const camundaModdle = JSON.parse(
  readFileSync(new URL('../../node_modules/camunda-bpmn-moddle/resources/camunda.json', import.meta.url), 'utf8')
);

const moddle = new BpmnModdle({ camunda: camundaModdle, studio: studioModdle });

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
  xmlns:studio="http://bpmn.studio/schema/studio"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1" />
    <userTask id="Task_A" name="审批">
      <extensionElements>
        <studio:parameters>
          <studio:inputParameter name="amount" type="number" expression="amount" />
          <studio:outputParameter name="approved" type="boolean" expression="approved" />
        </studio:parameters>
        <camunda:inputOutput>
          <camunda:inputParameter name="amount">amount</camunda:inputParameter>
          <camunda:outputParameter name="approved">approved</camunda:outputParameter>
        </camunda:inputOutput>
      </extensionElements>
    </userTask>
    <userTask id="Task_B" name="处理">
      <extensionElements>
        <studio:parameters>
          <studio:inputParameter name="approved" type="boolean" />
        </studio:parameters>
      </extensionElements>
    </userTask>
    <endEvent id="End_1" />
    <sequenceFlow id="Flow_1" sourceRef="Task_A" targetRef="Task_B">
      <conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">approved == true</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;

// --- descriptor 往返 ---
{
  const { rootElement } = await moddle.fromXML(FIXTURE);
  check('fromXML 解析成功（descriptor 合法）', !!rootElement);

  const process = rootElement.rootElements.find((r) => r.$type === 'bpmn:Process');
  const taskA = process.flowElements.find((f) => f.id === 'Task_A');
  const params = getStudioParams(taskA);
  check('Task_A 读取 studio:Parameters', !!params);
  check('入参读取（name/type/expression）',
    JSON.stringify(paramList(params, 'inputParameters')[0]) ===
    JSON.stringify({ name: 'amount', type: 'number', expression: 'amount', description: '' }),
    JSON.stringify(paramList(params, 'inputParameters')[0]));

  const { xml } = await moddle.toXML(rootElement);
  check('toXML 往返包含 <studio:parameters>', xml.includes('<studio:parameters>'));
  check('toXML 往返保留 camunda:inputOutput', xml.includes('camunda:inputOutput'));
  check('studio 命名空间声明存在', xml.includes('xmlns:studio="http://bpmn.studio/schema/studio"'));
}

// --- 同步编译命令 ---
{
  const { rootElement } = await moddle.fromXML(FIXTURE);
  const process = rootElement.rootElements.find((r) => r.$type === 'bpmn:Process');
  const taskA = process.flowElements.find((f) => f.id === 'Task_A');

  const fakeElement = { id: 'Task_A', businessObject: taskA };
  const factory = {
    create: (type, attrs) => moddle.create('camunda:InputOutput', attrs)
  };

  const next = [
    { name: 'approved', type: 'boolean', expression: 'approved' },
    { name: 'trace', type: 'string' }
  ];
  const commands = buildStudioWriteCommands(fakeElement, taskA, factory, 'outputParameters', next);

  const eeEnsure = commands.some((c) => c.context.properties && c.context.properties.extensionElements);
  const valuesCmd = commands.some((c) => c.context.properties && Array.isArray(c.context.properties.values));
  check('已有 EE/Parameters 时不重复创建', !eeEnsure, `commands=${commands.length}`);
  check('命令序列精简为 2 条', commands.length === 2, `实际 ${commands.length}`);
  check('第 1 条为 studio 列表更新（outputParameters 含新参）', commands[0].cmd === 'element.updateModdleProperties' &&
    commands[0].context.properties.outputParameters &&
    commands[0].context.properties.outputParameters.length === 2);
  check('第 2 条为 camunda:InputOutput 重建（values 替换）', commands[1].cmd === 'element.updateModdleProperties' &&
    valuesCmd);

  // 全新元素（无 extensionElements / 无 studio:Parameters）→ 4 条：EE + params + 列表 + 同步
  const freshBo = moddle.create('bpmn:UserTask', { id: 'Task_Fresh' });
  const freshEl = { id: 'Task_Fresh', businessObject: freshBo };
  const freshCommands = buildStudioWriteCommands(freshEl, freshBo, factory, 'inputParameters', [{ name: 'x', type: 'string' }]);
  check('全新元素命令序列 = 4 条（EE→params→列表→camunda 同步）', freshCommands.length === 4, `实际 ${freshCommands.length}`);
  check('首条创建 extensionElements', freshCommands[0].cmd === 'element.updateModdleProperties' &&
    freshCommands[0].context.properties.extensionElements);
  check('末条同步命令的 values 快照含 studio:Parameters + camunda:InputOutput',
    freshCommands[3].cmd === 'element.updateModdleProperties' &&
    freshCommands[3].context.properties.values.length === 2,
    `values=${freshCommands[3].context.properties.values.length}`);
}

// --- camunda 一致性判定（R4） ---
{
  const { rootElement } = await moddle.fromXML(FIXTURE);
  const process = rootElement.rootElements.find((r) => r.$type === 'bpmn:Process');
  const taskA = process.flowElements.find((f) => f.id === 'Task_A');
  const taskB = process.flowElements.find((f) => f.id === 'Task_B');
  check('Task_A studio 与 camunda 1:1 → 无漂移', camundaMatchesStudio(taskA) === true);
  check('Task_B 有 studio 无 camunda → 漂移（缺映射）', camundaMatchesStudio(taskB) === false);

  // 空表达式归一化：studio '' ↔ camunda 无 body 视为一致
  {
    const { rootElement: r2 } = await moddle.fromXML(FIXTURE);
    const p2 = r2.rootElements.find((r) => r.$type === 'bpmn:Process');
    const a2 = p2.flowElements.find((f) => f.id === 'Task_A');
    const io2 = a2.get('extensionElements').get('values').find((v) => v.$instanceOf('camunda:InputOutput'));
    io2.get('outputParameters')[0].value = undefined;
    const sp2 = a2.get('extensionElements').get('values').find((v) => v.$instanceOf('studio:Parameters'));
    sp2.get('outputParameters')[0].expression = '';
    check('空表达式归一化：studio "" ↔ camunda 无 body → 无漂移', camundaMatchesStudio(a2) === true);
  }
}

// --- 边参数投影 + 作用域目录 ---
{
  const { rootElement } = await moddle.fromXML(FIXTURE);
  const process = rootElement.rootElements.find((r) => r.$type === 'bpmn:Process');
  const taskA = process.flowElements.find((f) => f.id === 'Task_A');
  const taskB = process.flowElements.find((f) => f.id === 'Task_B');
  const flow = process.flowElements.find((f) => f.id === 'Flow_1');

  const projection = flowProjectionNames(taskA, taskB);
  check('投影 = A出参 ∩ B入参 = ["approved"]',
    JSON.stringify(projection) === JSON.stringify(['approved']), JSON.stringify(projection));

  const directory = resolveScopeVariablesFor(flow, process.flowElements);
  check('作用域目录含 A 出参 approved（带类型 boolean）',
    JSON.stringify(directory.find((v) => v.name === 'approved')) === JSON.stringify({ name: 'approved', type: 'boolean' }),
    JSON.stringify(directory));
}

// --- 检查规则（R1/R3/R6） ---
{
  const buildView = (rootElement) => {
    const process = rootElement.rootElements.find((r) => r.$type === 'bpmn:Process');
    const boById = (id) => process.flowElements.find((f) => f.id === id);
    return {
      view: {
        elements: process.flowElements.map((bo) => ({
          id: bo.id,
          bo,
          isConnection: bo.$type === 'bpmn:SequenceFlow',
          sourceBo: bo.sourceRef ? boById(bo.sourceRef.id) : null,
          targetBo: bo.targetRef ? boById(bo.targetRef.id) : null
        }))
      },
      flowBo: () => boById('Flow_1'),
      taskB: () => boById('Task_B')
    };
  };

  {
    const { view, flowBo } = buildView(await moddle.fromXML(FIXTURE).then((r) => r.rootElement));
    const issues = runStudioChecks(view);
    // 基线：approved 已声明、boolean → R1/R3 无
    check('R1：条件引用已声明变量 → 无 warn', !issues.some((i) => i.rule === 'R1'), JSON.stringify(issues.filter((i) => i.rule === 'R1')));
    check('R3：boolean 比较 → 无 warn', !issues.some((i) => i.rule === 'R3'));
    // approved 被 Flow_1 条件消费 → R6 无 approved
    check('R6：被条件消费的出参不报', !issues.some((i) => i.rule === 'R6' && /approved/.test(i.message)));
    // 未消费的入参不算出参；基线不应有 R6
    check('R6：基线无未消费出参', !issues.some((i) => i.rule === 'R6'), JSON.stringify(issues.filter((i) => i.rule === 'R6')));

    // R1：引用未声明变量
    flowBo().get('conditionExpression').body = 'unknown_var >= 5';
    const issues2 = runStudioChecks(view);
    check('R1：引用未声明变量 → warn', issues2.some((i) => i.rule === 'R1' && /unknown_var/.test(i.message)));

    // R3：string 类型变量参与数值比较（给 Task_B 补 string 出参）
    const taskB = buildView(await moddle.fromXML(FIXTURE).then((r) => r.rootElement)).taskB();
    const studioParams = taskB.get('extensionElements').get('values')
      .find((v) => v.$instanceOf('studio:Parameters'));
    const freshView = buildView(await moddle.fromXML(FIXTURE).then((r) => r.rootElement));
    const freshTaskB = freshView.taskB();
    const freshParams = freshTaskB.get('extensionElements').get('values')
      .find((v) => v.$instanceOf('studio:Parameters'));
    // 无法就地 create（无工厂），改用直接构造对象注入 view 的 bo 引用
    const labelOut = {
      $instanceOf: () => true,
      get: (k) => ({ name: 'label', type: 'string', expression: '' }[k])
    };
    void studioParams;
    freshParams.get('outputParameters').push(labelOut);
    freshView.flowBo().get('conditionExpression').body = 'label >= 5';
    const issues3 = runStudioChecks(freshView.view);
    check('R3：string 参与数值比较 → warn', issues3.some((i) => i.rule === 'R3' && /label/.test(i.message)), JSON.stringify(issues3.filter((i) => i.rule === 'R3')));
  }
}

// --- R1 标识符提取：根标识符 + EL 定界符 ---
{
  const ids = (s) => JSON.stringify(extractConditionIdentifiers(s));
  check('R1 提取：成员访问只取根标识符', ids("order.status == 'paid'") === JSON.stringify(['order']), ids("order.status == 'paid'"));
  check('R1 提取：${…} 保留内部标识符', ids('${amount > 100}') === JSON.stringify(['amount']), ids('${amount > 100}'));
  check('R1 提取：方法调用只取根标识符', ids('myVar.get("a") == 1') === JSON.stringify(['myVar']), ids('myVar.get("a") == 1'));
  check('R1 提取：函数调用保留函数名与实参', ids('a(b(c)) > 1') === JSON.stringify(['a', 'b', 'c']), ids('a(b(c)) > 1'));
  check('R1 提取：关键字与纯数字被过滤', ids('totalAmount >= 100') === JSON.stringify(['totalAmount']), ids('totalAmount >= 100'));
}

// 必须 process.exit —— 裸 finish() 会丢弃返回码，断言全挂时进程仍退出 0（静默绿灯）
process.exit(finish('studio-param-unit checks'));