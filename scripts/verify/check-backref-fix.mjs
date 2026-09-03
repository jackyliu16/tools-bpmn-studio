/**
 * Verify root cause: manually populate FlowNode.incoming/outgoing
 * back-references after parsing, then lint. If the 7 false-positive
 * errors disappear, the root cause is confirmed as missing back-refs.
 *
 * Usage: npx vite-node scripts/check-backref-fix.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 仓库根（本脚本位于 scripts/verify/ 下，向上三级）
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { BpmnModdle } = await import('bpmn-moddle');
const { Reader: ModdleXmlReader } = await import('moddle-xml');
const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));

// bpmnlint/lib/linter.js is CJS — load via createRequire
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LinterCjs = require('bpmnlint/lib/linter.js');

const xml = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');
const model = new BpmnModdle();
const parser = new ModdleXmlReader(model);
const { rootElement } = await parser.fromXML(xml, 'bpmn:Definitions');

const proc = rootElement.rootElements.find(r => r.$type === 'bpmn:Process');

function populateBackRefs(container) {
  // reset
  for (const fe of container.flowElements || []) {
    if (fe.incoming !== undefined) fe.incoming = undefined;
    if (fe.outgoing !== undefined) fe.outgoing = undefined;
  }
  for (const fe of container.flowElements || []) {
    if (fe.$type === 'bpmn:SequenceFlow' || fe.$type === 'bpmn:MessageFlow') {
      const source = typeof fe.sourceRef === 'string' ? container.flowElements.find(e => e.id === fe.sourceRef) : fe.sourceRef;
      const target = typeof fe.targetRef === 'string' ? container.flowElements.find(e => e.id === fe.targetRef) : fe.targetRef;
      if (source && typeof source.outgoing === 'undefined') source.outgoing = [];
      if (target && typeof target.incoming === 'undefined') target.incoming = [];
      if (source) source.outgoing.push(fe);
      if (target) target.incoming.push(fe);
    }
  }
}

// NOTE: rules are cached per Linter instance with closure state,
// so each lint run must use a FRESH Linter.
async function lintAndPrint(label) {
  const linter = new LinterCjs({ resolver: lintConfig.resolver, config: lintConfig.config });
  const results = await linter.lint(rootElement);
  console.log(`\n=== ${label} ===`);
  let count = 0;
  for (const [rule, reports] of Object.entries(results)) {
    for (const r of reports) {
      count++;
      console.log(`  ${r.id || '(root)'} [${rule}]: ${r.message}`);
    }
  }
  if (!count) console.log('  (no issues)');
  return count;
}

await lintAndPrint('BEFORE back-ref fix (raw parse)');
populateBackRefs(proc);
await lintAndPrint('AFTER back-ref fix (incoming/outgoing populated)');
