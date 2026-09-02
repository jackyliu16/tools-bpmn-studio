/**
 * Plain node (no vite-node) verification of the back-ref issue.
 * Usage: node scripts/plain-node-check.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { BpmnModdle } = await import('bpmn-moddle');
const { Reader: ModdleXmlReader } = await import('moddle-xml');

const xml = readFileSync(path.join(root, 'resources', 'newDiagram.bpmn'), 'utf-8');
const model = new BpmnModdle();
const { rootElement } = await new ModdleXmlReader(model).fromXML(xml, 'bpmn:Definitions');

const proc = rootElement.rootElements.find(r => r.$type === 'bpmn:Process');
const se = proc.flowElements.find(f => f.id === 'StartEvent_1');
const act = proc.flowElements.find(f => f.id === 'Activity_1');

console.log('StartEvent_1.incoming:', se.incoming);
console.log('StartEvent_1.outgoing:', se.outgoing);
console.log('Activity_1.incoming:', act.incoming);
console.log('Activity_1.outgoing:', act.outgoing);

// Now lint with the project's packed config
const LinterCjs = require('bpmnlint/lib/linter.js');
const { default: lintConfig } = await import(path.join(root, 'src', 'lint-config.js'));
const linter = new LinterCjs({ resolver: lintConfig.resolver, config: lintConfig.config });
const results = await linter.lint(rootElement);
let n = 0;
for (const [rule, reports] of Object.entries(results)) {
  for (const r of reports) { n++; console.log(`LINT  ${r.id || '(root)'} [${rule}]: ${r.message}`); }
}
console.log(n ? `=> ${n} issues (FALSE POSITIVES)` : '=> no issues');
