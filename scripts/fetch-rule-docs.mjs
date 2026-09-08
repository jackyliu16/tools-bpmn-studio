/**
 * fetch-rule-docs — 构建时从上游 GitHub 拉取全部校验规则的文档，写入 dist/docs/。
 *
 * 目的：内网 / 离线机器上「规则文档」可降级阅读构建时打包的最新版，而非依赖外网。
 * 文档不进仓库（dist/ 在 .gitignore），每次构建从 main 分支取最新。
 *
 * 路径约定（与 electron/doc-links.cjs 的 localDocRelPath 严格一致）：
 *   bpmnlint 规则  → dist/docs/rules/<rule>.md       （仓库 docs/rules/*.md）
 *   camunda 规则   → dist/docs/camunda/<rule>.js     （插件仓库 rules/*.js 源码，
 *                                                     规则文档即指向源码文件）
 *
 * 失败策略：单项 404/超时只计入缺失（对应规则在线链接仍是最终回退，见
 * electron/main.cjs openDocWithFallback）；必须失败时进程退出码仍为 0，
 * 由调用方（build-lib.sh）决定是否告警 —— 文档缺失不阻断发布。
 *
 * 用法:
 *   node scripts/fetch-rule-docs.mjs            # 拉取并写入 dist/docs/
 *   node scripts/fetch-rule-docs.mjs --check    # 拉取后断言完整性（可缺失项仅限已知无文档规则）
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import buffer from 'node:buffer';

import docLinks from '../electron/doc-links.cjs';
import { RULE_LABELS } from '../src/lint-l10n.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DOCS = path.join(root, 'dist', 'docs');
const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
const CONCURRENCY = 6; // raw.githubusercontent 高并发易被限流/超时，压低并发 + 重试

const BPMNLINT_RAW_BASE = 'https://raw.githubusercontent.com/bpmn-io/bpmnlint/main/docs/rules/';
const CAMUNDA_RAW_BASE = 'https://raw.githubusercontent.com/camunda/bpmnlint-plugin-camunda/main/rules/';

// 上游仓库确认没有独立文档的规则（拉取必 404）——--check 时豁免
const KNOWN_MISSING_DOCS = new Set(['global']);

/** 单条规则 → 去程 URL（与 ruleDocUrl 的 GitHub 页面同源同路径） */
function sourceUrlForRule(rule) {
  if (rule.startsWith('camunda/')) {
    return CAMUNDA_RAW_BASE + rule.slice('camunda/'.length) + '.js';
  }
  return BPMNLINT_RAW_BASE + rule + '.md';
}

/** 并发受限的 Promise.map（不引第三方依赖）*/
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const rules = Object.keys(RULE_LABELS).sort();
  await rm(DIST_DOCS, { recursive: true, force: true });
  await mkdir(DIST_DOCS, { recursive: true });

  const results = await mapLimit(rules, CONCURRENCY, async (rule) => {
      const rel = docLinks.localDocRelPath(rule);
      const url = sourceUrlForRule(rule);
      try {
        const text = await fetchText(url);
        const target = path.join(DIST_DOCS, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, 'utf-8');
        return { rule, ok: true, bytes: buffer.Buffer.byteLength(text) };
      } catch (err) {
        return { rule, ok: false, error: err.message };
      }
    }
  );

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const pct = ((ok.length / rules.length) * 100).toFixed(0);

  console.log(`规则文档: ${ok.length}/${rules.length} (${pct}%) 已获取，共 ${(totalBytes / 1024).toFixed(1)} KiB → dist/docs/`);
  for (const f of failed) {
    console.warn(`  ✗ ${f.rule}: ${f.error}（离线时该规则回退在线链接）`);
  }

  if (process.argv.includes('--check')) {
    const unexpected = failed.filter((f) => !KNOWN_MISSING_DOCS.has(f.rule));
    if (unexpected.length) {
      console.error(`--check 失败: 以下规则文档缺失且不在豁免清单: ${unexpected.map((f) => f.rule).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('--check 通过（缺失项均为已知无文档规则）');
    }
  }
}

main().catch((err) => {
  console.error(`fetch-rule-docs 失败: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});