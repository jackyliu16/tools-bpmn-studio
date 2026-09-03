# Upstream report — connectivity lint rules produce false positives when `FlowNode.incoming`/`outgoing` are not present in the XML

> Draft for filing against `bpmn-io/bpmnlint` (cc `bpmn-io/bpmn-js-bpmnlint`, `bpmn-io/moddle-xml`).
> Verified locally with the exact versions listed below, using both the bpmnlint CLI
> and a minimal bpmn-js modeler. Evidence scripts: `scripts/verify/plain-node-check.mjs`,
> `scripts/verify/check-backref-fix.mjs`.

## TL;DR

Since the moddle 8 / moddle-xml 12 / bpmn-moddle 10 generation, `Reader.fromXML()`
does **not** populate the derived back-references `FlowNode.incoming` /
`FlowNode.outgoing`. They stay `undefined` on every element whose XML omits the
optional `<bpmn:incoming>` / `<bpmn:outgoing>` elements — which is how essentially
all real-world files are serialized (Camunda Modeler, bpmn.io, … only write
`sourceRef`/`targetRef`).

Every connectivity rule that reads `node.incoming` / `node.outgoing`
(`no-disconnected`, `no-implicit-start`, `no-implicit-end` — all part of
`bpmnlint:recommended`) therefore reports a **false positive on every flow node of
every diagram**. A minimal valid start → task → end diagram yields 7 errors.

## Versions (all current at time of writing)

- `bpmnlint` 11.13.0
- `bpmn-moddle` 10.2.0
- `moddle` 8.2.1
- `moddle-xml` 12.2.0
- `bpmn-js` 18.25.1 + `bpmn-js-bpmnlint` 0.24.0 (consumer in the app)

## Reproduction 1 — bpmnlint CLI

Minimal valid file (`sample.bpmn`, note: no `<bpmn:incoming>` elements, only
`sourceRef`/`targetRef`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="开始"/>
    <bpmn:task id="Activity_1" name="办理任务"/>
    <bpmn:endEvent id="EndEvent_1" name="结束"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Activity_1"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Activity_1" targetRef="EndEvent_1"/>
  </bpmn:process>
</bpmn:definitions>
```

With a minimal config (`lintrc.json`):

```json
{
  "rules": {
    "no-disconnected": "error",
    "no-implicit-start": "error",
    "no-implicit-end": "error"
  }
}
```

```
$ npx bpmnlint -c lintrc.json sample.bpmn
  StartEvent_1  error  Element is not connected      no-disconnected
  Activity_1    error  Element is not connected      no-disconnected
  EndEvent_1    error  Element is not connected      no-disconnected
  Activity_1    error  Element is an implicit start  no-implicit-start
  EndEvent_1    error  Element is an implicit start  no-implicit-start
  StartEvent_1  error  Element is an implicit end    no-implicit-end
  Activity_1    error  Element is an implicit end    no-implicit-end
✖ 7 problems (7 errors, 0 warnings)
```

All three elements are connected — every report above is a false positive.

## Reproduction 2 — root cause isolated

Plain Node, no bpmn-js:

```js
const { BpmnModdle } = await import('bpmn-moddle');
const { Reader } = await import('moddle-xml');
const { rootElement } = await new Reader(new BpmnModdle())
  .fromXML(sampleXml, 'bpmn:Definitions');

const se = rootElement.rootElements[0].flowElements.find(e => e.id === 'StartEvent_1');
console.log(se.incoming);  // undefined  (expected: [] or [Flow_1]… i.e. derived)
console.log(se.outgoing);  // undefined  (expected: [Flow_1])
```

`moddle-xml`'s `resolveReferences()` only resolves references that are present in
the XML (attribute refs like `sourceRef`, or explicit `<bpmn:incoming>` elements).
`FlowNode.incoming`/`outgoing` are never in the XML of real files, so they are
never collected and never derived.

## Why the rule tests do not catch this

The rule test fixtures explicitly serialize the derived elements, e.g.
`test/rules/no-disconnected/valid.bpmn`:

```xml
<bpmn:task id="Element_1">
  <bpmn:incoming>Flow_1</bpmn:incoming>
  <bpmn:outgoing>Flow_2</bpmn:outgoing>
</bpmn:task>
```

So the tests exercise exactly the serialization that real exporters do **not**
produce.

## Impact

- `bpmnlint` CLI: every file without explicit `incoming`/`outgoing` elements is
  flooded with `no-disconnected` / `no-implicit-start` / `no-implicit-end` errors.
- `bpmn-js-bpmnlint`: the same false-positive overlays appear on every node of
  every diagram opened in the modeler (observed in a bpmn-js 18.25.1 app).

## Suggested fixes (any of)

1. **moddle-xml**: after `resolveReferences()`, re-derive `FlowNode.incoming` /
   `FlowNode.outgoing` (and any other derived collection) from the resolved
   `sourceRef`/`targetRef` references.
2. **bpmnlint rules**: make the connectivity rules compute connectivity from
   `sourceRef`/`targetRef` (which are always resolved) instead of relying on the
   back-references being populated.
3. **bpmnlint fixtures**: add test fixtures serialized the way real exporters do
   (no explicit `<bpmn:incoming>` elements) so this class of regression is caught.

## Consumer-side workaround (implemented in bpmn-studio)

After `import.parse.complete` (and on `elements.changed`), rebuild
`incoming`/`outgoing` per container from `sourceRef`/`targetRef`:

```js
function rebuildFlowNodeBackrefs(definitions) {
  const rebuildContainer = (container) => {
    const flowElements = container.flowElements || [];
    for (const fe of flowElements) {
      if (fe.$instanceOf && fe.$instanceOf('bpmn:FlowNode')) {
        fe.incoming = [];
        fe.outgoing = [];
      }
    }
    for (const fe of flowElements) {
      if (fe.$type !== 'bpmn:SequenceFlow' && fe.$type !== 'bpmn:MessageFlow') continue;
      if (fe.sourceRef && Array.isArray(fe.sourceRef.outgoing)) fe.sourceRef.outgoing.push(fe);
      if (fe.targetRef && Array.isArray(fe.targetRef.incoming)) fe.targetRef.incoming.push(fe);
    }
    for (const fe of flowElements) {
      if (fe.flowElements) rebuildContainer(fe);
    }
  };
  for (const re of definitions.rootElements || []) {
    if (re.processRef) rebuildContainer(re.processRef);
    else if (re.$type === 'bpmn:Process') rebuildContainer(re);
  }
}
```

Verified: with the back-references populated, all 7 false positives disappear,
while genuinely disconnected / implicit start/end elements are **still**
reported (see `scripts/verify/verify-fix.mjs`).
