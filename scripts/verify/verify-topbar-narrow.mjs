/**
 * Runtime verification (AppImage + Xvfb + CDP, no deps):
 *   Tiered topbar compression (src/style.css @media rules, thresholds based on
 *   measured content width ≈1240px with brand / ≈1144px without):
 *     ≤1240px  brand hidden
 *     ≤1160px  compact .tool + 新建 BPMN / 新建 DMN hidden
 *     ≤980px   zoom −/百分比/+ hidden (⤢ 适应画布 kept)
 *     ≤820px   ▶模拟 / ✔校验 / 📋诊断 hidden
 *     ≤620px   #topbar wraps (flex-wrap, height auto)
 *   Invariants: no horizontal overflow at any width, ⤢ fit always visible,
 *   wider viewports show everything again (fence checks on each boundary).
 *
 * Usage: node scripts/verify/verify-topbar-narrow.mjs [path/to/AppImage]
 * Picks the newest release/**\/*.AppImage when no path is given.
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

const DISPLAY = process.env.VERIFY_DISPLAY || ':78';
const PORT = 9336;

// --- Xvfb -------------------------------------------------------------------
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const app = spawn(appimage, [
  '--appimage-extract-and-run',
  '--no-sandbox',
  '--disable-gpu',
  '--ozone-platform=x11',
  `--remote-debugging-port=${PORT}`
], { stdio: 'ignore', env: { ...process.env, DISPLAY } });

let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function getWsUrl(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP page target never appeared');
}

const wsUrl = await getWsUrl();
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
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

// force a layout viewport width without resizing the Xvfb screen
async function setWidth(w) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(220);
  return evaluate('window.innerWidth');
}

// snapshot at current layout width
const snapshot = () => evaluate(`(() => {
  const t = document.querySelector('#topbar');
  const vis = (s) => getComputedStyle(document.querySelector(s)).display !== 'none';
  return JSON.stringify({
    scrollW: t.scrollWidth,
    clientW: t.clientWidth,
    overflow: Math.max(0, t.scrollWidth - t.clientWidth),
    height: t.offsetHeight,
    wrap: getComputedStyle(t).flexWrap,
    brand: vis('.brand'),
    newBpmn: vis('#btn-new'), newDmn: vis('#btn-new-dmn'),
    zoomIn: vis('#btn-zoom-in'), zoomOut: vis('#btn-zoom-out'),
    zoomLevel: vis('#zoom-level'), zoomFit: vis('#btn-zoom-fit'),
    simulate: vis('#btn-simulate'), lint: vis('#btn-lint'), diag: vis('#btn-diagnostic'),
    open: vis('#btn-open'), xml: vis('#btn-xml')
  });
})()`).then(JSON.parse);

check('app booted (canvas svg present)', await waitFor(`!!document.querySelector('#js-canvas svg')`));

// --- invariant helpers --------------------------------------------------------
async function expect(width, label, want) {
  const w = await setWidth(width);
  const s = await snapshot();
  const ok = Object.entries(want).every(([k, v]) => s[k] === v) && s.overflow === 0;
  check(`@${width}px (${label})`, ok,
    `w=${w} overflow=${s.overflow} h=${s.height} ${s.wrap === 'wrap' ? 'wrap' : ''} ` +
    `brand=${s.brand} new=${s.newBpmn} zoom=${s.zoomIn} mode=${s.simulate} fit=${s.zoomFit}`);
}

// --- T1: wide desktop (no compression) -----------------------------------------
await expect(1280, '全量可见', { brand: true, newBpmn: true, newDmn: true, zoomIn: true,
  zoomLevel: true, simulate: true, lint: true, diag: true, zoomFit: true, overflow: 0 });
// brand fence (≤1240)
await expect(1241, 'brand 仍显示', { brand: true, newBpmn: true, zoomIn: true, simulate: true });
await expect(1239, 'brand 隐藏', { brand: false, newBpmn: true, zoomIn: true, simulate: true });

// --- T2: ≤1160 compact + new-diagram buttons hidden ------------------------------
await expect(1161, '新建按钮仍显示', { brand: false, newBpmn: true, newDmn: true, zoomIn: true, simulate: true });
await expect(1159, '新建按钮隐藏 + 紧凑', { brand: false, newBpmn: false, newDmn: false, zoomIn: true, simulate: true });
await expect(1100, 'T2 区间无溢出', { newBpmn: false, zoomIn: true, simulate: true, zoomFit: true });

// --- T3: ≤980 zoom −/+/100% hidden (fit kept) -------------------------------------
await expect(981, '缩放入口仍显示', { newBpmn: false, zoomIn: true, zoomLevel: true, simulate: true });
await expect(979, '缩放隐藏、适应画布保留', { newBpmn: false, zoomIn: false, zoomLevel: false, zoomFit: true, simulate: true });
await expect(900, 'T3 区间无溢出', { zoomIn: false, simulate: true, zoomFit: true });

// --- T4: ≤820 simulate/lint/diag hidden (theme 🌙 kept) -----------------------------
await expect(821, '模式按钮仍显示', { simulate: true, lint: true, diag: true, zoomIn: false });
await expect(819, '模拟/校验/诊断 隐藏', { simulate: false, lint: false, diag: false, zoomIn: false });
// verify theme button itself survived (no id assumption — check group mode width ~ 🌙 only)
const themeAlive = await evaluate(`(() => {
  const m = document.querySelector('#topbar .group.mode');
  return getComputedStyle(m).display !== 'none' &&
         [...m.querySelectorAll('.tool')].some((b) => getComputedStyle(b).display !== 'none');
})()`);
check('@819px: 主题按钮(🌙) 保留', themeAlive === true);
await expect(700, 'T4 区间无溢出', { simulate: false, zoomIn: false, zoomFit: true });

// --- T5: ≤620 wrap (height adapts, no overflow) ---------------------------------------
await expect(621, '未折行（单行）', { wrap: 'nowrap', height: 46, simulate: false });
await expect(619, '折行生效', { wrap: 'wrap', simulate: false });  // height placeholder, check below
const wrapSnap = await snapshot();
check('@619px: 折行且无溢出', wrapSnap.wrap === 'wrap' && wrapSnap.overflow === 0,
  `h=${wrapSnap.height}`);
await expect(480, '窄屏折行无溢出', { wrap: 'wrap', zoomFit: true });
await expect(360, '超窄屏折行无溢出', { wrap: 'wrap', zoomFit: true, open: true, xml: true });

// No layout-viewport regressions: innerWidth should match the override in all bands already
console.log('\n' + results.join('\n'));
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} (${results.length} total)`);

ws.close();
app.kill('SIGTERM');
xvfb.kill('SIGTERM');
process.exit(failed === 0 ? 0 : 1);