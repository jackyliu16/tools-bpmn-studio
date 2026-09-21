/**
 * doc-links — 「规则文档」外链/内链路由与渲染的共享纯逻辑。
 *
 * 被三端复用：
 *   - electron/main.cjs（主进程 require）：点击白名单、在线探测、离线本地文档窗口
 *   - src/main.js（渲染进程，经 vite 内联 import）：浏览器版在线/离线降级
 *   - scripts/fetch-rule-docs.mjs 与 verify 脚本（Node require）：路径一致性
 *
 * 依赖面刻意为零（无 electron / 无 DOM / 无 node:fs），保证每条路径都能
 * 用同一份实现做断言，避免三端推导分叉。
 */

'use strict';

// 在线文档的合法前缀（与 scripts/fetch-rule-docs.mjs 的拉取地址一一对应）。
// 其它 host / 协议一律视为「非文档外链」——M10 导航守卫的例外面收窄到这两条路径。
const BPMNLINT_GITHUB_PATH = '/bpmn-io/bpmnlint/blob/main/docs/rules/';
const CAMUNDA_GITHUB_PATH = '/camunda/bpmnlint-plugin-camunda/tree/main/rules/';

/**
 * URL 是否属于「规则文档」白名单外链（https://github.com 且命中两条文档路径）。
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isAllowedGithubDocUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      (u.pathname.startsWith(BPMNLINT_GITHUB_PATH) || u.pathname.startsWith(CAMUNDA_GITHUB_PATH));
  } catch {
    return false;
  }
}

/**
 * GitHub 文档 URL → 打包内本地文档相对路径（dist/docs/ 之下）。
 *
 * @param {string} rawUrl
 * @returns {string|null} 'rules/<rule>.md' | 'camunda/<rule>.js'；非白名单返回 null
 */
function githubToLocalRel(rawUrl) {
  if (!isAllowedGithubDocUrl(rawUrl)) return null;
  const u = new URL(rawUrl);
  if (u.pathname.startsWith(BPMNLINT_GITHUB_PATH)) {
    return 'rules/' + u.pathname.slice(BPMNLINT_GITHUB_PATH.length);
  }
  return 'camunda/' + u.pathname.slice(CAMUNDA_GITHUB_PATH.length);
}

/**
 * 规则名 → 打包内本地文档相对路径（与 scripts/fetch-rule-docs.mjs 落盘路径一致）。
 *
 * @param {string} rule bpmnlint 规则名，如 'label-required' 或 'camunda/implementation'
 * @returns {string}
 */
function localDocRelPath(rule) {
  if (typeof rule !== 'string') return '';
  if (rule.startsWith('camunda/')) {
    return 'camunda/' + rule.slice('camunda/'.length) + '.js';
  }
  return 'rules/' + rule + '.md';
}

/**
 * 打包内本地文档相对路径 → GitHub 原始文档 URL。
 * 在线环境仍优先打开原始地址（与 lint-l10n.js ruleDocUrl 同构）。
 *
 * @param {string} rel
 * @returns {string|null}
 */
function relToGithubUrl(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.startsWith('camunda/')) {
    return `https://github.com/camunda/bpmnlint-plugin-camunda/tree/main/rules/${rel.slice('camunda/'.length)}`;
  }
  if (rel.startsWith('rules/')) {
    return `https://github.com/bpmn-io/bpmnlint/blob/main/docs/${rel}`;
  }
  return null;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 行内标记：code / 加粗 / 图片降级为占位（离线不加载）/ 链接只留文本。输入须已转义。 */
function inlineMarkup(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '<em>[图: $1]</em>')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * 极简 Markdown → 安全 HTML（离线文档阅读用）。
 *
 * 覆盖规则文档实际用到的结构：`#`/`##`/`###` 标题、``` 代码块、`-` 列表、
 * 段落、行内 `code`/`**bold**`、链接与图片（图片降级为占位文本，避免离线下
 * 加载外部资源）。先整段 HTML 转义再套标记，杜绝注入。
 *
 * @param {string} md
 * @returns {string}
 */
function mdToHtml(md) {
  if (typeof md !== 'string') return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  const codeBuf = [];
  let para = [];
  const listBuf = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMarkup(escapeHtml(para.join(' ')))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      out.push('<ul>' + listBuf.map((x) => `<li>${inlineMarkup(escapeHtml(x))}</li>`).join('') + '</ul>');
      listBuf.length = 0;
    }
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) {
        out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
        codeBuf.length = 0;
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const heading = raw.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkup(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      flushPara();
      listBuf.push(raw.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (/^\s*$/.test(raw)) {
      flushAll();
      continue;
    }
    flushList();
    para.push(raw.trim());
  }
  if (inCode) {
    out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); // 未闭合容错
  }
  flushAll();
  return out.join('\n');
}

/**
 * 在线探测端点（Fix F，三端单点维护）：raw/api 域直连可达性通常优于 github.com 主页
 * （例如本仓库构建机：shell 层代理仅覆盖 curl，undici/Chromium 直连 github.com 超时，
 * 但 raw 域可达）。多端点并行竞速，任一可达即判定在线，避免单端点误判。
 * 供 electron/main.cjs（主进程）与 src/main.js（浏览器版）共用。
 */
const DOC_PROBE_URLS = [
  'https://github.com',
  'https://raw.githubusercontent.com',
  'https://api.github.com'
];

module.exports = {
  isAllowedGithubDocUrl,
  githubToLocalRel,
  localDocRelPath,
  relToGithubUrl,
  mdToHtml,
  DOC_PROBE_URLS,
  BPMNLINT_GITHUB_PATH,
  CAMUNDA_GITHUB_PATH
};