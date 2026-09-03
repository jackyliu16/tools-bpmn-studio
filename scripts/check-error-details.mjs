/**
 * check-error-details — 错误细节模块的纯 node 单元检查（无 DOM / 无 vite）。
 *
 * 覆盖：
 *  1. extractParseLocation / excerptLines（src/error-detail.js）
 *  2. describeFsError 中文映射
 *  3. RULE_LABELS 完备性（src/lint-l10n.js 覆盖 src/lint-config.js 全部 bundled 规则名）
 *  4. ruleInfo / elementTypeLabel / lintCategoryLabel 降级行为
 *
 * 用法: node scripts/check-error-details.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const {
  extractParseLocation,
  excerptLines,
  describeFsError
} = await import(path.join(root, 'src', 'error-detail.js'));

const {
  RULE_LABELS,
  ruleInfo,
  elementTypeLabel,
  lintCategoryLabel,
  ruleDocUrl
} = await import(path.join(root, 'src', 'lint-l10n.js'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 1. extractParseLocation ──────────────────────────────────────────────
{
  const err = new Error(
    'unparsable content <bpmn:definitions> detected\n\tline: 12\n\tcolumn: 5\n\tnested error: unexpected close tag'
  );
  const loc = extractParseLocation(err);
  check(
    'extractParseLocation: moddle message line/col',
    loc && loc.line === 12 && loc.column === 5,
    JSON.stringify(loc)
  );
}

{
  const err = new Error(
    'unparsable content <bpmn:process> detected\n\tline: 1\n\tcolumn: 1\n\tnested error: invalid tag\n\tline: 42\n\tcolumn: 17\n\tmore...'
  );
  const loc = extractParseLocation(err);
  check(
    'extractParseLocation: 取最深层 nested 的 line/col 对',
    loc && loc.line === 42 && loc.column === 17,
    JSON.stringify(loc)
  );
}

{
  const loc = extractParseLocation(new Error('boom without position'));
  check('extractParseLocation: 无位置 → null', loc === null, String(loc));
}

{
  const loc = extractParseLocation({ line: 7, column: 3, message: 'x' });
  check('extractParseLocation: 结构化字段优先', loc && loc.line === 7 && loc.column === 3, JSON.stringify(loc));
}

{
  check('extractParseLocation: null 输入 → null', extractParseLocation(null) === null);
}

// ── 2. excerptLines ─────────────────────────────────────────────────────
{
  const ex = excerptLines('a\nb\nc\nd\ne', 3, 1);
  check(
    'excerptLines: 中间窗口 + errIndex',
    ex && ex.lines.join('|') === 'b|c|d' && ex.errIndex === 1,
    JSON.stringify(ex)
  );
}

{
  const ex = excerptLines('x\ny', 1, 2);
  check(
    'excerptLines: 首行 clamp',
    ex && ex.lines.join('|') === 'x|y' && ex.errIndex === 0,
    JSON.stringify(ex)
  );
}

{
  const ex = excerptLines('x\ny', 99, 2);
  check(
    'excerptLines: 行号超出 EOF clamp 且 errIndex 不越界',
    ex && ex.lines.join('|') === 'x|y' && ex.errIndex === 1,
    JSON.stringify(ex)
  );
}

{
  check('excerptLines: 非法输入 → null', excerptLines(42, 1) === null);
  check('excerptLines: 空字符串安全', excerptLines('', 1) !== null);
}

// ── 3. describeFsError ──────────────────────────────────────────────────
{
  const d = describeFsError('ENOENT');
  check('describeFsError: ENOENT → 文件不存在', d.title === '文件不存在' && d.message.includes('不存在'), d.title);
}
{
  const d = describeFsError('ENOSPC');
  check('describeFsError: ENOSPC → 磁盘空间不足', d.title === '磁盘空间不足', d.title);
}
{
  const d = describeFsError('EACCES');
  check('describeFsError: EACCES → 没有访问权限', d.title === '没有访问权限' && d.suggestion.length > 0, d.title);
}
{
  const d = describeFsError('EZZZ', 'weird raw message');
  check(
    'describeFsError: 未知码兜底且保留原始消息',
    d.title === '文件操作失败' && d.message.includes('weird raw message'),
    d.title
  );
}

// ── 4. RULE_LABELS 完备性（对 lint-config.js 的 bundled 规则名）──────────────
{
  const source = readFileSync(path.join(root, 'src', 'lint-config.js'), 'utf-8');
  const bundled = new Set();
  const cacheRe = /cache\[\s*'([^']+)'\s*\]/g;
  let m;
  while ((m = cacheRe.exec(source))) {
    const full = m[1];
    const short = full.startsWith('bpmnlint-plugin-camunda/')
      ? 'camunda/' + full.slice('bpmnlint-plugin-camunda/'.length)
      : full.startsWith('bpmnlint/')
        ? full.slice('bpmnlint/'.length)
        : full;
    bundled.add(short);
  }
  const missing = [...bundled].filter((r) => !RULE_LABELS[r]);
  check(
    'RULE_LABELS 覆盖 lint-config.js 全部 bundled 规则',
    missing.length === 0,
    '缺少: ' + missing.join(', ')
  );
  check(
    'RULE_LABELS 条目形态（name + suggestion）',
    RULE_LABELS['label-required'] &&
      typeof RULE_LABELS['label-required'].name === 'string' &&
      typeof RULE_LABELS['label-required'].suggestion === 'string',
    'label-required 检查'
  );
  console.log(`   （bundled 规则数：${bundled.size}）`);
}

// ── 5. ruleInfo / elementTypeLabel / lintCategoryLabel 降级 ────────────────
{
  const info = ruleInfo('label-required');
  check(
    'ruleInfo: 已知规则返回中文名与建议',
    info.name.length > 0 && info.suggestion.length > 0 && info.docUrl.includes('label-required'),
    info.name
  );
}
{
  const info = ruleInfo('no-such-rule');
  check(
    'ruleInfo: 未知规则不抛错并兜底',
    info.name === 'no-such-rule' && info.suggestion.length > 0,
    info.name
  );
}
{
  check('ruleDocUrl: camunda 规则链接指向插件仓库', ruleDocUrl('camunda/implementation').includes('bpmnlint-plugin-camunda'));
  check('elementTypeLabel: bpmn:UserTask → 用户任务', elementTypeLabel('bpmn:UserTask') === '用户任务');
  check('elementTypeLabel: 未知类型剥离前缀', elementTypeLabel('bpmn:WeirdThing') === 'WeirdThing');
  check('lintCategoryLabel: error → 错误', lintCategoryLabel('error') === '错误');
  check('lintCategoryLabel: 未知级别原样返回', lintCategoryLabel('xx') === 'xx');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);