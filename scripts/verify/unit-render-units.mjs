/**
 * unit-render-units — 纯逻辑单元测试（node，无 DOM，无需 AppImage）。
 *
 * 存在的意义：`src/main.js` 的渐进抽取（M1–M4）只靠 CDP 黑盒回归不足以保证等价性。
 * 这里对**搬迁出来的纯函数**做直接断言，重构时能立刻定位行为漂移，而不是等到
 * 端到端现象出现。新增抽取出来的纯函数请在此登记。
 *
 * 当前覆盖：
 *   - electron/doc-links.cjs —— 极简 Markdown → HTML（安全敏感：注入面）+ 文档白名单
 *
 * 随抽取阶段扩展（见 PLAN S5/S7）：
 *   - src/ui/xml-view.js   —— escapeHtml / highlightXml / findElementSpans
 *   - src/diagnostics.js   —— formatDiagnostics
 */
import { createRequire } from 'node:module';

import { createTester } from '../lib/testkit.mjs';

const require = createRequire(import.meta.url);
const docLinks = require('../../electron/doc-links.cjs');

const { check, finish } = createTester();

// ── electron/doc-links.cjs :: mdToHtml ───────────────────────────────────────
{
  const h = docLinks.mdToHtml;

  check('mdToHtml: 非字符串输入返回空串', h(null) === '' && h(undefined) === '');
  check('mdToHtml: # 标题 → h1', /<h1>Title<\/h1>/.test(h('# Title')));
  check('mdToHtml: ## / ### 标题层级正确', /<h2>B<\/h2>/.test(h('## B')) && /<h3>C<\/h3>/.test(h('### C')));
  check('mdToHtml: 段落包 <p>', /<p>hello world<\/p>/.test(h('hello\nworld')));

  const code = h('```\nconst a = 1 < 2;\n```');
  check('mdToHtml: 代码块 → <pre><code> 且内容被转义', /<pre><code>/.test(code) && code.includes('&lt;') && !code.includes('1 < 2'));

  const list = h('- one\n- two');
  check('mdToHtml: 列表 → ul/li', /<ul><li>one<\/li><li>two<\/li><\/ul>/.test(list));

  check('mdToHtml: 行内 code', h('use `foo()` here').includes('<code>foo()</code>'));
  check('mdToHtml: 加粗', h('a **bold** b').includes('<strong>bold</strong>'));

  const img = h('![alt text](https://evil.example/x.png)');
  check('mdToHtml: 图片降级为占位文本（不产生 <img>）', !/<img/.test(img) && img.includes('[图: alt text]'));

  const link = h('[click me](https://evil.example)');
  check('mdToHtml: 链接剥除只留文本（不产生 <a href>）', !/<a[\s>]/.test(link) && link.includes('click me'));

  const crlf = h('# A\r\n\r\npara');
  check('mdToHtml: CRLF 归一化', /<h1>A<\/h1>/.test(crlf) && /<p>para<\/p>/.test(crlf));

  // ── 注入面（安全敏感）────────────────────────────────────────────────────
  const script = h('<script>alert(1)</script>');
  check('mdToHtml: <script> 被转义，不产生可执行标签', !/<script/i.test(script) && script.includes('&lt;script&gt;'));

  const attrBreak = h('text " onmouseover="alert(1)" x="');
  check('mdToHtml: 引号属性逃逸尝试不产生事件处理器', !/<[a-z]+[^>]*\sonmouseover/i.test(attrBreak));

  const htmlBlock = h('<img src=x onerror=alert(1)>');
  check('mdToHtml: 原始 HTML 标签一律转义（不产生真实标签）', !/<img/i.test(htmlBlock) && htmlBlock.includes('&lt;img'));

  const unclosed = h('```\ndangling code');
  check('mdToHtml: 未闭合代码块容错（仍产出 pre）', /<pre><code>dangling code<\/code><\/pre>/.test(unclosed));

  const headingInject = h('# <b>x</b>');
  check('mdToHtml: 标题内的 HTML 也被转义', !/<b>/.test(headingInject) && headingInject.includes('&lt;b&gt;'));
}

// ── electron/doc-links.cjs :: URL 白名单 ─────────────────────────────────────
{
  const ok = docLinks.isAllowedGithubDocUrl;

  check('白名单: bpmnlint 规则文档路径 → 允许',
    ok('https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md') === true);
  check('白名单: camunda 规则文档路径 → 允许',
    ok('https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/implementation.js') === true);
  check('白名单: 前缀伪装域名 github.com.evil.com → 拒绝',
    ok('https://github.com.evil.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md') === false);
  check('白名单: http 降级 → 拒绝',
    ok('http://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md') === false);
  check('白名单: 非文档的 github 路径 → 拒绝', ok('https://github.com/bpmn-io/bpmnlint/issues/1') === false);
  check('白名单: 非字符串 → 拒绝', ok(null) === false && ok(123) === false);
  check('白名单: 非法 URL 字符串 → 拒绝', ok('not a url') === false);
}

// ── electron/doc-links.cjs :: 路径映射 ───────────────────────────────────────
{
  check('localDocRelPath: bpmnlint 规则 → rules/<rule>.md',
    docLinks.localDocRelPath('label-required') === 'rules/label-required.md');
  check('localDocRelPath: camunda 规则 → camunda/<rule>.js',
    docLinks.localDocRelPath('camunda/implementation') === 'camunda/implementation.js');
  check('localDocRelPath: 非字符串 → 空串', docLinks.localDocRelPath(null) === '');

  const bpmnUrl = 'https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md';
  check('githubToLocalRel: bpmnlint URL → 本地相对路径',
    docLinks.githubToLocalRel(bpmnUrl) === 'rules/label-required.md');

  const camundaUrl = 'https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/implementation.js';
  check('githubToLocalRel: camunda URL → 本地相对路径',
    docLinks.githubToLocalRel(camundaUrl) === 'camunda/implementation.js');

  check('githubToLocalRel: 非白名单 URL → null',
    docLinks.githubToLocalRel('https://evil.example/x') === null);

  check('relToGithubUrl: rules/ → bpmnlint blob 地址',
    docLinks.relToGithubUrl('rules/label-required.md') === bpmnUrl);
  check('relToGithubUrl: camunda/ → 插件 tree 地址',
    docLinks.relToGithubUrl('camunda/implementation.js') === camundaUrl);
  check('relToGithubUrl: 未知前缀 → null', docLinks.relToGithubUrl('other/x.md') === null);
  check('relToGithubUrl: 空输入 → null', docLinks.relToGithubUrl('') === null && docLinks.relToGithubUrl(null) === null);
}

process.exit(finish('unit-render-units checks'));
