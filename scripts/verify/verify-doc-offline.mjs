/**
 * verify-doc-offline — 规则文档离线降级 E2E（AppImage + Xvfb + CDP, no deps）。
 *
 * 场景：内网/断网环境点击 lint 面板「规则文档」。
 * BPMN_STUDIO_OFFLINE=1 强制探测失败（模拟不可达），断言：
 *   点击白名单文档链接 → 不弹系统浏览器 → 打开应用内离线文档窗口（data: HTML）
 *   → 文档内容为构建时打包的最新版（mdToHtml 渲染）。
 *
 * 用法: node scripts/verify/verify-doc-offline.mjs [path/to/AppImage]
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function newestAppImage() {
  const rel = path.join(root, 'release');
  const found = [];
  for (const dir of readdirSync(rel)) {
    const p = path.join(rel, dir, 'electron', 'BPMN Studio.AppImage');
    if (existsSync(p)) found.push(p);
  }
  if (!found.length) throw new Error('no AppImage found under release/ — run ./build-head.sh --electron --targets AppImage');
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}
const appimage = process.argv[2] || newestAppImage();
console.log('AppImage:', appimage);

const DISPLAY = process.env.VERIFY_DISPLAY || ':82';
const PORT = 9342;

const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const app = spawn(appimage, [
  '--appimage-extract-and-run',
  '--no-sandbox',
  '--disable-gpu',
  '--ozone-platform=x11',
  `--remote-debugging-port=${PORT}`
], { stdio: 'ignore', env: { ...process.env, DISPLAY, BPMN_STUDIO_DEBUG: '1', BPMN_STUDIO_OFFLINE: '1' } });

let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed++;
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}
async function waitForPage(retries = 80) {
  for (let i = 0; i < retries; i++) {
    const list = await targets().catch(() => []);
    const page = list.find((t) => t.type === 'page');
    if (page) return page.webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const wsUrl = await waitForPage();
if (!wsUrl) throw new Error('CDP page target never appeared');
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await evaluate(expr)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(250);
  }
}
// wait for the app shell
const booted = await waitFor(`!!(document.querySelector('#js-canvas svg') && document.querySelector('#btn-lint'))`);
check('app booted (canvas present)', booted);

// ── 离线降级：点击白名单文档链接 → 应用内离线文档窗口 ─────────────────
const DOC_URL = 'https://github.com/bpmn-io/bpmnlint/blob/main/docs/rules/label-required.md';
const injected = await evaluate(`(() => {
  const a = document.createElement('a');
  a.href = ${JSON.stringify(DOC_URL)};
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = '规则文档';
  document.body.appendChild(a);
  a.click();
  return true;
})()`);
check('注入白名单文档链接并点击', injected === true);

// 主进程 ODFFLINE=1：探测失败 → 应打开本地文档窗口（新 page target, data: HTML）
let docTarget = null;
for (let i = 0; i < 60 && !docTarget; i++) {
  const list = await targets().catch(() => []);
  docTarget = list.find((t) => t.type === 'page' && t.title.includes('label-required — 离线文档'));
  if (!docTarget) await sleep(500);
}
check('离线降级：出现本地文档窗口', !!docTarget,
  docTarget ? docTarget.title : '未找到 title=label-required — 离线文档 的 target');

if (docTarget) {
  const ws2 = new WebSocket(docTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
  let id2 = 0;
  const pend2 = new Map();
  ws2.onmessage = (e2) => {
    const m2 = JSON.parse(e2.data);
    if (m2.id && pend2.has(m2.id)) { pend2.get(m2.id)(m2); pend2.delete(m2.id); }
  };
  const send2 = (method, params = {}) => {
    const id = ++id2;
    ws2.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pend2.set(id, res));
  };
  const eval2 = async (expression) => {
    const r = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  let h1 = '';
  for (let i = 0; i < 40 && !h1; i++) {
    h1 = (await eval2(`document.querySelector('h1')?.textContent || ''`)) || '';
    if (!h1) await sleep(250);
  }
  check('离线文档窗口渲染 h1（mdToHtml）', /Label Required/.test(h1), `h1=${h1 || '(empty)'}`);

  const codeBlock = await eval2(`!!document.querySelector('pre code')`);
  check('离线文档窗口含 XML 示例代码块', codeBlock === true);

  const unsafe = await eval2(`!!document.querySelector('img')`);
  check('离线文档窗口无外部图片加载', unsafe === false);

  ws2.close();
}

// ── 收尾 ────────────────────────────────────────────────────────────────
ws.close();
app.kill();
xvfb.kill();
console.log('\n' + results.join('\n'));
console.log(`${results.length - failed}/${results.length} verify-doc-offline checks passed`);
process.exit(failed ? 1 : 0);
