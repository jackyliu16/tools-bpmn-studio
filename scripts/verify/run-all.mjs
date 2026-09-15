/**
 * run-all.mjs — 回归套件编排器（CI 与本地共用）。
 *
 * 为什么需要它：E2E 套件各自内建 `newestAppImage()`，只认 build-head.sh 的
 * 产物布局 `release/<dir>/electron/BPMN Studio.AppImage`；而 CI 里
 * electron-builder 把 AppImage 放在 `release/BPMN Studio-<ver>.AppImage`。
 * 因此由编排器统一递归定位 AppImage 并以 argv[2] 显式传给每套件。
 *
 * 另外两件事只有编排器能做：
 *   1. **显示号隔离** —— E2E 套件默认 DISPLAY 重号（:78/:79 被多个套件共用），
 *      同号 Xvfb 的 /tmp/.X<n>-lock 残留会互踩；这里为每个套件注入唯一
 *      VERIFY_DISPLAY（:91 起）。
 *   2. **顺序执行** —— 套件内部端口是硬编码常量且部分重号，并发必撞车。
 *
 * 套件清单是显式的，不扫描目录：scripts/diagnostics/ 下的一次性复现脚本
 * 没有断言、没有退出码，绝不能当门禁。
 *
 * 用法:
 *   node scripts/verify/run-all.mjs                 # = --all（需要 AppImage）
 *   node scripts/verify/run-all.mjs --pure          # 只跑不依赖 AppImage 的套件
 *   node scripts/verify/run-all.mjs --e2e
 *   node scripts/verify/run-all.mjs --appimage <path>
 *   node scripts/verify/run-all.mjs --only verify-zoom-dmn,verify-sprint3
 *   node scripts/verify/run-all.mjs --fail-fast --timeout 300
 *
 * 退出码：全部通过 0；任一失败或超时 1。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VERIFY_DIR = path.join(root, 'scripts', 'verify');
const LOG_DIR = path.join(root, 'verify-logs');

/** 门禁清单。kind: 'pure' 不需要显示器；runner: 'node' | 'vite-node' */
const SUITES = [
  { id: 'studio-param-unit', file: 'studio-param-unit.mjs', kind: 'pure', runner: 'node' },
  { id: 'verify-rule-docs', file: 'verify-rule-docs.mjs', kind: 'pure', runner: 'node' },
  { id: 'unit-render-units', file: 'unit-render-units.mjs', kind: 'pure', runner: 'node' },
  { id: 'verify-fix', file: 'verify-fix.mjs', kind: 'pure', runner: 'vite-node' },
  { id: 'verify-patch-e2e', file: 'verify-patch-e2e.mjs', kind: 'pure', runner: 'vite-node' },
  { id: 'verify-zoom-dmn', file: 'verify-zoom-dmn.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-dirty-guard', file: 'verify-dirty-guard.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-sprint3', file: 'verify-sprint3.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-control-panel', file: 'verify-control-panel.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-studio-params', file: 'verify-studio-params.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-topbar-narrow', file: 'verify-topbar-narrow.mjs', kind: 'e2e', runner: 'node' },
  { id: 'verify-doc-offline', file: 'verify-doc-offline.mjs', kind: 'e2e', runner: 'node' }
];

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    scope: 'all',
    appImage: null,
    only: null,
    failFast: false,
    timeoutSec: 180
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pure') opts.scope = 'pure';
    else if (a === '--e2e') opts.scope = 'e2e';
    else if (a === '--all') opts.scope = 'all';
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--appimage') opts.appImage = argv[++i];
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--timeout') opts.timeoutSec = Number(argv[++i]) || 180;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else {
      console.error(`未知参数: ${a}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node scripts/verify/run-all.mjs [选项]

  --all            全部套件（默认）
  --pure           只跑不需要 AppImage/显示器的套件
  --e2e            只跑 AppImage + Xvfb + CDP 套件
  --appimage <p>   显式指定 AppImage（默认递归搜索 release/**/*.AppImage 取最新）
  --only a,b       只跑指定 id
  --fail-fast      首个失败即停止
  --timeout <秒>   单套件超时（默认 180）

套件: ${SUITES.map((s) => `${s.id}[${s.kind}]`).join(', ')}`);
}

// --- AppImage 定位 -----------------------------------------------------------
function findAppImages(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findAppImages(p, out);
    else if (entry.isFile() && entry.name.endsWith('.AppImage')) out.push(p);
  }
  return out;
}

function newestAppImage() {
  const found = findAppImages(path.join(root, 'release'));
  if (!found.length) return null;
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}

// --- 执行 --------------------------------------------------------------------
function runSuite(suite, { appImage, display, timeoutSec }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    const args = [];
    let cmd;

    if (suite.kind === 'e2e') {
      cmd = process.execPath;
      if (display) env.VERIFY_DISPLAY = display;
      args.push(path.join(VERIFY_DIR, suite.file), appImage);
    } else if (suite.runner === 'vite-node') {
      const bin = path.join(root, 'node_modules', '.bin', 'vite-node');
      cmd = existsSync(bin) ? bin : 'npx';
      if (cmd !== bin) args.push('vite-node');
      args.push(path.join(VERIFY_DIR, suite.file));
    } else {
      cmd = process.execPath;
      args.push(path.join(VERIFY_DIR, suite.file));
    }

    const started = Date.now();
    const child = spawn(cmd, args, { cwd: root, env, detached: process.platform !== 'win32' });
    let out = '';
    let timedOut = false;
    // E2E 套件自己会再 spawn Xvfb/AppImage；只 kill 直接子进程会留下孤儿，
    // 占住 /tmp/.X<n>-lock 与 CDP 端口。detached 后按进程组整组杀。
    const killTree = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGKILL');
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ suite, code: 1, signal: null, out: `spawn 失败: ${err.message}`, ms: Date.now() - started, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ suite, code, signal, out, ms: Date.now() - started, timedOut });
    });
  });
}

/** 从输出里取最后一条 `N/M ... passed` 作为计数展示（缺失则为 null） */
function parseCount(out) {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(\d+)\s*\/\s*(\d+)\b/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  const m = out.match(/ALL (?:CHECKS )?PASSED \(?(\d+)/i);
  if (m) return `${m[1]}/${m[1]}`;
  return null;
}

function tail(text, n = 25) {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(LOG_DIR, { recursive: true });

  let suites = SUITES.filter((s) => opts.scope === 'all' || s.kind === opts.scope);
  if (opts.only) {
    const known = new Set(SUITES.map((s) => s.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length) {
      console.error(`--only 含未知套件 id: ${unknown.join(', ')}`);
      process.exit(2);
    }
    suites = SUITES.filter((s) => opts.only.includes(s.id));
  }
  if (!suites.length) {
    console.error('没有匹配的套件');
    process.exit(2);
  }

  const needsAppImage = suites.some((s) => s.kind === 'e2e');
  let appImage = opts.appImage || (needsAppImage ? newestAppImage() : null);
  if (needsAppImage && !appImage) {
    console.error('找不到 AppImage（release/**/*.AppImage）。先构建：./build-head.sh --electron --targets AppImage');
    console.error('或只跑纯逻辑套件：node scripts/verify/run-all.mjs --pure');
    process.exit(1);
  }
  if (appImage && !existsSync(appImage)) {
    console.error(`AppImage 不存在: ${appImage}`);
    process.exit(1);
  }

  console.log(`回归套件编排：${suites.length} 个（scope=${opts.scope}），单套件超时 ${opts.timeoutSec}s`);
  if (appImage) console.log(`AppImage: ${path.relative(root, appImage)}`);
  console.log('');

  const results = [];
  let e2eIndex = 0;

  for (const suite of suites) {
    const display = suite.kind === 'e2e' ? `:${90 + ++e2eIndex}` : null;
    process.stdout.write(`[${results.length + 1}/${suites.length}] ${suite.id} … `);
    const r = await runSuite(suite, { appImage, display, timeoutSec: opts.timeoutSec });
    const ok = !r.timedOut && r.code === 0;
    const count = parseCount(r.out);
    const secs = (r.ms / 1000).toFixed(1);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${count ? count + '  ' : ''}${secs}s${r.timedOut ? '  (超时被杀)' : ''}`);
    if (!ok && !opts.failFast) {
      console.log('  ── 输出尾部 ──');
      console.log(tail(r.out).split('\n').map((l) => '  ' + l).join('\n'));
    }

    writeFileSync(path.join(LOG_DIR, `${suite.id}.log`), r.out, 'utf-8');
    results.push({ suite, ok, count, ms: r.ms, timedOut: r.timedOut, code: r.code });

    if (!ok && opts.failFast) {
      console.log('\n--fail-fast：中止后续套件。');
      break;
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════ 汇总 ════════');
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.suite.id.padEnd(22)} ${(r.count || '-').padEnd(8)} ${(r.ms / 1000).toFixed(1)}s`
    );
  }
  const skipped = suites.length - results.length;
  console.log(
    `\n${results.length - failed.length}/${results.length} 套件通过` +
    (skipped ? `（${skipped} 个因 --fail-fast 未执行）` : '') +
    `；日志: verify-logs/`
  );
  if (failed.length) console.log(`失败套件: ${failed.map((r) => r.suite.id).join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`run-all 自身异常: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
