/**
 * verify-rule-docs — 「规则文档」路由与离线降级的纯 node 回归检查（无浏览器/CDP）。
 *
 * 覆盖：
 *  1. electron/doc-links.cjs 白名单判定（http/非 github/越界路径一律拒绝）
 *  2. GitHub URL ↔ 本地相对路径双向推导（与 fetch-rule-docs 落盘一致）
 *  3. mdToHtml 的安全转义与结构输出（标题/代码块/图片降级/链接剥除）
 *  4. dist/docs/ 完备性：若已由 fetch-rule-docs 生成，断言覆盖全部规则
 *     （已知无文档豁免：global）；未生成则提示先跑构建/拉取脚本（不 fail）
 *
 * 用法: node scripts/verify/verify-rule-docs.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

import docLinks from '../../electron/doc-links.cjs';
import { RULE_LABELS } from '../../src/lint-l10n.js';
import { createTester } from '../lib/testkit.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { check, finish } = createTester();

// ── 1. 白名单判定 ──────────────────────────────────────────────────────
{
  const okUrls = [
    'https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md',
    'https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/ad-hoc-sub-process.md',
    'https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/implementation.js',
    'https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/forking-conditions.js'
  ];
  const badUrls = [
    'http://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/x.md',        // 非 https
    'https://github.com/evil/bpmnlint/blob/main/docs/rules/x.md',          // 其它仓库
    'https://github.com/bpmn-io/bpmnlint',                                 // 路径越界（根）
    'https://github.com/bpmn-io/bpmnlint/blob/main/README.md',             // 非 docs/rules
    'https://evil.example.com/bpmn-io/bpmnlint/blob/main/docs/rules/x.md', // 其它 host
    'file:///etc/passwd',                                                  // 非 http
    'not a url',                                                           // 非法
    null,
    42
  ];
  check('白名单放行 4 个合法文档 URL', okUrls.every((u) => docLinks.isAllowedGithubDocUrl(u)));
  check('白名单拒绝 9 个越界/伪造 URL', badUrls.every((u) => !docLinks.isAllowedGithubDocUrl(u)));
}

// ── 2. URL ↔ 本地相对路径推导（与 fetch-rule-docs.mjs 同构）─────────────
{
  const cases = [
    ['https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md', 'rules/label-required.md'],
    ['https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/no-overlapping-elements.md', 'rules/no-overlapping-elements.md'],
    ['https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/implementation.js', 'camunda/implementation.js'],
    ['https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/avoid-lanes.js', 'camunda/avoid-lanes.js']
  ];
  check(
    'githubToLocalRel 推导 4 例',
    cases.every(([url, rel]) => docLinks.githubToLocalRel(url) === rel)
  );
  check('githubToLocalRel 拒绝非白名单', docLinks.githubToLocalRel('https://github.com/other/x') === null);

  const ruleCases = ['label-required', 'camunda/implementation', 'single-event-definition'];
  check(
    'localDocRelPath 与 fetch-rule-docs 落盘路径一致',
    ruleCases.every((r) =>
      docLinks.localDocRelPath(r) === (r.startsWith('camunda/') ? `camunda/${r.slice(8)}.js` : `rules/${r}.md`)
    )
  );
  check(
    'relToGithubUrl 与 githubToLocalRel 往返',
    cases.every(([url, rel]) => docLinks.relToGithubUrl(rel) === url)
  );
}

// ── 3. mdToHtml 安全与结构 ──────────────────────────────────────────────
{
  const md = [
    '# Label Required (label-required)',
    '',
    'Checks <b>escape</b> & keep text.',
    '',
    '```xml',
    '<bpmn:task id="Task_1" />',
    '```',
    '',
    'Example of __incorrect__ usage:',
    '',
    '![Incorrect example](./examples/label-required-incorrect.png)',
    '',
    '- item one',
    '- item two',
    '',
    'See [details](./examples/example.bpmn).',
    ''
  ].join('\n');

  const html = docLinks.mdToHtml(md);
  check('mdToHtml 输出标题', /<h1>Label Required \(label-required\)<\/h1>/.test(html), '含 <h1>');
  check('mdToHtml 转义原文中的 <b>', html.includes('&lt;b&gt;') && !html.includes('<b>escape</b>'), '不注入原始标签');
  check('mdToHtml 输出代码块', /<pre><code>/.test(html) && html.includes('&lt;bpmn:task id='), 'XML 示例进 <pre><code>');
  check('mdToHtml 图片降级为占位', /<em>\[图: Incorrect example\]<\/em>/.test(html), '不加载外部图片');
  check('mdToHtml 列表转为 <ul>/<li>', (html.match(/<li>/g) || []).length >= 2, '两个列表项');
  check('mdToHtml 链接剥除只留文本', html.includes('See details.') && !html.includes('<a href='), '不产生外部跳转');
}

// ── 4. dist/docs/ 完备性（存在才断言）────────────────────────────────────
{
  const docsDir = path.join(root, 'dist', 'docs');
  if (!existsSync(docsDir)) {
    console.log('\n[SKIP] dist/docs/ 不存在 — 先运行 `npm run build` 或 `node scripts/fetch-rule-docs.mjs` 再核查完备性');
  } else {
    const rulesDir = path.join(docsDir, 'rules');
    const camundaDir = path.join(docsDir, 'camunda');
    const rulesFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith('.md')) : [];
    const camundaFiles = existsSync(camundaDir) ? readdirSync(camundaDir).filter((f) => f.endsWith('.js')) : [];

    const missing = Object.keys(RULE_LABELS).filter((rule) => {
      const rel = docLinks.localDocRelPath(rule);
      const file = rel.startsWith('camunda/') ? rel.slice('camunda/'.length) : rel.slice('rules/'.length);
      const inDir = rule.startsWith('camunda/') ? camundaFiles : rulesFiles;
      return !inDir.includes(file);
    });

    const knownMissing = ['global']; // 上游仓库无独立文档
    const unexpected = missing.filter((r) => !knownMissing.includes(r));
    check(
      `dist/docs/ 覆盖全部规则（豁免 ${knownMissing.join(', ')}）`,
      unexpected.length === 0,
      missing.length ? `缺失: ${missing.join(', ')}` : `共 ${rulesFiles.length} md + ${camundaFiles.length} js`
    );
  }
}

process.exit(finish('verify-rule-docs checks'));
